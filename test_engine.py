#!/usr/bin/env python3
"""Validation for engine.js.

1. Runs tests.js inside headless Edge/Chrome (no Node needed) and collects the engine's numbers.
2. Re-computes the same numbers with an independent Python implementation that reads the *raw*
   game tables (excel/ .txt files), not data.json, and compares the two.
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
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "excel")

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


def idiv(a, b):
    """C integer division (truncates toward zero)"""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


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
        self.uidx = {u["index"] for u in self.uniq}
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

    def affixes(self, code, alvl=99):
        """Eligible magic prefixes/suffixes ('name|class') for a base at an affix level, straight from the raw tables.
        Rule: type (or a parent) in itype, none in etype; a class tagged affix (classspecific) may appear on any matching base
        except a class-specific base (type chain with a Class in itemtypes), which only takes its own class."""
        anc = self.item_anc(code)
        cls = [self.types[t]["Class"] for t in anc if self.types[t].get("Class")]
        out = {}
        for key, fname in (("p", "magicprefix"), ("s", "magicsuffix")):
            res = []
            for a in rd(fname):
                if not a.get("Name") or n(a.get("version")) < 1 or n(a.get("frequency")) <= 0 or not n(a.get("spawnable")):
                    continue
                if n(a["level"]) > alvl or (a.get("maxlevel") and n(a["maxlevel"]) < alvl):
                    continue
                its = [a["itype%d" % i] for i in range(1, 8) if a.get("itype%d" % i)]
                ets = [a["etype%d" % i] for i in range(1, 6) if a.get("etype%d" % i)]
                if not any(t in anc for t in its) or any(t in anc for t in ets):
                    continue
                if a.get("classspecific") and cls and a["classspecific"] not in cls:
                    continue
                res.append(a["Name"] + "|" + a.get("classspecific", ""))
            out[key] = sorted(res)
        return out

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
                out.append((code, q, max(1, n(self.types[r["type"]].get("Rarity")))))   # D2MOO: ItemTypes Rarity of wType[0], floor 1
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
        elif name in self.uidx:
            out = {("u", name, (0, 0, 0, 0)): 1.0}   # explicit unique: TC quality factors irrelevant, one leaf per id
        else:
            g = self.generic(name)
            if g:
                W = sum(w for _, q, w in g)
                for code, q, w in g:
                    if W:
                        out[("i", code, inh)] = w / W
        self.cache[key] = out
        return out

    def ratio_row(self, code):
        r = self.items[code]
        uber = 1 if (r["_f"] != "misc" and (r.get("ubercode") == code or r.get("ultracode") == code)) else 0
        cls = 1 if "clas" in self.item_anc(code) else 0
        return [x for x in self.ratio if n(x["Version"]) == 1 and n(x["Uber"]) == uber and n(x["Class Specific"]) == cls][0]

    def succ(self, base, div, mn, qlvl, mlvl, mf, dim, tcf):
        # game integer math (C division truncates); independent form: D = MF+100, div per D2MOO D2GAME_DropTC_6FC51360
        p = base - idiv(mlvl - qlvl, div)
        if mf is not None:
            D = mf + 100
            if dim and D > 110:
                if dim == 250: d = idiv(50 * (5 * D - 500), D + 150) + 100
                elif dim == 500: d = idiv(100 * (5 * D - 500), D + 400) + 100
                else: d = idiv(200 * (3 * D - 300), D + 500) + 100
            else: d = D
            p = idiv(12800 * p, d)
        else:
            p = p * 128
        if mn is not None and p < mn:
            p = mn
        p = p - idiv(p * tcf, 1024)
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
        # quest-type misc items (type 'ques': keys, essences, organs, statue pieces, shards): no Rare/Magic/Normal flag anywhere in the type chain -> no quality
        if it["_f"] == "misc" and not any(n(self.types[a].get("Rare")) or n(self.types[a].get("Magic")) or n(self.types[a].get("Normal")) for a in anc0 if a in self.types):
            return {"unique": 0, "set": 0, "rare": 0, "magic": 0, "u": {}, "s": {}}
        row = self.ratio_row(code)
        q = n(it.get("level"))
        eu =[u for u in self.uniq if u["code"] == code and n(u.get("spawnable")) == 1 and n(u.get("disabled")) == 0 and n(u["lvl"]) <= min(mlvl, 99) and (not u.get("DropConditionCalc") or (hell and u["DropConditionCalc"].strip('"') == "cond('Difficulty', hell)"))]
        es = [s for s in self.sets if s["item"] == code and n(s.get("spawnable")) == 1 and n(s.get("disabled")) == 0 and n(s["lvl"]) <= min(mlvl, 99) and not s.get("DropConditionCalc")]
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
                    g = [(c, w) for c, q, w in lst] if lst else []
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
    for p in ("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Chromium.app/Contents/MacOS/Chromium"):
        if os.path.exists(p):
            return p
    for n in ("msedge", "microsoft-edge", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        if shutil.which(n):
            return shutil.which(n)
    return None


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
    check("Hell Countess mlvl (Tower Cellar 5 MonLvlEx(H) + 3 unique bonus)", C["The Countess|H|mf0|p1"]["mlvl"], n(ref.levels[25]["MonLvlEx(H)"]) + 3)

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

    # ---- quest drop: act bosses switch to TreasureClassQuest
    Q = js["quest"]
    for nm, qn in (("Mephisto", "Mephistoq (H)"), ("Baal", "Baalq (H)"), ("Diablo", "Diabloq (H)"), ("Duriel", "Durielq (H)")):
        on, off = Q[nm]["on"], Q[nm]["off"]
        ROWS.append(("PASS" if on["tc"] == qn and on["quest"] else "FAIL", "Hell %s quest on: source tc" % nm, on["tc"], qn, ""))
        if on["tc"] != qn: FAIL.append("quest tc " + nm)
        for mf, key in ((0, "hc"), (300, "hc300")):
            for lab, d in (("on", on), ("off", off)):
                t = ref.totals(d["tc"], d["mlvl"], d["N"], mf) if key == "hc" else None
                if t:
                    for qk in ("unique", "set", "rare", "magic"):
                        check("Hell %s quest %s: expected %s items/kill vs reference" % (nm, lab, qk), d["totals"][qk], t[qk], 1e-9)
                check("Hell %s quest %s MF%d: P(Harlequin Crest) vs reference" % (nm, lab, mf), d[key], ref.target(d["tc"], d["mlvl"], d["N"], mf, "unique", "Harlequin Crest"), 1e-9)
    mb = Q["mephBase"]   # Rare=1024 only applies to the quest TC's equipment sub-branches, so magic is not zero for every base: assert the magic share drops
    ok = bool(mb["code"]) and mb["on"]["base"] > 0 and mb["on"]["magic"] / mb["on"]["base"] < mb["off"]["magic"] / mb["off"]["base"]
    ROWS.append(("PASS" if ok else "FAIL", "Hell Mephisto base %s: magic share of drops lower with quest on" % mb["code"], mb["on"]["magic"] / mb["on"]["base"], mb["off"]["magic"] / mb["off"]["base"], ""))
    if not ok: FAIL.append("meph quest magic share")
    check("Hell Mephisto quest on: no gold", Q["Mephisto"]["on"]["totals"]["gold"], 0)
    ROWS.append(("PASS" if Q["Mephisto"]["off"]["totals"]["gold"] > 0 else "FAIL", "Hell Mephisto quest off: gold > 0", Q["Mephisto"]["off"]["totals"]["gold"], ">0", ""))
    mq = Q["Mephisto"]; ok = mq["on"]["totals"]["magic"] / mq["on"]["totals"]["items"] < mq["off"]["totals"]["magic"] / mq["off"]["totals"]["items"]
    ROWS.append(("PASS" if ok else "FAIL", "Hell Mephisto quest on: magic share of items lower (rare-or-better factor)", mq["on"]["totals"]["magic"] / mq["on"]["totals"]["items"], mq["off"]["totals"]["magic"] / mq["off"]["totals"]["items"], ""))
    if not ok: FAIL.append("meph quest magic items")
    A_ = Q["Andariel"]
    ROWS.append(("PASS" if A_["on"]["tc"] == A_["off"]["tc"] == "Andarielq (H)" else "FAIL", "Hell Andariel: same tc with quest on/off", A_["on"]["tc"], A_["off"]["tc"], ""))
    for k in ("unique", "set", "rare", "magic", "items", "gold"):
        check("Hell Andariel quest on == off: totals.%s" % k, A_["on"]["totals"][k], A_["off"]["totals"][k], 1e-12)
    check("Hell Andariel quest on == off: P(Harlequin Crest)", A_["on"]["hc"], A_["off"]["hc"], 1e-12)
    B_ = Q["Baal"]
    ROWS.append(("PASS" if abs(B_["on"]["hc"] - B_["off"]["hc"]) > 1e-9 else "FAIL", "Hell Baal: P(Harlequin Crest) differs quest on vs off", B_["on"]["hc"], B_["off"]["hc"], ""))
    T_ = Q["tz"]
    ROWS.append(("PASS" if T_["on"] == "Diabloq (H)" and T_["flagOff"] == T_["off"] and T_["off"] != "Diabloq (H)" else "FAIL", "TZ Diablo: quest overrides desecrated TC; questOverridesTz=false keeps it", T_["on"], T_["off"], "flag off: %s" % T_["flagOff"]))
    if not (T_["on"] == "Diabloq (H)" and T_["flagOff"] == T_["off"] and T_["off"] != "Diabloq (H)"): FAIL.append("quest tz")
    for nm in ("Mephisto", "Diablo", "Baal"):
        for lab in ("off", "on"):
            t = Q[nm][lab]["totals"]
            info("Hell %s quest %s, 0%% MF, 1p: uniques / items per kill" % (nm, lab), "%.5f" % t["unique"], "%.4f items" % t["items"], "tc %s" % Q[nm][lab]["tc"])

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
    # expected Equip-branch items per kill: Duriel 6.27 -> 1.97, Mephisto 4.37 -> 4.20, Andariel 3.16 -> 3.15 (the first two were 6.41 -> 2.02 and
    # 4.50 -> 4.31 on the wrong LoD-copy tables; the real RotW Desecrated D tables give the new figures)
    for tcn, br, unc, cap_ in (("Duriel (H) Desecrated D", "Equip", 6.27, 1.97), ("Mephisto (H) Desecrated D", "Equip", 4.37, 4.20), ("Andarielq (H) Desecrated H", "Equip", 3.16, 3.15)):
        a = mc.branch_mean(tcn, 85, 1, 30000, 7, None, br)
        b = mc.branch_mean(tcn, 85, 1, 30000, 8, 6, br)
        ok = abs(a - unc) < 0.1 and abs(b - cap_) < 0.08
        ROWS.append(("PASS" if ok else "FAIL", "MC expected '%s' items/kill, %s: uncapped / capped" % (br, tcn), "%.2f / %.2f" % (a, b), "%.2f / %.2f" % (unc, cap_), "MC of the raw tables; Andariel figure from the task"))
        if not ok:
            FAIL.append("equip mean " + tcn)
    # cap = null / 0 reproduces the old numbers; Cow King (never reaches 6 items) is unchanged with the cap on
    kn = CP["knell"]
    check("Knell Striker from normal Cow King, 620 MF, cap off: ~1 in 921 (mlvl 31; regression pin, ItemTypes rarity weights)", 1 / kn["0"]["target"], 920.8, 0.004, "1 in %.1f" % (1 / kn["0"]["target"]))
    check("Knell Striker (cap off) P(base scepter) = 2.47% (regression pin)", kn["0"]["base"], 0.0247, 0.005)
    check("Knell Striker from Cow King identical with cap 6", kn["6"]["target"], kn["0"]["target"], 1e-12)
    SU = CP["su"]
    check("Pindleskin Hell mlvl 86", SU["pind"], 86)
    check("Countess Hell mlvl 82", SU["countess"], 82)
    check("Rakanishu Normal mlvl 8 (Carver lvl 5 + 3)", SU["rak"], 8)
    check("Cow King Normal mlvl 31", SU["cow"], 31)
    check("Hell Radament boss row keeps base level (no unique bonus)", SU["radament"], SU["radamentBase"])
    SM = CP["suMap"]
    for key, nm, aid in (("shenk", "Shenk (Siege Boss)", 110), ("eldritch", "Eldritch (Megaflow Rectifier)", 111), ("thresh", "Thresh Socket", 112),
                         ("colenzo", "Baal Subject 1 (Colenzo) Hell", 131), ("lister", "Baal Subject 5 (Lister) Nightmare", 131), ("bremm", "Bremm Sparkfist", 102)):
        r = SM[key]
        check(nm + " area id", r["id"] if r else None, aid)
        check(nm + " mlvl = area level + 3", r["mlvl"] if r else None, r["expect"] if r else -1)
    ROWS.append(("PASS" if SM["shenk"]["area"] == "Bloody Foothills" else "FAIL", "Shenk is in Bloody Foothills", SM["shenk"]["area"], "Bloody Foothills", ""))
    if SM["shenk"]["area"] != "Bloody Foothills": FAIL.append("shenk area name")
    check("Unused super unique rows are not sources", len(SM["unused"]), 0)
    ROWS.append(("PASS" if SU["bane"] > 0 else "FAIL", "Bane Ash from Normal Rakanishu, P(target) > 0", SU["bane"], ">0", ""))
    if not SU["bane"] > 0: FAIL.append("bane ash")
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
    # ---- class tagged affixes (engine.eligible vs the raw-table reference)
    AF = js["affix"]
    for code in ("ob1", "ba1", "am5", "amu"):
        want = ref.affixes(code)
        check("affixes %s: prefix set equals reference (%d)" % (code, len(want["p"])), AF[code]["p"] == want["p"], True, 0)
        check("affixes %s: suffix set equals reference (%d)" % (code, len(want["s"])), AF[code]["s"] == want["s"], True, 0)
    # ob1 = Sorceress orb: before the fix the dead check let nine Barbarian affixes (Expert's, Raging, Echoing, ...) through
    ob = [x for x in AF["ob1"]["p"] + AF["ob1"]["s"] if x.split("|")[1]]
    check("Sorceress orb ob1: no foreign class affix (barbarian leak gone)", sum(1 for x in ob if not x.endswith("|sor")), 0)
    check("Sorceress orb ob1: own class affixes remain", 1 if any(x.endswith("|sor") for x in ob) else 0, 1)
    check("Sorceress orb ob1: Expert's (bar) excluded", 1 if "Expert's|bar" in AF["ob1"]["p"] else 0, 0)
    amcls = {x.split("|")[1] for x in AF["amu"]["p"] + AF["amu"]["s"] if x.split("|")[1]}
    check("amulet still gets class affixes of all 8 classes", len(amcls), 8)
    check("amulet class set matches reference", 1 if amcls == {"ama", "bar", "nec", "pal", "sor", "ass", "dru", "war"} else 0, 1)
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
                w += max(1, n(ref.types[r["type"]].get("Rarity")))
        return w
    check("armor pool dilution matches independent bracket weights (LoD/RotW)", ratio_mode, wsum(True) / wsum(False), 1e-3,
          "bracket %d, type-rarity sum RotW %d vs LoD %d (only exact if this bracket is reached through armoN entries only)" % (br, wsum(True), wsum(False)))

    # ---- heralds ----------------------------------------------------------------------------------
    Hh = js["herald"]
    dz = json.load(open(os.path.join(SRC, "hd", "desecratedzones.json"), encoding="utf-8"))["desecrated_zones"][0]
    tiers = dz["game_difficulties"]["rotw"]["hell"]["defaults"]["herald_tiers"]
    boosts = [t.get("herald_treasure_class_level_boost", 0) for t in tiers]
    check("herald tier boosts from desecratedzones.json (0,3,6,9,12)", sum(b * 10 ** i for i, b in enumerate(boosts)), sum(b * 10 ** i for i, b in enumerate([0, 3, 6, 9, 12])))
    gh = sorted([(n(r["level"]), name) for name, r in ref.tc.items() if n(r.get("group")) == 41 and re.search(r" Herald [ABC]$", name)])
    def grp_pick(l):
        best = None
        for lv, nm in gh:
            if lv <= l: best = nm
        return best
    zomb_tc = ref.monstats["zombie1"]["TreasureClassHerald(H)"]
    check("herald TC is monstats TreasureClassHerald(H) (zombie1: %s)" % zomb_tc, 1 if Hh["zombieMon"] == zomb_tc == Hh["tiers"]["c60t1"]["tc"] else 0, 1)
    check("every herald row uses an 'Act N (H) Herald A-C' TC", Hh["badTC"], 0)
    bm = n(ref.levels[2]["MonLvlEx(H)"])
    for clvl in (60, 94):
        base_ml = max(bm, min(96, max(70, clvl + 2))) + 3
        for tier, b in ((1, boosts[0]), (5, boosts[4])):
            h = Hh["tiers"]["c%dt%d" % (clvl, tier)]
            check("herald mlvl, clvl %d" % clvl, h["mlvl"], base_ml)
            ROWS.append(("PASS" if h["resolved"] == grp_pick(base_ml + b) else "FAIL", "herald tier %d clvl %d resolved TC (mlvl %d + boost %d)" % (tier, clvl, base_ml, b), h["resolved"], grp_pick(base_ml + b), "base TC " + zomb_tc))
            if h["resolved"] != grp_pick(base_ml + b): FAIL.append("herald tc")
    info("tier boost effect", "%s -> %s" % (Hh["tiers"]["c60t1"]["resolved"], Hh["tiers"]["c60t5"]["resolved"]), "differs at low clvl",
         "at clvl 94 both tiers resolve to %s" % Hh["tiers"]["c94t1"]["resolved"])
    st = Hh["statue"]
    ROWS.append(("PASS" if st.get("found") else "FAIL", "found a herald with mlvl + tier boost = 92 (where group 41 holds the Ancient Statue TCs)", "clvl %s tier %s" % (st.get("clvl"), st.get("tier")), "found", ""))
    if not st.get("found"): FAIL.append("statue level")
    else:
        check("herald at level 92 does not group-upgrade into an Ancient Statue TC (no ua1-ua5 leaf)", st["uaLeaves"], 0)
        info("group-upgrade at 92 without the herald restriction", st["ungated"], "an Ancient Statue TC", "data quirk: heralds are restricted to the Herald TCs (heralds are observed not to drop statue pieces)")
    check("heralds absent in LoD", Hh["inLod"], 0)
    check("heralds absent without terror zone", Hh["noTz"], 0)
    ROWS.append(("PASS" if Hh["count"] > 0 else "FAIL", "heralds present in RotW + Hell + TZ", Hh["count"], ">0", ""))
    EXTRA = (None, None, "1 Extra", "1 Extra", "2 Extra")   # published-odds tier gating (see CONFIG.heraldExtraByTier)
    def gated(top, tier):
        row = dict(ref.tc[top])
        keep = []
        for k in range(1, 11):
            it = row.get("Item%d" % k, "")
            if not it: continue
            m = re.search(r" - (\d Extra)$", it)
            if m and m.group(1) != EXTRA[tier - 1]: continue
            keep.append((it, row["Prob%d" % k]))
        for k in range(1, 11):
            row["Item%d" % k] = keep[k - 1][0] if k <= len(keep) else ""
            row["Prob%d" % k] = keep[k - 1][1] if k <= len(keep) else ""
        row["Picks"] = str(-sum(n(p) for _, p in keep))
        nm = "%s|tier%d" % (top, tier)
        ref.tc[nm] = row
        return nm
    sun_ids = ref.sunder_ids()
    for key, v in Hh["sunder"].items():
        pl, pa = key.split("/")
        d = ref.dist(gated(v["tc"], 3), 91, v["N"])
        want = sum(p for (kind, code, f), p in d.items() if kind == "u" and code in sun_ids)
        check("Sunder chance per tier-3 herald kill, players %s / party %s (N=%d)" % (pl, pa, v["N"]), v["p"], want, 1e-9, "1 in %.0f" % (1 / v["p"]))
    p1 = Hh["sunder"]["1/1"]["p"]
    # PreCrafted Flame Rift from heralds: published 1:342.8 (tier 1/2), 1:228.7 (tier 3/4), 1:171.7 (tier 5) = 1-(1-p)^n, p = (2/407)(30/101), n = 2/3/4 item picks
    pf = (2 / 407) * (30 / 101)
    FL = Hh["flame"]
    for tier, npk, pub in ((1, 2, 342.8), (2, 2, 342.8), (3, 3, 228.7), (4, 3, 228.7), (5, 4, 171.7)):
        want = 1 - (1 - pf) ** npk
        e = FL["off"][str(tier)]
        check("herald tier %d PreCrafted Flame Rift (table path, uncapped) = 1-(1-p)^%d" % (tier, npk), e["table"], want, 1e-9, "1 in %.1f" % (1 / e["table"]))
        check("herald tier %d Flame Rift: explicit-leaf chance == table path" % tier, e["explicit"], e["table"], 1e-9)
        check("herald tier %d Flame Rift 1 in N matches the published figure %.1f" % (tier, pub), 1 / e["table"], pub, 3e-4, "published figures are rounded to 4 significant digits")
        d = ref.dist(gated("Act 1 (H) Herald A", tier), 91, 1)
        check("herald tier %d Flame Rift: independent reference (uncapped)" % tier, e["explicit"], sum(p for (kind, code, f), p in d.items() if kind == "u" and code == "PreCrafted Flame Rift"), 1e-9)
        c = FL["cap"][str(tier)]
        info("herald tier %d Flame Rift with the 6-item drop cap" % tier, "1 in %.1f" % (1 / c["table"]), "1 in %.1f uncapped" % (1 / e["table"]),
             "MF path (cm3 uniques) adds %.3g per kill at 0%% MF, total %.3g" % (e["mf"], e["total"]))
    # ---- Sunder paths ------------------------------------------------------------------------------
    SP = js["sunderPaths"]
    check("herald Sunder table path does not scale with players (Herald Item TCs have NoDrop 0; 8 vs 1)", SP["table"]["8"]["table"], SP["table"]["1"]["table"], 1e-12)
    cs = SP["coldShare"]
    check("Cold Rupture share of Sunder pool = 30/101", cs["table"] / cs["any"], 30 / 101, 1e-3, "'any Sunder' sums the six per-leaf chances (not a union), so the ratio is 30/101 only to ~1e-4")
    # ---- table-driven explicit drops ----------------------------------------------------------------
    DR = js["drops"]
    for c, ok in DR["idx"].items():
        ROWS.append(("PASS" if ok else "FAIL", "search index lists explicitly dropped item %s (spawnable=%s)" % (c, ref.items[c].get("spawnable") or "0"), ok, True, "")); 
        if not ok: FAIL.append("index " + c)
    def ref_base(tc, mlvl, code):
        return sum(p for (kind, cd, f), p in ref.dist(tc, mlvl, 1).items() if kind == "i" and cd == code)
    for key, r in DR["src"].items():
        if r is None:
            ROWS.append(("FAIL", "explicit drop source " + key, "missing", "present", "")); FAIL.append("src " + key); continue
        nm, code = key.split("|")
        want = ref_base(r["tc"], r["mlvl"], code)
        must = key in ("Andariel|ua1", "champion|xa1", "The Countess|pk1", "The Summoner|pk2", "Nihlathak|pk3")
        ok = (r["off"] > 0) == (want > 0) and (r["off"] > 0 or not must)
        ROWS.append(("PASS" if ok else "FAIL", "Hell %s -> %s per-kill chance %s (%s)" % (nm, code, ">0" if must else "> 0 iff the TC names it", r["tc"]), r["off"], want, "1 in %.0f uncapped%s" % (1 / r["off"] if r["off"] else 0, "" if "cap" not in r else ", 1 in %.0f with the 6-item cap" % (1 / r["cap"] if r["cap"] else 0))))
        if not ok: FAIL.append("explicit drop > 0 " + key)
        check("Hell %s -> %s: engine == independent reference (uncapped)" % (nm, code), r["off"], want, 1e-9)
    info("sources that drop xa1 at 0 MF (Hell, incl. terror zone)", ", ".join(DR["xa1Ranks"]), "-", "from TC walk only (no hard-coded route)")
    for tier, h in DR["herald"].items():
        info("Hell herald (zombie1, tier %s, %s) -> xa1..xa5 per kill" % (tier, h["tcName"]), ", ".join("1 in %.0f" % (1 / p) if p else "-" for p in h["p"]), "-", "any shard: 1 in %.0f" % (1 / sum(h["p"])))
        ROWS.append(("PASS" if sum(h["p"]) > 0 else "FAIL", "Hell herald tier %s drops a shard" % tier, sum(h["p"]), ">0", ""))
        if not sum(h["p"]) > 0: FAIL.append("herald shard")
    for idn, a in DR["ars"].items():
        ROWS.append(("PASS" if a["inIndex"] and a["n"] > 0 else "FAIL", "%s in search index with >=1 source" % idn, a["n"], ">0", "; ".join("%s (%s) %s %s%s 1 in %.0f" % (x[0], x[1], x[2], "NmH"[x[3]], " TZ" if x[4] else "", 1 / x[5]) for x in a["top"]) + " | no TZ: " + "; ".join("%s (%s) %s 1 in %.0f" % (x[0], x[1], x[2], 1 / x[5]) for x in a["topNoTz"])))
        if not (a["inIndex"] and a["n"] > 0): FAIL.append("ars " + idn)
    nq = DR["nq"]
    check("quest item pk2 (Hell Summoner): P(target) == P(base) > 0", nq["target"], nq["base"], 1e-12)
    ROWS.append(("PASS" if nq["base"] > 0 else "FAIL", "quest item pk2 base chance > 0", nq["base"], ">0", "1 in %.1f" % (1 / nq["base"] if nq["base"] else 0)))
    if not nq["base"] > 0: FAIL.append("nq base")
    for k in ("magic", "rare", "set", "unique", "normal", "low", "hq"):
        check("quest item pk2 has no quality: %s == 0" % k, nq[k], 0, 1e-12)
    check("quest item pk2 quality() sums to 0 (no quality at all)", nq["qsum"], 0, 1e-12)
    check("magic-capable jewel is unaffected: quality() sums to 1", nq["jewSum"], 1, 1e-9)
    ROWS.append(("PASS" if nq["jewMagic"] > 0 else "FAIL", "jewel (always magic or better) still has P(magic) > 0", nq["jewMagic"], ">0", ""))
    if not nq["jewMagic"] > 0: FAIL.append("jew magic")
    for nm, r in DR["ubers"].items():
        check("%s: rows only in Hell (%s)" % (nm, r["diffs"]), 1 if r["diffs"] == [2] else 0, 1)
        check("%s mlvl = monstats Level(H) 110" % nm, r["mlvl"], 110)
        ROWS.append(("PASS" if r["area"] == "ColossalSummit" and r["act"] == 5 else "FAIL", "%s area/act" % nm, "%s / act %s" % (r["area"], r["act"]), "ColossalSummit / act 5", ""))
        if not (r["area"] == "ColossalSummit" and r["act"] == 5): FAIL.append("uber area")
        for uid, p in r["ps"].items():
            check("%s -> %s: 1/2 per kill" % (nm, uid), p, 0.5, 1e-9)
            ROWS.append(("PASS" if r["idx"][uid] else "FAIL", "%s in search index" % uid, r["idx"][uid], True, ""))
            if not r["idx"][uid]: FAIL.append("index " + uid)
    mf = SP["mf"]
    check("MF path: 0 sunders for mlvl 74 (Hell)", mf["m74h"]["n"], 0)
    check("MF path: 6 sunders at mlvl 75 (Hell)", mf["m75h"]["n"], 6)
    check("MF path: 0 outside Hell (Nightmare, mlvl 87)", mf["m87n"]["n"], 0)
    check("MF path: 0 outside Hell (Normal, mlvl 87)", mf["m87nm0"]["n"], 0)
    check("MF path: engine == independent Ref at mlvl 87", sum(mf["m87h"]["byId"].values()), sum(ref.quality("cm3", 87, 0, (983, 983, 983, 1024))["u"].get(i, 0) for i in ref.sunder_ids()), 1e-9)
    ROWS.append(("INFO", "MF path unique-pool at mlvl 87", "%.4f of unique grand charms are Sunders" % (mf["m87h"]["p"] / (mf["m87h"]["p"] + sum(ref.quality("cm3", 87, 0, (983, 983, 983, 1024))["u"].get(i, 0) for i in [x for x in mf["nonSunderUniques87"]]))), "-", "other cm3 uniques: %s" % ", ".join(mf["nonSunderUniques87"])))
    sr = SP["src"]
    check("source-level MF path 0 for Hell mlvl %d < 75" % sr["lowMlvl"], sr["low"], 0)
    ROWS.append(("PASS" if sr["hi"] > 0 else "FAIL", "source-level MF path > 0 for Hell Mephisto (mlvl %d), Cold Rupture" % sr["hiMlvl"], sr["hi"], ">0", "1 in %.0f; table path %s (only terrorized TCs contain it)" % (1 / sr["hi"] if sr["hi"] else 0, "1 in %.0f" % (1 / sr["hiTable"]) if sr["hiTable"] else "0") ))
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
    # MF diminishing returns apply above 10% MF (data guide "exceeds 110%" includes the baseline 100); scepter unique, mlvl 31, TC unique factor 850
    def uniq_ref(mf):
        eff = (mf * 250) // (mf + 250) if mf > 10 else mf
        p = max((12800 * (400 - 28)) // (100 + eff), 6400)
        p -= (p * 850) // 1024
        return 1.0 if p <= 128 else 128.0 / p
    mt = js["mfThresh"]
    for mf in (0, 10, 11, 100, 110, 111, 200):
        check("MF %d%%: unique chance on scepter (mlvl 31, factor 850)" % mf, mt[str(mf)], uniq_ref(mf))
    check("MF 100% counts as 71 for uniques (more than 0, less than 100)", 1 if mt["0"] < mt["100"] < mt["110"] else 0, 1, 0)
    check("MF 111% is not worse than 110%", 1 if mt["111"] >= mt["110"] else 0, 1, 0)
    check("trialsFor p=1/449, 99% = ceil(ln .01 / ln(1-p))", tr["p449_99"], math.ceil(math.log(0.01) / math.log1p(-1 / 449)), 0)
    check("trialsFor p=0 -> no value", 0 if tr["zero"] is None else 1, 0, 0)
    check("trialsFor p<0 -> no value", 0 if tr["neg"] is None else 1, 0, 0)
    check("trialsFor p=1 -> 1", tr["one"], 1, 0)
    check("trialsFor tiny p=1e-12, 50% ~ ln2/p", tr["tiny"], math.ceil(math.log(2) * 1e12), 1e-9)
    BQ = js["baseQuality"]
    check("Hell Baal, Archon Plate: P(base) > 0", 1 if BQ["baal"]["base"] > 0 else 0, 1, 0)
    check("Hell Baal, Archon Plate: low+normal+superior == 0 (boss TC Magic=1024)", BQ["baal"]["low"] + BQ["baal"]["normal"] + BQ["baal"]["hq"], 0)
    for rk in ("regular", "champion"):
        r = BQ[rk]
        ROWS.append(("PASS" if r else "FAIL", "Hell %s source that drops Archon Plate exists" % rk, r["name"] if r else "none", "-", ""))
        if not r:
            FAIL.append("bq " + rk); continue
        c = r["c"]; wq = c["low"] + c["normal"] + c["hq"]
        if rk == "regular":
            check("Hell regular (%s), Archon Plate: low+normal+superior > 0" % r["name"], 1 if wq > 0 else 0, 1, 0)
            check("Hell regular (%s), Archon Plate: base == magic+rare+set+unique+hq+normal+low" % r["name"], c["base"], c["magic"] + c["rare"] + c["set"] + c["unique"] + wq, 1e-9)
        else:
            check("Hell champion (%s), Archon Plate: low+normal+superior == 0" % r["name"], wq, 0)
    # ---- no qlvl<=mlvl filter on generic TCs (D2MOO D2GAME_DropTC_6FC51360): Hell Bovine (mlvl 81) drops Archon Plate (qlvl 84) via armo84
    BV = js["bovine"]
    if not BV:
        ROWS.append(("FAIL", "Hell Bovine regular source exists", "none", "-", "")); FAIL.append("bovine")
    else:
        c = BV["c"]
        check("Hell Bovine mlvl", BV["mlvl"], 81, 0)
        check("Hell Bovine (mlvl 81), Archon Plate (qlvl 84): P(base) > 0", 1 if c["base"] > 0 else 0, 1, 0)
        check("Hell Bovine, Archon Plate: low > normal > superior > 0", 1 if c["low"] > c["normal"] > c["hq"] > 0 else 0, 1, 0)
        # hand-computed game integers at diff -3 (Uber v1 row), TC factors 0: unique 400/1, set 160/2, rare 100/2, magic 34/3, hq 12/8, normal 1/1
        ch = {k: 128 * (r - idiv(-3, d)) for k, (r, d) in dict(u=(400, 1), s=(160, 2), r=(100, 2), m=(34, 3), h=(12, 8), n=(1, 1)).items()}
        for k, want in zip("usrmhn", (51584, 20608, 12928, 4480, 1536, 512)):
            check("hand-computed game chance %s" % k, ch[k], want, 0)
        pr = {k: min(1.0, 128.0 / v) for k, v in ch.items()}
        rem = 1.0; U = pr["u"]; rem -= U; S = rem * pr["s"]; rem -= S; R = rem * pr["r"]; rem -= R; M = rem * pr["m"]; rem -= M
        hq = rem * pr["h"]; rem -= hq; nm = rem * pr["n"]; lo = rem - nm
        q = BV["q"]
        for k, want in (("rare", R + U), ("magic", M + S), ("hq", hq), ("normal", nm), ("low", lo), ("unique", 0), ("set", 0)):
            check("quality('utp', 81, 0 MF, no TC factor): %s" % k, q[k], want, 1e-12)
        tot = c["base"] or 1   # splits are shares of the base chance
        info("Hell Bovine (regular, 0%% MF) Archon Plate per kill", "1 in %.0f" % (1 / (c["base"] or 1e-12)), "online calc: 1:11,021",
             "split of base: low %.2f%% normal %.2f%% superior %.2f%% magic %.2f%% rare %.2f%% (online: 50.87/16.96/6.17/21.44/4.57)" % tuple(100 * c[k] / tot for k in ("low", "normal", "hq", "magic", "rare")))
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
