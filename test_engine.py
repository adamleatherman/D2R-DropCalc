#!/usr/bin/env python3
"""Validation for engine.js.

1. Runs tests.js inside headless Edge/Chrome (no Node needed) and collects the engine's numbers.
2. Re-computes the same numbers with an independent Python implementation that reads the *raw*
   game tables (D2R-excel .txt files), not data.json, and compares the two.
3. Checks the engine against figures published by the community (sources listed in README.md).

Usage:  python test_engine.py [path-to-excel-folder]
"""
import json
import math
import os
import re
import shutil
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\thein\D2R-excel"

FAIL = []
ROWS = []


def check(name, got, want, rel=1e-6, note=""):
    ok = abs(got - want) <= rel * max(abs(want), 1e-300) if want != 0 else abs(got) < 1e-12
    ROWS.append(("PASS" if ok else "FAIL", name, got, want, note))
    if not ok:
        FAIL.append(name)


def info(name, got, ref, note=""):
    ROWS.append(("INFO", name, got, ref, note))


# --------------------------------------------------------------- raw table reader
def rd(name):
    with open(os.path.join(SRC, name + ".txt"), encoding="utf-8", errors="replace") as f:
        lines = [l.rstrip("\r\n").split("\t") for l in f]
    head = lines[0]
    return [{h: (l[i] if i < len(l) else "") for i, h in enumerate(head)} for l in lines[1:] if l and l[0]]


def n(v, d=0):
    try:
        return int(v)
    except Exception:
        return d


def rd_sub(name, sub):
    with open(os.path.join(SRC, sub, name + ".txt"), encoding="utf-8", errors="replace") as f:
        lines = [l.rstrip("\r\n").split("\t") for l in f]
    return [{h: (l[i] if i < len(l) else "") for i, h in enumerate(lines[0])} for l in lines[1:] if l and l[0]]

# ------------------------------------------------ independent reference implementation
class Ref:
    def __init__(self):
        self.tc = {r["Treasure Class"]: r for r in rd("treasureclassex")}
        self.items = {}
        for f in ("armor", "weapons", "misc"):
            for r in rd(f):
                if r.get("code"):
                    r["_f"] = f
                    self.items[r["code"]] = r
        self.types = {r["Code"]: r for r in rd("itemtypes") if r.get("Code")}
        self.uniq = rd("uniqueitems")
        self.sets = rd("setitems")
        self.ratio = rd("itemratio")
        self.monstats = {r["Id"]: r for r in rd("monstats")}
        self.levels = {n(r["Id"]): r for r in rd("levels") if r.get("Id")}
        self.cache = {}

    def anc(self, t, seen=None):
        seen = [] if seen is None else seen
        if t in seen or t not in self.types:
            return seen
        seen.append(t)
        for k in ("Equiv1", "Equiv2"):
            if self.types[t].get(k):
                self.anc(self.types[t][k], seen)
        return seen

    def item_anc(self, code):
        r = self.items[code]
        a = list(self.anc(r.get("type", "")))
        if r.get("type2"):
            a += [x for x in self.anc(r["type2"]) if x not in a]
        return a

    def adj_nodrop(self, nd, s, N):
        if nd <= 0 or N <= 1 or s <= 0:
            return nd
        return math.floor(s / (1 / (nd / (nd + s)) ** N - 1))

    def generic(self, name):
        m = re.match(r"^([a-z0-9]+?)(\d+)$", name)
        if not m or m.group(1) not in self.types or n(self.types[m.group(1)].get("TreasureClass")) != 1:
            return None
        pre, br = m.group(1), int(m.group(2))
        out = []
        for code, r in self.items.items():
            if n(r.get("spawnable")) != 1 or pre not in self.item_anc(code):
                continue
            q = n(r.get("level"))
            if max(3, -(-q // 3) * 3) == br:
                out.append((code, q, n(r.get("rarity"), 0)))
        return out or None

    def dist(self, name, mlvl, N, inh=(0, 0, 0, 0)):
        key = (name, mlvl, inh, N)
        if key in self.cache:
            return self.cache[key]
        out = {}
        tc = self.tc.get(name)
        if tc:
            f = tuple(max(a, n(tc.get(c))) for a, c in zip(inh, ("Unique", "Set", "Rare", "Magic")))
            ents = []
            for i in range(1, 11):
                it, pr = tc.get("Item%d" % i, ""), tc.get("Prob%d" % i, "")
                if it:
                    ents.append((it.strip('"').split(",")[0], n(pr)))
            picks = n(tc.get("Picks"), 1) if tc.get("Picks") != "" else 1
            s = sum(p for _, p in ents if p > 0)
            if picks > 0:
                tot = s + self.adj_nodrop(n(tc.get("NoDrop")), s, N)
                acc = {}
                for nm, p in ents:
                    if p <= 0:
                        continue
                    for k, v in self.dist(nm, mlvl, N, f).items():
                        acc[k] = acc.get(k, 0) + p / tot * v
                out = {k: 1 - (1 - v) ** picks for k, v in acc.items()}
            else:
                rem = -picks
                miss = {}
                for nm, p in ents:
                    q = min(p, rem)
                    if q <= 0:
                        continue
                    rem -= q
                    for k, v in self.dist(nm, mlvl, N, f).items():
                        miss[k] = miss.get(k, 1) * (1 - v) ** q
                out = {k: 1 - m for k, m in miss.items()}
        elif name in self.items:
            out = {("i", name, inh): 1.0}
        else:
            g = self.generic(name)
            if g:
                W = sum(w for _, q, w in g if q <= mlvl)
                for code, q, w in g:
                    if q <= mlvl and W:
                        out[("i", code, inh)] = w / W
        self.cache[key] = out
        return out

    def ratio_row(self, code):
        r = self.items[code]
        uber = 1 if (r["_f"] != "misc" and (r.get("ubercode") == code or r.get("ultracode") == code)) else 0
        cls = 1 if "clas" in self.item_anc(code) else 0
        return [x for x in self.ratio if n(x["Version"]) == 1 and n(x["Uber"]) == uber and n(x["Class Specific"]) == cls][0]

    def succ(self, base, div, mn, qlvl, mlvl, mf, dim, tcf):
        p = base * 128 - ((mlvl - qlvl) * 128) // div
        if mf is not None:
            eff = (mf * dim) // (mf + dim) if (dim and mf > 110) else mf
            p = (p * 100) // (100 + eff)
        if mn is not None and p < mn:
            p = mn
        p = p - (p * tcf) // 1024
        return 1.0 if p <= 128 else 128.0 / p

    def sunder_ids(self):
        sc = self.tc["Sunder Charms"]
        return [sc["Item%d" % i] for i in range(1, 11) if sc.get("Item%d" % i)]

    def quality(self, code, mlvl, mf, f, hell=True, penalty=1.0):
        """returns dict unique,set,rare,magic and per-unique/set probabilities"""
        it = self.items[code]
        tt0 = self.types.get(it.get("type", ""), {})
        anc0 = self.item_anc(code)
        if n(tt0.get("Normal")) == 1 or (any(n(self.types[a].get("Normal")) == 1 for a in anc0 if a in self.types) and not (n(tt0.get("Magic")) or n(tt0.get("Rare")))):
            return {"unique": 0, "set": 0, "rare": 0, "magic": 0, "u": {}, "s": {}}
        row = self.ratio_row(code)
        q = n(it.get("level"))
        eu = [u for u in self.uniq if u["code"] == code and n(u.get("spawnable")) == 1 and n(u.get("disabled")) == 0 and n(u["lvl"]) <= min(mlvl, 99) and not u.get("DropConditionCalc")]
        es = [s for s in self.sets if s["item"] == code and n(s.get("spawnable")) == 1 and n(s.get("disabled")) == 0 and n(s["lvl"]) <= min(mlvl, 99) and not s.get("DropConditionCalc")]
        if code == "cm3" and hell and mlvl >= 75 and n(it.get("spawnable")) == 1:
            # 3.2/3.3 hard-coded rule: the six Sunder uniques (spawnable=0 in the table) join the unique grand charm pool
            for sid in self.sunder_ids():
                u = [x for x in self.uniq if x["index"] == sid][0]
                if n(u["lvl"]) <= min(mlvl, 99):
                    u = dict(u); u["rarity"] = str(n(u["rarity"], 1) * penalty); eu.append(u)
        tt = self.types.get(it.get("type", ""), {})
        anc = self.item_anc(code)
        can_rare = n(tt.get("Rare")) == 1
        always_magic = n(tt.get("Magic")) == 1
        pu = self.succ(n(row["Unique"]), n(row["UniqueDivisor"]), n(row["UniqueMin"]), q, mlvl, mf, 250, f[0])
        ps = self.succ(n(row["Set"]), n(row["SetDivisor"]), n(row["SetMin"]), q, mlvl, mf, 500, f[1])
        pr = self.succ(n(row["Rare"]), n(row["RareDivisor"]), n(row["RareMin"]), q, mlvl, mf, 600, f[2]) if can_rare else 0
        pm = self.succ(n(row["Magic"]), n(row["MagicDivisor"]), n(row["MagicMin"]), q, mlvl, mf, None, f[3])
        rem = 1.0
        U = rem * pu; rem -= U
        S = rem * ps; rem -= S
        R = rem * pr; rem -= R
        M = rem if always_magic else rem * pm
        rare, magic, unique, setp = R, M, U, S
        if U and not eu:
            unique = 0; (rare := rare + U) if can_rare else (magic := magic + U)
        if S and not es:
            setp = 0; magic += S
        res = {"unique": unique, "set": setp, "rare": rare, "magic": magic, "u": {}, "s": {}}
        if eu:
            W = sum(float(u["rarity"] or 1) for u in eu)
            for u in eu:
                res["u"][u["index"]] = unique * float(u["rarity"] or 1) / W
        if es:
            W = sum(n(s["rarity"], 1) for s in es)
            for s in es:
                res["s"][s["index"]] = setp * n(s["rarity"], 1) / W
        return res

    def totals(self, tcname, mlvl, N, mf):
        t = {"unique": 0.0, "set": 0.0, "rare": 0.0, "magic": 0.0}
        for (kind, code, f), p in self.dist(tcname, mlvl, N).items():
            if kind != "i" or code == "gld":
                continue
            q = self.quality(code, mlvl, mf, f)
            for k in t:
                t[k] += p * q[k]
        return t

    def target(self, tcname, mlvl, N, mf, kind, ident):
        total = 0.0
        for (k, code, f), p in self.dist(tcname, mlvl, N).items():
            if kind == "base":
                if code == ident:
                    total += p
            else:
                q = self.quality(code, mlvl, mf, f)
                total += p * (q["u"] if kind == "unique" else q["s"]).get(ident, 0)
        return total


# ------------------------------------------------------------ Monte Carlo of the raw TC tree (drop cap check)
import random


class MC:
    """Independent simulation of the game's drop routine (depth-first, picks in sequence, 6-item cap) on the raw tables."""

    def __init__(self, ref):
        self.ref = ref
        self.uset = {u["index"] for u in ref.uniq}
        self.sset = {x["index"] for x in ref.sets}
        self.comp = {}
        self.gen = {}

    def tcinfo(self, name, N):
        key = (name, N)
        if key in self.comp:
            return self.comp[key]
        tc = self.ref.tc[name]
        ents = []
        for i in range(1, 11):
            it, pr = tc.get("Item%d" % i, ""), tc.get("Prob%d" % i, "")
            if it:
                ents.append((it.strip('"').split(",")[0], n(pr)))
        picks = n(tc.get("Picks"), 1) if tc.get("Picks") != "" else 1
        f = tuple(n(tc.get(c)) for c in ("Unique", "Set", "Rare", "Magic"))
        s = sum(p for _, p in ents if p > 0)
        cum, tot = [], 0
        if picks > 0:
            tot = s + self.ref.adj_nodrop(n(tc.get("NoDrop")), s, N)
            acc = 0
            for nm, p in ents:
                if p > 0:
                    acc += p
                    cum.append((acc, nm))
        r = (picks, f, ents, cum, tot)
        self.comp[key] = r
        return r

    def run(self, top, mlvl, N, kills, seed, cap, branch=None):
        """returns ({leaf: P(at least once per kill)}, mean number of items dropped under TCs whose name contains `branch`)"""
        rnd = random.Random(seed)
        ref = self.ref
        counts = {}
        branch_items = [0]
        gen_cache = self.gen

        def drop(name, inh, st, inbranch):
            if cap and st[0] >= cap:
                return
            if name in ref.tc:
                picks, f, ents, cum, tot = self.tcinfo(name, N)
                f = tuple(max(a, b) for a, b in zip(inh, f))
                ib = inbranch or (branch is not None and branch in name)
                if picks > 0:
                    for _ in range(picks):
                        if cap and st[0] >= cap:
                            return
                        if tot <= 0:
                            return
                        r = rnd.random() * tot
                        for c, nm in cum:
                            if r < c:
                                drop(nm, f, st, ib)
                                break
                else:
                    rem = -picks
                    for nm, p in ents:
                        q = min(p, rem)
                        if q <= 0:
                            continue
                        rem -= q
                        for _ in range(q):
                            if cap and st[0] >= cap:
                                return
                            drop(nm, f, st, ib)
                return
            key = None
            if name in ref.items:
                key = ("i", name, inh)
            elif name in self.uset:
                key = ("u", name, inh)
            elif name in self.sset:
                key = ("s", name, inh)
            else:
                g = gen_cache.get((name, mlvl))
                if g is None:
                    lst = ref.generic(name)
                    g = [(c, w) for c, q, w in lst if q <= mlvl] if lst else []
                    gen_cache[(name, mlvl)] = g
                W = sum(w for _, w in g)
                if W > 0:
                    r = rnd.random() * W
                    for c, w in g:
                        r -= w
                        if r < 0:
                            key = ("i", c, inh)
                            break
                    else:
                        key = ("i", g[-1][0], inh)
            if key is None:
                return
            st[0] += 1
            st[1].add(key)
            if inbranch:
                branch_items[0] += 1

        for _ in range(kills):
            st = [0, set()]
            drop(top, (0, 0, 0, 0), st, False)
            for k in st[1]:
                counts[k] = counts.get(k, 0) + 1
        return {k: v / kills for k, v in counts.items()}, branch_items[0] / kills

    def branch_mean(self, top, mlvl, N, kills, seed, cap, branch):
        return self.run(top, mlvl, N, kills, seed, cap, branch)[1]


# ------------------------------------------------------------------- browser run
def find_browser():
    for p in (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"):
        if os.path.exists(p):
            return p
    return shutil.which("msedge") or shutil.which("chrome") or shutil.which("google-chrome")


def run_engine():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"], cwd=HERE,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.5)
        b = find_browser()
        if not b:
            raise SystemExit("no Edge/Chrome found for the headless run")
        out = subprocess.run([b, "--headless=new", "--disable-gpu", "--virtual-time-budget=60000", "--dump-dom",
                              "http://127.0.0.1:%d/test.html" % port], capture_output=True, text=True, timeout=180).stdout
        m = re.search(r'<pre id="out">(.*?)</pre>', out, re.S)
        if not m:
            raise SystemExit("no output from test page")
        import html
        return json.loads(html.unescape(m.group(1)))
    finally:
        srv.terminate()


def main():
    js = run_engine()
    if js["errors"]:
        print("JS ERRORS:", js["errors"]); sys.exit(1)
    ref = Ref()
    C = js["cases"]

    # ---- raw-table derived monster levels
    info("Hell Andariel mlvl", C["Andariel|H|mf0|p1"]["mlvl"], n(ref.monstats["andariel"]["Level(H)"]), "monstats Level(H)")
    check("Hell Andariel mlvl", C["Andariel|H|mf0|p1"]["mlvl"], n(ref.monstats["andariel"]["Level(H)"]))
    check("Hell Mephisto mlvl", C["Mephisto|H|mf0|p1"]["mlvl"], n(ref.monstats["mephisto"]["Level(H)"]))
    check("Hell Countess mlvl (Tower Cellar 5 MonLvlEx(H))", C["The Countess|H|mf0|p1"]["mlvl"], n(ref.levels[25]["MonLvlEx(H)"]))

    # ---- independent TC traversal vs engine
    boss = {"Andariel": "andariel", "Mephisto": "mephisto", "The Countess": None, "Duriel": "duriel", "Baal": "baalcrab"}
    for key, c in C.items():
        if key.startswith("spec|"):
            continue
        name, _, mfs, ps = key.split("|")
        mf = int(mfs[2:]); pl = int(ps[1:])
        N = c["N"]
        t = ref.totals(c["tc"], c["mlvl"], N, mf)
        for q in ("unique", "set", "rare", "magic"):
            check("%s Hell p%d MF%d: expected %s items/kill" % (name, pl, mf, q), c["totals"][q], t[q], 1e-9)

    # ---- specific item chances
    for key, c in C.items():
        if not key.startswith("spec|"):
            continue
        _, name, ident, mfs = key.split("|")
        mf = int(mfs[2:])
        kind = "base" if re.match(r"^r\d\d$", ident) else ("set" if ident.startswith("Tal Rasha's Horadric") else "unique")
        want = ref.target(c["tc"], c["mlvl"], 1, mf, kind, ident)
        check("%s Hell MF%d: P(%s) per kill" % (name, mf, ident), c["c"]["target"], want, 1e-9,
              "1 in %.0f" % (1 / want) if want else "")

    # ---- per-kill 6-item cap: engine vs independent Monte Carlo of the raw TC tree ---------------------
    CP = js["cap"]
    mc = MC(ref)
    KILLS = 60000
    for tcn in ("Duriel (H)", "Duriel (H) Desecrated D", "Mephisto (H) Desecrated D", "Countess (H)", "Andarielq (H)", "Andarielq (H) Desecrated H"):
        for pl in (1, 8):
            eng = CP["dist"]["6|%s|%d" % (tcn, pl)]
            sim, _ = mc.run(tcn, 85, eng["N"], KILLS, 1234 + pl, 6)
            worst, nchk, bad = 0.0, 0, 0
            for kind, ident, f, p in eng["leaves"]:
                q = sim.get((kind, ident, tuple(f)), 0.0)
                if max(p, q) < 0.01:
                    continue
                sd = math.sqrt(max(p, 1e-4) * (1 - p) / KILLS)
                z = abs(p - q) / sd
                worst = max(worst, z)
                nchk += 1
                bad += z > 5
            ekeys = {(k, i, tuple(f)) for k, i, f, p in eng["leaves"]}
            miss = sum(1 for k, v in sim.items() if v >= 0.01 and k not in ekeys)
            ROWS.append(("PASS" if bad == 0 and miss == 0 else "FAIL",
                         "cap=6 vs Monte Carlo (%dk kills): %s, players %d (N=%d): %d leaves with P>=1%%, max |z|" % (KILLS // 1000, tcn, pl, eng["N"], nchk),
                         worst, "<5", "leaves missing from engine: %d" % miss))
            if bad or miss:
                FAIL.append("cap MC " + tcn)
    # expected Equip-branch items per kill (reference simulation from the task: 6.41 -> 2.02, Mephisto 4.50 -> 4.31, Andariel 3.16 -> 3.15)
    for tcn, br, unc, cap_ in (("Duriel (H) Desecrated D", "Equip", 6.41, 2.02), ("Mephisto (H) Desecrated D", "Equip", 4.50, 4.31), ("Andarielq (H) Desecrated H", "Equip", 3.16, 3.15)):
        a = mc.branch_mean(tcn, 85, 1, 30000, 7, None, br)
        b = mc.branch_mean(tcn, 85, 1, 30000, 8, 6, br)
        ok = abs(a - unc) < 0.1 and abs(b - cap_) < 0.08
        ROWS.append(("PASS" if ok else "FAIL", "MC expected '%s' items/kill, %s: uncapped / capped" % (br, tcn), "%.2f / %.2f" % (a, b), "%.2f / %.2f" % (unc, cap_), "reference simulation from the task"))
        if not ok:
            FAIL.append("equip mean " + tcn)
    # cap = null / 0 reproduces the old numbers; Cow King (never reaches 6 items) is unchanged with the cap on
    kn = CP["knell"]
    check("Knell Striker from normal Cow King, 620 MF, cap off: ~1 in 449 (mlvl 28)", 1 / kn["0"]["target"], 449, 0.004, "1 in %.1f" % (1 / kn["0"]["target"]))
    check("Knell Striker (cap off) P(base scepter) = 5.10%", kn["0"]["base"], 0.0510, 0.005)
    check("Knell Striker from Cow King identical with cap 6", kn["6"]["target"], kn["0"]["target"], 1e-12)
    check("Cow King P(base) identical with cap 6", kn["6"]["base"], kn["0"]["base"], 1e-12)
    for q in ("unique", "set", "rare", "magic", "items"):
        check("Hell Duriel expected %s/kill: dropCap=0 == null" % q, CP["off"]["0"]["totals"][q], CP["off"]["null"]["totals"][q], 1e-12)
        lower = CP["off"]["6"]["totals"][q] < CP["off"]["null"]["totals"][q]
        ROWS.append(("PASS" if lower else "FAIL", "Hell Duriel expected %s/kill: cap 6 < uncapped" % q, CP["off"]["6"]["totals"][q], CP["off"]["null"]["totals"][q], ""))
        if not lower:
            FAIL.append("duriel capped lower " + q)
    ratio = CP["off"]["null"]["totals"]["items"] / CP["off"]["6"]["totals"]["items"]
    ROWS.append(("PASS" if 1.5 < ratio < 4 else "FAIL", "Hell Duriel items/kill uncapped / capped (task: ~3x overstated)", ratio, "1.5-4", ""))
    if not 1.5 < ratio < 4:
        FAIL.append("duriel ratio")
    # ---- duplicate rows / duplicate monster entries ------------------------------------------------
    check("no duplicate (monster, rank, area, difficulty) rows in sources()", len(CP["dups"]["dup"]), 0, 0, ",".join(CP["dups"]["dup"][:3]))
    check("no duplicate (name, area, difficulty) among super/boss rows", len(CP["dups"]["dupName"]), 0, 0, ",".join(CP["dups"]["dupName"][:3]))
    for nm, ranks in zip(("Nihlathak", "Radament", "The Summoner", "Griswold"), CP["dups"]["bossNames"]):
        check("%s appears exactly once in Hell sources" % nm, len(ranks), 1, 0, "rank " + ",".join(ranks))
    T = CP["tal"]
    unr = [r for r in T["shares"] if r["mon"] == "unraveler3"]
    check("Tal Rasha's Tomb (Hell): Unraveler listed twice -> share 2/7", unr[0]["share"], 2 / 7, 1e-12)
    check("Tal Rasha's Tomb (Hell): shares of all distinct monsters sum to 1", sum(r["share"] for r in T["shares"]), 1.0, 1e-12)
    check("Tal Rasha's Tomb (Hell): Apparition regular kills/run ~151", T["apparition"][0]["perRun"], 151, 0.01, "%.1f" % T["apparition"][0]["perRun"])
    ROWS.append(("INFO", "all Hell sources srcDist, cold context (ms): cap off / cap on", "%d / %d" % (CP["perf"]["0"]["ms"], CP["perf"]["6"]["ms"]), "-", "%d sources" % CP["perf"]["6"]["n"]))
    # ---- published figures
    f = js["formula"]
    check("effective MF for 200%% MF, unique (PureDiablo example: 111)", f["effMF200"], 111)
    check("effective MF for 300%% MF, unique (west-games/forums: ~136 as float, floor 136)", f["effMF300"], 136)
    info("Hell Baal unique p for qlvl-85 base @200%% MF (PureDiablo example: 939)", f["baal_unique_p"], 939,
         "integer arithmetic gives %d; the page does not say which base/rounding it used (<0.2%% apart)" % f["baal_unique_p"])
    ROWS.append(("PASS" if abs(f["baal_unique_p"] - 939) <= 2 else "FAIL", "Baal 200% MF example within +-2", f["baal_unique_p"], 939, ""))
    if abs(f["baal_unique_p"] - 939) > 2:
        FAIL.append("baal example")
    # PureDiablo "Players X" worked example: NoDrop 60, ProbSum 40: N=1 ->60, N=2 -> 22, N=3 -> 11, N=4 -> 5
    for got, want, nn in zip(f["adjNoDrop_60_40"], (60, 22, 11, 5), (1, 2, 3, 4)):
        check("Players X example, N=%d: NewNoDrop" % nn, got, want)
    for p, q, N in f["playersN"]:
        want = int(1 + (p - 1) / 2 + (q - 1) / 2)       # PureDiablo form
        check("N for %d players, %d partied nearby (both published forms agree)" % (p, q), N, want)

    # Countess: published structure "5 item rolls each 19/67 nothing; 3 rune rolls each 1/4 nothing; 1/64 no rune at all"
    t = ref.tc
    ci = t["Countess Item (H)"]
    psum = sum(n(ci["Prob%d" % i]) for i in range(1, 11))
    info("Countess (H) item roll NoDrop share", "%d/%d" % (n(ci["NoDrop"]), n(ci["NoDrop"]) + psum), "19/67 (1.10-era wiki)",
         "D2R 3.3 added a 'pk1' entry (Prob 1) so the sum is 49 not 48; Picks=%s" % ci["Picks"])
    check("Countess (H) item roll Picks = 5 and NoDrop = 19 (published)", n(ci["Picks"]) * 100 + n(ci["NoDrop"]), 519)
    check("Countess (H) rune roll NoDrop share = 1/4", n(t["Countess Rune (H)"]["NoDrop"]) / (n(t["Countess Rune (H)"]["NoDrop"]) + n(t["Countess Rune (H)"]["Prob1"])), 0.25, 1e-12)
    check("Countess (H) P(no rune) = 1/64 (published)", 0.25 ** n(t["Countess Rune (H)"]["Picks"]), 1 / 64, 1e-12)
    # Ist
    ist = C["spec|The Countess|r24|mf0"]["c"]["target"]
    rune_only = 1 - (1 - 0.75 * 2 / 1071) ** 3
    info("Hell Countess Ist (r24) per kill, 1 player", "1 in %.0f" % (1 / ist), "1 in 287 (old forum figure)",
         "rune table alone gives 1 in %.0f; the item table's 'Act 2 (H) Good' -> Runes 14 -> ... -> Runes 12 chain adds the rest. 287 is a 1.10-era number." % (1 / rune_only))
    check("Hell Countess Ist is within 2%% of the rune-table-only hand value", ist / rune_only, 1.0, 0.02)
    # ---- game modes (LoD = excel\base, RotW = root) ------------------------------------------------
    M = js["modes"]
    base_armor = {r["code"]: r for r in rd_sub("armor", "base") if r.get("code")}
    grims = [c for c, r in ref.items.items() if r.get("type") == "grim"]
    check("RotW root armor.txt: all 15 grimoires spawnable", sum(n(ref.items[c]["spawnable"]) for c in grims), 15)
    check("LoD base\\armor.txt: no grimoire spawnable", sum(n(base_armor[c]["spawnable"]) for c in grims), 0)
    check("LoD: grimoire drop probability over all Hell sources", M["lod"]["grimMass"], 0, 1e-12)
    check("LoD: grimoires missing from search index", M["lod"]["indexGrim"], 0)
    check("LoD: grimoire automagic not attached", M["lod"]["autoGrim"], 0)
    ROWS.append(("PASS" if M["rotw"]["grimMass"] > 0 else "FAIL", "RotW: grimoires do drop (mass over Hell sources)", M["rotw"]["grimMass"], ">0", ""))
    if not M["rotw"]["grimMass"] > 0: FAIL.append("rotw grimoire")
    ratio_mode = M["lod"]["midBaseMeph"] / M["rotw"]["midBaseMeph"]
    ROWS.append(("PASS" if 1.0 < ratio_mode < 1.2 else "FAIL", "mid-level armor base %s at Hell Mephisto: LoD/RotW per-kill odds" % M["midBase"], ratio_mode, "slightly >1", ""))
    if not 1.0 < ratio_mode < 1.2: FAIL.append("mode dilution")
    # independent dilution check for that base: weights over the bracket
    mb = ref.items[M["midBase"]]
    br = max(3, -(-n(mb["level"]) // 3) * 3)
    def wsum(include_grim):
        w = 0
        for code, r in ref.items.items():
            if n(r.get("spawnable")) != 1 and code not in grims: continue
            if code in grims and not include_grim: continue
            if "armo" in ref.item_anc(code) and max(3, -(-n(r.get("level")) // 3) * 3) == br and n(r.get("level")) <= 87:
                w += n(r.get("rarity"), 0)
        return w
    check("armor pool dilution matches independent bracket weights (LoD/RotW)", ratio_mode, wsum(True) / wsum(False), 1e-3,
          "bracket %d, rarity sum RotW %d vs LoD %d (only exact if this bracket is reached through armoN entries only)" % (br, wsum(True), wsum(False)))

    # ---- heralds ----------------------------------------------------------------------------------
    Hh = js["herald"]
    dz = json.load(open(os.path.join(SRC, "hd", "desecratedzones.json"), encoding="utf-8"))["desecrated_zones"][0]
    tiers = dz["game_difficulties"]["rotw"]["hell"]["defaults"]["herald_tiers"]
    boosts = [t.get("herald_treasure_class_level_boost", 0) for t in tiers]
    check("herald tier boosts from desecratedzones.json (0,3,6,9,12)", sum(b * 10 ** i for i, b in enumerate(boosts)), sum(b * 10 ** i for i, b in enumerate([0, 3, 6, 9, 12])))
    g37 = sorted([(n(r["level"]), name) for name, r in ref.tc.items() if n(r.get("group")) == 37])
    def grp_pick(l):
        best = None
        for lv, nm in g37:
            if lv <= l: best = nm
        return best
    zomb_tc = ref.monstats["zombie1"]["TreasureClassDesecratedUnique(H)"]
    bm = n(ref.levels[2]["MonLvlEx(H)"])
    for clvl in (60, 94):
        base_ml = max(bm, min(96, max(70, clvl + 2))) + 3
        for tier, b in ((1, boosts[0]), (5, boosts[4])):
            h = Hh["tiers"]["c%dt%d" % (clvl, tier)]
            check("herald mlvl, clvl %d" % clvl, h["mlvl"], base_ml)
            ROWS.append(("PASS" if h["resolved"] == grp_pick(base_ml + b) else "FAIL", "herald tier %d clvl %d resolved TC (mlvl %d + boost %d)" % (tier, clvl, base_ml, b), h["resolved"], grp_pick(base_ml + b), "base TC " + zomb_tc))
            if h["resolved"] != grp_pick(base_ml + b): FAIL.append("herald tc")
    info("tier boost effect", "%s -> %s" % (Hh["tiers"]["c60t1"]["resolved"], Hh["tiers"]["c60t5"]["resolved"]), "differs at low clvl",
         "at clvl 94 both tiers resolve to %s (mlvl already above the group top, level 85)" % Hh["tiers"]["c94t1"]["resolved"])
    check("heralds absent in LoD", Hh["inLod"], 0)
    check("heralds absent without terror zone", Hh["noTz"], 0)
    ROWS.append(("PASS" if Hh["count"] > 0 else "FAIL", "heralds present in RotW + Hell + TZ", Hh["count"], ">0", ""))
    sc = ref.tc["Sunder Charms"]
    ssum = sum(n(sc["Prob%d" % i]) for i in range(1, 11))
    for key, v in Hh["sunder"].items():
        pl, pa = key.split("/")
        nd = ref.adj_nodrop(n(sc["NoDrop"]), ssum, v["N"])
        check("Sunder chance per herald kill, players %s / party %s (N=%d)" % (pl, pa, v["N"]), v["p"], ssum / (ssum + nd), 1e-9, "1 in %.0f" % (1 / v["p"]))
    p1 = Hh["sunder"]["1/1"]["p"]
    info("tier-1, 1-player Sunder chance per herald kill (tables)", "%.4f%% (1 in %.0f)" % (p1 * 100, 1 / p1), "0.3677% (1 in 272), diablo2.io datamine",
         "tables give %.1f%% more; the community number may predate 3.3 (Latent Sunder min drop level 69 -> 75). Not forced to agree." % ((p1 / 0.003677 - 1) * 100))
    # ---- Sunder paths (3.2 / 3.3 official patch notes) ---------------------------------------------
    SP = js["sunderPaths"]
    u = SP["unknown"]
    ROWS.append(("PASS" if u["bonus"] is None and u["total"] is None else "FAIL", "herald bonus base unknown -> bonus and total are null (UI: 'unknown base')", str(u["bonus"]), "null", ""))
    if not (u["bonus"] is None and u["total"] is None): FAIL.append("bonus null")
    check("path (a) table path == previous any-Sunder chance (unchanged)", u["table"], u["chance"], 1e-12)
    check("path (a) table path value unchanged from 3.3-table result (tier 1, 1 player)", u["table"], 0.00420833, 1e-4)
    for tier, mult in zip((1, 2, 3, 4, 5), (1, 1, 2, 2, 3)):
        check("herald bonus path tier %d = base x %d (base 1%%)" % (tier, mult), SP["bonus"][str(tier)], 0.01 * mult, 1e-12)
    check("bonus path has no player-count scaling (1 vs 8 players)", SP["table"]["8"]["bonus"], SP["table"]["1"]["bonus"], 1e-12)
    ROWS.append(("PASS" if SP["table"]["8"]["table"] > 1.5 * SP["table"]["1"]["table"] else "FAIL", "table path does scale with players (8 vs 1)", SP["table"]["8"]["table"] / SP["table"]["1"]["table"], ">1.5", ""))
    if not SP["table"]["8"]["table"] > 1.5 * SP["table"]["1"]["table"]: FAIL.append("table scale")
    cs = SP["coldShare"]
    check("Cold Rupture share of Sunder pool = 30/101", cs["table"] / cs["any"], 30 / 101, 1e-9)
    check("Cold Rupture bonus share = 30/101 of tier-1 bonus", cs["bonus"], 0.01 * 30 / 101, 1e-9)
    mf = SP["mf"]
    check("MF path: 0 sunders for mlvl 74 (Hell)", mf["m74h"]["n"], 0)
    check("MF path: 6 sunders at mlvl 75 (Hell)", mf["m75h"]["n"], 6)
    check("MF path: 0 outside Hell (Nightmare, mlvl 87)", mf["m87n"]["n"], 0)
    check("MF path: 0 outside Hell (Normal, mlvl 87)", mf["m87nm0"]["n"], 0)
    check("MF path: engine == independent Ref at mlvl 87", sum(mf["m87h"]["byId"].values()), sum(ref.quality("cm3", 87, 0, (983, 983, 983, 1024))["u"].get(i, 0) for i in ref.sunder_ids()), 1e-9)
    ROWS.append(("INFO", "MF path unique-pool at mlvl 87", "%.4f of unique grand charms are Sunders" % (mf["m87h"]["p"] / (mf["m87h"]["p"] + sum(ref.quality("cm3", 87, 0, (983, 983, 983, 1024))["u"].get(i, 0) for i in [x for x in mf["nonSunderUniques87"]]))), "-", "other cm3 uniques: %s; penalty 1 (3.3 reduction size unknown)" % ", ".join(mf["nonSunderUniques87"])))
    sr = SP["src"]
    check("source-level MF path 0 for Hell mlvl %d < 75" % sr["lowMlvl"], sr["low"], 0)
    ROWS.append(("PASS" if sr["hi"] > 0 else "FAIL", "source-level MF path > 0 for Hell Mephisto (mlvl %d), Cold Rupture" % sr["hiMlvl"], sr["hi"], ">0", "1 in %.0f; table path %s (only terrorized TCs contain it)" % (1 / sr["hi"], "1 in %.0f" % (1 / sr["hiTable"]) if sr["hiTable"] else "0") ))
    if not sr["hi"] > 0: FAIL.append("mf src")
    check("source-level MF path 0 in Nightmare (mlvl>=75 sources: %d)" % sr["nmHigh"], sr["nmMf"], 0)
    ad = SP["adj"]
    check("herald quality adj default is a no-op (tier 1 unique mass)", ad["default1"][1], ad["default1"][0], 1e-12)
    check("herald quality adj default is a no-op (tier 3 unique mass)", ad["default3"][1], ad["default3"][0], 1e-12)
    check("herald quality adj t12 unique x0.5 halves tier 1", ad["half1"], ad["default1"][0] * 0.5, 1e-9)
    check("herald quality adj t3plus rare+ x2 doubles tier 3 unique", ad["dbl3"], ad["default3"][0] * 2, 1e-9)
    check("herald adj never touches non-herald rows", ad["nonHerald"][1], ad["nonHerald"][0], 1e-12)
    tr = js["trials"]
    for q, want in zip((25, 50, 75, 99), (1, 1, 2, 7)):
        check("trialsFor p=0.5, q=%d%% -> %d" % (q, want), tr["half"][(25, 50, 75, 99).index(q)], want, 0)
    check("trialsFor p=1/449, 50% -> 311", tr["p449"], 311, 0)
    check("trialsFor p=1/449, 99% = ceil(ln .01 / ln(1-p))", tr["p449_99"], math.ceil(math.log(0.01) / math.log1p(-1 / 449)), 0)
    check("trialsFor p=0 -> no value", 0 if tr["zero"] is None else 1, 0, 0)
    check("trialsFor p<0 -> no value", 0 if tr["neg"] is None else 1, 0, 0)
    check("trialsFor p=1 -> 1", tr["one"], 1, 0)
    check("trialsFor tiny p=1e-12, 50% ~ ln2/p", tr["tiny"], math.ceil(math.log(2) * 1e12), 1e-9)
    # ---- print
    w = max(len(r[1]) for r in ROWS)
    for st, name, got, want, note in ROWS:
        g = "%.6g" % got if isinstance(got, (int, float)) else str(got)
        wv = "%.6g" % want if isinstance(want, (int, float)) else str(want)
        print("%-4s %-*s  engine=%-14s reference=%-14s %s" % (st, w, name, g, wv, note))
    print("\n%d checks, %d failures" % (sum(1 for r in ROWS if r[0] in ("PASS", "FAIL")), len(FAIL)))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
