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
def rd(name, sub=""):
    """Raw table; sub="" = Reign of the Warlock (root folder), sub="base" = Lord of Destruction."""
    with open(os.path.join(SRC, sub, name + ".txt"), encoding="utf-8", errors="replace") as f:
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
    def __init__(self, sub=""):
        self.sub = sub   # "" = RotW tables, "base" = LoD tables
        self.tc = {r["Treasure Class"]: r for r in rd("treasureclassex", sub)}
        self.items = {}
        for f in ("armor", "weapons", "misc"):
            for r in rd(f, sub):
                if r.get("code"):
                    r["_f"] = f
                    self.items[r["code"]] = r
        self.types = {r["Code"]: r for r in rd("itemtypes", sub) if r.get("Code")}
        self.uniq = rd("uniqueitems", sub)
        self.uidx = {u["index"] for u in self.uniq}
        self.sets = rd("setitems", sub)
        self.ratio = rd("itemratio", sub)
        self.monstats = {r["Id"]: r for r in rd("monstats", sub)}
        self.levels = {n(r["Id"]): r for r in rd("levels", sub) if r.get("Id")}
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

    def max_sockets(self, code, ilvl=None):
        """ITEMS_GetMaxSockets (D2Common Items.cpp) capped by the inventory size (ITEMMODS_PropertyFunc14): 0 when the base has no inventory
        (hasinv 0). Item level > 25 uses MaxSockets2, > 40 MaxSockets3 (ilvl None = 120)."""
        r = self.items[code]
        if not n(r.get("hasinv")):
            return 0
        t = self.types.get(r.get("type", ""))
        if not t:
            return 0
        il = 120 if ilvl is None else max(1, ilvl)
        th1, th2 = n(t.get("MaxSocketsLevelThreshold1")), n(t.get("MaxSocketsLevelThreshold2"))
        m = n(t.get("MaxSockets1")) if il <= th1 else n(t.get("MaxSockets2")) if il <= th2 else n(t.get("MaxSockets3"))
        return min(m, n(r.get("gemsockets")), n(r.get("invwidth")) * n(r.get("invheight")))

    def affixes(self, code, alvl=99, ilvl=None):
        """Eligible magic prefixes/suffixes ('name|class') for a base at an affix level, straight from the raw tables.
        Rule: type (or a parent) in itype, none in etype; a class tagged affix (classspecific) may appear on any matching base
        except a class-specific base (type chain with a Class in itemtypes), which only takes its own class. The socket affixes (Mechanist's,
        Artificer's, Jeweler's) need a base that can hold sockets at this item level (max_sockets > 0; ilvl None = unlimited)."""
        anc = self.item_anc(code)
        cls = [self.types[t]["Class"] for t in anc if self.types[t].get("Class")]
        out = {}
        for key, fname in (("p", "magicprefix"), ("s", "magicsuffix")):
            res = []
            for a in rd(fname, self.sub):
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
                if a.get("mod1code") == "sock" and self.max_sockets(code, ilvl) <= 0:   # socket affixes need a socketable base
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


# ------------------------------------------------ item generation rules (independent re-implementation of D2MOO over the raw tables)
class Rules:
    """Staff mods, magic and rare affix rolls, written straight from the D2MOO sources (see README "Item generation rules"):
    D2Game/src/ITEMS/Items.cpp (sub_6FC52410 / sub_6FC52650 staff mods, sub_6FC4D5E0 magic), D2Game/src/ITEMS/ItemsMagic.cpp
    (ITEMS_RollMagicAffixesNew, D2GAME_RollRareItem_6FC53360), D2Common ItemMods.cpp (ITEMMODS_CanItemHaveMagicAffix).
    It reads the raw .txt tables, not data.json, and shares no code with engine.js."""

    def __init__(self, ref):
        self.ref = ref
        sub = ref.sub
        self.aff = {k: [a for a in rd(f, sub) if a.get("Name")] for k, f in (("p", "magicprefix"), ("s", "magicsuffix"), ("a", "automagic"))}
        self.skills = [r for r in rd("skills", sub) if r.get("*Id") and r.get("skill")]
        self.pool_cache = {}

    # --- item level -> affix level (ITEMS_ComputeCraftedMagicAffixLevel)
    def alvl(self, code, ilvl):
        it = self.ref.items[code]
        q = n(it["level"]); ml = n(it.get("magic lvl"))
        il = max(ilvl, q)
        if ml:
            r = ml + il
        else:
            half = q // 2
            r = il - half if il < 99 - half else 2 * il - half - (99 - half)
        return min(max(r, 1), 99)

    @staticmethod
    def mods(a):
        out = []
        for i in (1, 2, 3):
            c = a.get("mod%dcode" % i)
            if c:
                mn = n(a.get("mod%dmin" % i)); mx = n(a.get("mod%dmax" % i), mn) if a.get("mod%dmax" % i) else mn
                out.append((c, mn, mx))
        return out

    def pool(self, code, alvl, rare, ilvl=None):
        ms = self.ref.max_sockets(code, ilvl)
        key = (code, alvl, rare, ms)
        if key in self.pool_cache:
            return self.pool_cache[key]
        ref = self.ref
        it = ref.items[code]
        anc = ref.item_anc(code)
        cls = [ref.types[t]["Class"] for t in anc if ref.types[t].get("Class")]
        ml = n(it.get("magic lvl"))
        ap = n(it.get("auto prefix"))
        res = {"p": [], "s": [], "a": []}
        for kind in ("p", "s", "a"):
            for a in self.aff[kind]:
                if n(a.get("version")) < 1 or n(a.get("frequency")) <= 0:
                    continue
                if kind != "a" and not n(a.get("spawnable")):
                    continue                                   # automagic: bRequireSpawnableAffix = 0
                if rare and not n(a.get("rare")):
                    continue
                if n(a["level"]) > alvl or (a.get("maxlevel") and n(a["maxlevel"]) < alvl):
                    continue
                if kind == "a" and n(a.get("group")) != ap:
                    continue
                its = [a["itype%d" % i] for i in range(1, 8) if a.get("itype%d" % i)]
                ets = [a["etype%d" % i] for i in range(1, 6) if a.get("etype%d" % i)]
                if any(t in anc for t in ets) or not any(t in anc for t in its):
                    continue
                if a.get("classspecific") and cls and a["classspecific"] not in cls:
                    continue
                m = self.mods(a)
                if m and m[0][0] == "sock":
                    # ITEMMODS_PropertyFunc14: roll min..max (blank = the param), 0 -> param, clamped to 1..max sockets of the base at this item level
                    if ms <= 0:
                        continue
                    par = n(a.get("mod1param"))
                    lo, hi = (m[0][1], m[0][2]) if m[0][1] != m[0][2] else ((m[0][1] or par),) * 2
                    m = [("sock", max(1, min(lo or par, ms)), max(1, min(hi or par, ms)))] + m[1:]
                w = n(a["frequency"]) * (n(a["level"]) if ml else 1)    # ComputeAffixFrequency
                res[kind].append({"w": w, "g": n(a.get("group")), "m": m, "lr": n(a.get("levelreq")), "lvl": n(a["level"])})
        self.pool_cache[key] = res
        return res

    @staticmethod
    def cond_p(a, conds):
        """P(affix meets each condition (property code, min)): best mod of the affix with that code"""
        out = []
        for code, mn_req in conds:
            best = 0.0
            for c, mn, mx in a["m"]:
                if c == code or (isinstance(code, frozenset) and c in code):
                    p = 1.0 if mn_req <= mn else (0.0 if mn_req > mx else (mx - mn_req + 1) / (mx - mn + 1))
                    best = max(best, p)
            out.append(best)
        return out

    # --- magic items (sub_6FC4D5E0): prefix 1/2, suffix forced when no prefix else 1/2; exact over all affix pairs
    def magic(self, code, ilvl, conds):
        pl = self.pool(code, self.alvl(code, ilvl), False, ilvl)
        P, S, A = pl["p"], pl["s"], pl["a"]
        if not P and not S:
            return 0.0
        forms = [(0.25, True, True), (0.25, True, False), (0.5, False, True)]
        if not P:
            forms = [(1.0, False, True)]
        elif not S:
            forms = [(1.0, True, False)]
        nc = len(conds)
        zero = [0.0] * nc
        def side(L):
            W = sum(a["w"] for a in L)
            return [(a["w"] / W, a["g"], self.cond_p(a, conds)) for a in L]
        PL, SL = side(P), side(S)
        WA = sum(a["w"] for a in A)
        AL = [(a["w"] / WA, self.cond_p(a, conds)) for a in A] or [(1.0, zero)]
        total = 0.0
        for fw, hp, hs in forms:
            for pw, pg, pc in (PL if hp else [(1.0, None, zero)]):
                sl = SL if hs else [(1.0, None, zero)]
                if hp and hs:   # suffix drawn among the groups the prefix did not take
                    sl = [x for x in SL if x[1] != pg]
                    ws = sum(x[0] for x in sl)
                    sl = [(x[0] / ws, x[1], x[2]) for x in sl]
                for sw, sg, sc in sl:
                    for aw, ac in AL:
                        q = 1.0
                        for i in range(nc):
                            q *= 1 - (1 - pc[i]) * (1 - sc[i]) * (1 - ac[i])
                        total += fw * pw * sw * aw * q
        return total

    # --- rare items (D2GAME_RollRareItem_6FC53360): literal Monte Carlo with real value rolls
    def rare_mc(self, code, ilvl, conds, rolls, seed, counts=None):
        import bisect, random
        rng = random.Random(seed)
        pl = self.pool(code, self.alvl(code, ilvl), True, ilvl)
        sides = {}
        for k in ("p", "s"):
            L = pl[k]
            cum = []; t = 0
            for a in L:
                t += a["w"]; cum.append(t)
            sides[k] = (L, cum, t)
        A = pl["a"]
        counts = counts or ([3, 4] if self.ref.items[code].get("type") == "jewl" else [3, 4, 4, 5, 5, 5, 6, 6])
        def draw(k, used):
            L, cum, t = sides[k]
            if not L:
                return None
            for _ in range(40):
                a = L[min(bisect.bisect_right(cum, rng.random() * t), len(L) - 1)]
                if a["g"] not in used:
                    return a
            cand = [a for a in L if a["g"] not in used]
            if not cand:
                return None
            r = rng.random() * sum(a["w"] for a in cand)
            for a in cand:
                r -= a["w"]
                if r < 0:
                    return a
            return cand[-1]
        hit = 0
        wanted = {c for c, m in conds}
        for _ in range(rolls):
            count = counts[rng.randrange(len(counts))]
            used = set(); stats = {}
            np_ = ns = k = 0; pfull = sfull = False
            while k < count and not (pfull and sfull):
                suffix = (not sfull) and (pfull or rng.random() >= 0.5)
                a = draw("s" if suffix else "p", used)
                if a is None:
                    if suffix: sfull = True
                    else: pfull = True
                    continue
                used.add(a["g"])
                for c, mn, mx in a["m"]:
                    if c in wanted:
                        stats[c] = max(stats.get(c, -10**9), rng.randint(mn, mx))
                if suffix:
                    ns += 1; sfull = ns >= 3
                else:
                    np_ += 1; pfull = np_ >= 3
                k += 1
            if A:
                W = sum(a["w"] for a in A); r = rng.random() * W
                au = A[-1]
                for a in A:
                    r -= a["w"]
                    if r < 0:
                        au = a; break
                for c, mn, mx in au["m"]:
                    if c in wanted:
                        stats[c] = max(stats.get(c, -10**9), rng.randint(mn, mx))
            if all(stats.get(c, -10**9) >= m for c, m in conds):
                hit += 1
        return hit / rolls

    # --- staff mods (sub_6FC52650), drop item level, expansion format. Returns P(item has class skill index `idx` at value >= minv)
    def staff(self, code, ilvl, idx, minv, magic_quality=True):
        ref = self.ref
        it = ref.items[code]
        sm = ref.types[it["type"]].get("StaffMods", "")
        if not sm:
            return 0.0
        cl = sorted((n(r["*Id"]), r.get("itypea1", "")) for r in self.skills if r.get("charclass") == sm)
        first = cl[0][0]
        anc = ref.item_anc(code)
        itypea = dict(cl)
        target = first + idx
        base = 1
        if ilvl > 36: base = 5
        elif ilvl > 24: base = 4
        elif ilvl > 18: base = 3
        elif ilvl > 11: base = 2
        # literal 0..99 rolls, grouped
        def grp(f):
            d = {}
            for r in range(100):
                d[f(r)] = d.get(f(r), 0) + 1
            return {k: v / 100 for k, v in d.items()}
        cnt = grp(lambda r: 3 if r > 90 else 2 if r > 70 else 1 if r > 30 else 0)
        lay = grp(lambda r: max(base + 1 if r > 80 else base if r > 30 else base - 1 if r > 10 else base - 2, 1))
        val = grp(lambda r: 3 if r >= 90 else 2 if r >= 60 else 1)
        def one_draw(state_p):
            """state: (skillIds tuple of 3, value of the target stat) -> distribution after one draw"""
            out = {}
            for (ids, tv), p in state_p.items():
                for layer, pl_ in lay.items():
                    lb = first + 5 * (layer - 1)
                    mass = 1.0                                    # probability mass that no try has been accepted yet
                    results = {}                                  # (skill id, recorded) -> prob
                    for t in range(6):
                        nxt = 0.0
                        for off in range(5):
                            sid = lb + off
                            ok = (not itypea.get(sid)) or itypea[sid] in anc
                            if ok and sid not in ids:
                                results[(sid, True)] = results.get((sid, True), 0) + mass / 5
                            elif t == 5:
                                results[(sid, False)] = results.get((sid, False), 0) + mass / 5
                            else:
                                nxt += mass / 5
                        mass = nxt
                    for (sid, rec), pr in results.items():
                        nids = tuple(sorted(ids + (sid,))) if rec else ids
                        for v, pv in val.items():
                            ntv = v if sid == target else tv
                            k = (nids, ntv)
                            out[k] = out.get(k, 0) + p * pl_ * pr * pv
            return out
        states = {((), 0): 1.0}
        total = cnt.get(0, 0) * sum(p for (ids, tv), p in states.items() if tv >= minv)
        for c in (1, 2, 3):
            states = one_draw(states)
            total += cnt.get(c, 0) * sum(p for (ids, tv), p in states.items() if tv >= minv)
        return total

    # --- item builder references -------------------------------------------------------------------------------------------------
    @staticmethod
    def staff_tiers(ilvl):
        base = 5 if ilvl > 36 else 4 if ilvl > 24 else 3 if ilvl > 18 else 2 if ilvl > 11 else 1
        return {max(1, base + sh) for sh in (1, 0, -1, -2)}

    def plan(self, code, ilvl, quality, conds):
        """Brute force: can the item carry all conds ((property code, min) or ('staff', tier, value)) and with which lowest affix level requirement?
        Subsets of candidate sources (p / s / auto rows) up to the number of conditions; magic 1 prefix + 1 suffix, rare 3 + 3 (total <= 6, jewel 4),
        one automagic row, no two affixes of one group. Returns (ok, lr)."""
        import itertools
        rare = quality == "rare"
        pl = self.pool(code, self.alvl(code, ilvl), rare, ilvl)
        need = set(range(len(conds)))
        for i, c in enumerate(conds):
            if c[0] == "staff":
                if c[1] not in self.staff_tiers(ilvl) or c[2] > 3:
                    return (False, None)
                need.discard(i)
        cands = []
        for kind in ("p", "s", "a"):
            for a in pl[kind]:
                cov = frozenset(i for i in need if self.cond_p(a, [conds[i]])[0] > 0)
                if cov and (kind, a["g"] if kind != "a" else 0, a["lr"], cov) not in cands:
                    cands.append((kind, a["g"] if kind != "a" else 0, a["lr"], cov))
        if not need:
            return (True, 0)
        jewel = self.ref.items[code].get("type") == "jewl"
        lim = (3, 3, 4 if jewel else 6) if rare else (1, 1, 2)
        best = None
        for k in range(1, len(need) + 1):
            for sub in itertools.combinations(cands, k):
                if set().union(*[c[3] for c in sub]) != need:
                    continue
                np_ = sum(1 for c in sub if c[0] == "p"); ns = sum(1 for c in sub if c[0] == "s"); na = sum(1 for c in sub if c[0] == "a")
                if np_ > lim[0] or ns > lim[1] or np_ + ns > lim[2] or na > 1:
                    continue
                gs = [c[1] for c in sub if c[0] != "a" and c[1]]
                if len(gs) != len(set(gs)):
                    continue
                lr = max(c[2] for c in sub)
                best = lr if best is None else min(best, lr)
        return (best is not None, best)

    def combo(self, code, conds, quality):
        """(first item level, last item level, lowest character level) from base level to 99, like the builder"""
        it = self.ref.items[code]
        lv = n(it.get("levelreq"))
        lo = hi = req = None
        for il in range(max(1, n(it["level"])), 100):
            ok, lr = self.plan(code, il, quality, conds)
            if not ok:
                continue
            if lo is None:
                lo = il
            hi = il
            r = max(lv, lr)
            req = r if req is None else min(req, r)
        return (lo is not None, lo, hi, req)

    def appear(self, code, ilvl):
        """P(each magic affix row appears), keyed (kind, affix level, number of mods): rows are summed per key, so display-scaled values (charges, per-level stats) do not matter; exact over prefix/suffix pairs (group exclusion), automagic w/W"""
        pl = self.pool(code, self.alvl(code, ilvl), False, ilvl)
        P, S, A = pl["p"], pl["s"], pl["a"]
        out = {}
        key = lambda kind, a: (kind, a["lvl"], len(a["m"]))
        add = lambda k, p: out.__setitem__(k, out.get(k, 0.0) + p)
        WA = sum(a["w"] for a in A)
        for a in A:
            add(key("a", a), a["w"] / WA)
        if not P and not S:
            return out
        forms = [(0.25, True, True), (0.25, True, False), (0.5, False, True)]
        if not P:
            forms = [(1.0, False, True)]
        elif not S:
            forms = [(1.0, True, False)]
        WP = sum(a["w"] for a in P); WS = sum(a["w"] for a in S)
        for fw, hp, hs in forms:
            for a in (P if hp else [None]):
                pw = a["w"] / WP if a else 1.0
                sl = S if hs else []
                if hp and hs:
                    sl = [x for x in S if x["g"] != a["g"]]
                ws = sum(x["w"] for x in sl)
                if hp:
                    add(key("p", a), fw * pw)
                for x in sl:
                    add(key("s", x), fw * pw * x["w"] / ws)
        return out


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
        js = json.loads(html.unescape(m.group(1)))
        # the old Tab 2 deep link (?q2=&ql=&c=) must still resolve in the real page (builder, main thread: ?noworker)
        dl = subprocess.run([b, "--headless=new", "--disable-gpu", "--virtual-time-budget=60000", "--dump-dom",
                             "http://127.0.0.1:%d/index.html?noworker&mode=rotw&q2=Monarch&ql=magic&c=Socketed%%20(%%23):4" % port], capture_output=True, text=True, timeout=180).stdout
        t = re.search(r'<div class="box" id="res2">(.*?)</div>\s*<div class="note" id="finfo2">(.*?)</div>', dl, re.S)
        js["deeplink"] = html.unescape(re.sub(r"<[^>]+>", " ", t.group(1) + " | " + t.group(2))) if t else ""
        return js
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
    # generic armoN pool: the share of one base in its bracket pool, per mode, vs independent bracket weights (the grimoires dilute it in RotW only)
    mb = ref.items[M["midBase"]]
    br = max(3, -(-n(mb["level"]) // 3) * 3)
    def wsum(rf, include_grim):
        w = 0
        for code, r in rf.items.items():
            if n(r.get("spawnable")) != 1: continue
            if code in grims and not include_grim: continue
            if "armo" in rf.item_anc(code) and max(3, -(-n(r.get("level")) // 3) * 3) == br:
                w += max(1, n(rf.types[r["type"]].get("Rarity")))
        return w
    wr = max(1, n(ref.types[mb["type"]].get("Rarity")))
    check("RotW armo%d pool share of %s (grimoires in the pool)" % (br, M["midBase"]), M["rotw"]["poolShare"], wr / wsum(ref, True), 1e-9)
    check("LoD armo%d pool share of %s (no grimoires)" % (br, M["midBase"]), M["lod"]["poolShare"], wr / wsum(Ref("base"), False), 1e-9)
    ROWS.append(("PASS" if M["lod"]["poolShare"] > M["rotw"]["poolShare"] else "FAIL", "base %s pool share is larger in LoD (no grimoire dilution)" % M["midBase"], M["lod"]["poolShare"], M["rotw"]["poolShare"], ""))
    if not M["lod"]["poolShare"] > M["rotw"]["poolShare"]: FAIL.append("pool dilution")

    # Tab 1 autocomplete source (= searchIndex(), unfiltered by spawnable): quest keys, essences are searchable in both modes
    for mode in ("rotw", "lod"):
        check("%s: Tab 1 autocomplete source has Key of Terror/Hate/Destruction (pk1-pk3)" % mode, sum(1 for x in M[mode]["acKeys"] if x), 3)
        check("%s: 'key of' matches pk1, pk2, pk3" % mode, 1 if {"pk1", "pk2", "pk3"} <= set(M[mode]["acQuery"]) else 0, 1)
        ROWS.append(("PASS" if M[mode]["acEssence"] >= 3 else "FAIL", "%s: essences in the autocomplete source" % mode, M[mode]["acEssence"], ">=3", ""))
        if M[mode]["acEssence"] < 3: FAIL.append("essence ac")
    # ---- display names and stat descriptions: expected values come straight from the string tables / raw tables (independent of build.py)
    def strs(fname):
        with open(os.path.join(SRC, "strings", fname + ".json"), encoding="utf-8-sig") as f:
            return {r["Key"].lower(): r["enUS"] for r in reversed(json.load(f))}
    ST_IN, ST_AF, ST_SK, ST_MD = strs("item-names"), strs("item-nameaffixes"), strs("item-modifiers"), strs("monsters")
    ST_LV = strs("levels")
    for mode in ("rotw", "lod"):
        N = js["names"][mode]
        check("%s: Harlequin Crest display name (item-names)" % mode, 1 if N["hc"] == ST_IN["harlequin crest"] == "Harlequin Crest" else 0, 1)
        check("%s: unique label starts with its display name" % mode, 1 if N["hcLabel"].startswith("Harlequin Crest - unique") else 0, 1)
        check("%s: table-key typo shows the real name (Thudergod's Vigor -> %s)" % (mode, ST_IN["thudergod's vigor"]), 1 if N["thunder"] == ST_IN["thudergod's vigor"] == "Thundergod's Vigor" else 0, 1)
        check("%s: search finds Thundergod's Vigor by display name and by old table key" % mode, 1 if min(N["thunderBoth"]) >= 1 else 0, 1)
        check("%s: super unique 'Siege Boss' shows its real name (monsters.json)" % mode, 1 if N["siege"] == N["siegeId"] == ST_MD["siege boss"] == "Shenk the Overseer" else 0, 1)
        check("%s: affix Eburin -> Eburine (item-nameaffixes), key unchanged" % mode, 1 if N["eburin"] == ST_AF["eburin"] == "Eburine" else 0, 1)
        check("%s: area name from levels.json (Moo Moo Farm -> The Secret Cow Level)" % mode, 1 if N["areaName"] == ST_LV["moo moo farm"] == "The Secret Cow Level" else 0, 1)
        check("%s: monster name from monsters.json (izual)" % mode, 1 if N["mon"] == "Izual" else 0, 1)
        check("%s: no spawnable affix mod without a description / with a raw code" % mode, len(N["emptyDesc"]), 0)
        check("%s: Cold Skills tab description (skilltab 5)" % mode, 1 if any("Cold Skills (Sorceress Only)" in x for x in N["statList"]) else 0, 1)
        check("%s: describe() fills value / range / negative / multi-placeholder" % mode, 1 if N["range"] == ["+10-20% Faster Cast Rate", "+5 to Strength", "Requirements -20 to -10%", "Level # Fire Bolt (#/# Charges)"] else 0, 1)
    N = js["names"]["rotw"]
    check("RotW: affix TaintedAffix -> Tainted (item-nameaffixes), key unchanged", 1 if N["tainted"] == ST_AF["taintedaffix"] == "Tainted" and N["taintedId"] == "TaintedAffix" else 0, 1)
    check("RotW: Warlock tabs 21/22/23 read Demon / Eldritch / Chaos (Warlock Only)",
          1 if all(t and k in t and "(Warlock Only)" in t and t.startswith("+# to") for t, k in zip(N["tabs"], ("Demon", "Eldritch", "Chaos"))) else 0, 1)
    check("RotW: tab 0 is Bow and Crossbow (Amazon Only)", 1 if N["tab0"] == "+# to Bow and Crossbow Skills (Amazon Only)" else 0, 1)
    check("RotW: statue pieces ua1-ua5 have real names (%s)" % ", ".join(N["statue"]), 1 if N["statue"] == [ST_IN[c] for c in ("ua1", "ua2", "ua3", "ua4", "ua5")] and all(N["statue"]) else 0, 1)
    check("RotW: 'talic' finds the statue piece", 1 if any("Talic's Anguish" in x for x in N["statueSearch"]) else 0, 1)
    check("LoD: no statue pieces (no source) and same name machinery", 1 if js["names"]["lod"]["tabs"] == [None, None, None] and js["names"]["lod"]["tab0"] == N["tab0"] else 0, 1)
    check("Faster Cast Rate description (item-modifiers ModStr4v)", 1 if N["fcr"] == ST_SK["modstr4v"].replace("%+d", "+#").replace("%%", "%") == "+#% Faster Cast Rate" else 0, 1)

    # ---- LoD mode: data-lod.json (excel/base tables) vs an independent reference on the base tables
    L = M
    ref_l = Ref("base")
    check("data.json meta.mode is rotw", 1 if L["meta"]["rotw"]["mode"] == "rotw" and L["meta"]["rotwMode"] == "rotw" else 0, 1)
    check("data-lod.json meta.mode is lod", 1 if L["meta"]["lod"]["mode"] == "lod" and L["meta"]["lodMode"] == "lod" else 0, 1)
    check("both data files share gameVersion/buildKey/built", 1 if all(L["meta"]["rotw"][k] == L["meta"]["lod"][k] for k in ("gameVersion", "buildKey", "built")) else 0, 1)
    check("no spl override fields left in the data", L["meta"]["lodDirty"], 0)
    check("LoD: grimoires spawnable=0 in data-lod.json", L["lod"]["grimSp"], 0)
    check("RotW: grimoires spawnable in data.json", L["rotw"]["grimSp"], 15)
    check("LoD: no statue pieces ua1-ua5 in the search index", L["lod"]["statueInIndex"], 0)
    check("LoD: no worldstone shards xa1-xa5 in the search index", L["lod"]["shardInIndex"], 0)
    check("RotW: statue pieces ua1-ua5 in the search index", L["rotw"]["statueInIndex"], 5)
    check("RotW: worldstone shards xa1-xa5 in the search index", L["rotw"]["shardInIndex"], 5)
    check("LoD: no Warlock affixes (cls war) in data-lod.json", L["lod"]["warAffixesInData"], 0)
    check("LoD: no Warlock affix eligible on an amulet", L["lod"]["warAmulet"], 0)
    check("RotW: Warlock affixes eligible on an amulet", 1 if L["rotw"]["warAmulet"] > 0 else 0, 1)
    check("LoD: Sorceress affixes still eligible on an amulet", 1 if L["lod"]["sorAmulet"] > 0 else 0, 1)
    check("heralds follow the data: RotW has 5 tiers and herald sources, LoD none", 1 if L["rotw"]["heraldSources"] > 0 and L["lod"]["heraldSources"] == 0 and L["meta"]["rotwHeraldTiers"] == 5 and L["meta"]["lodHeraldTiers"] == 0 else 0, 1)
    for mode, ref_m in (("rotw", ref), ("lod", ref_l)):
        a_ = ref_m.tc["Andarielq (H)"]
        got = L[mode]["andariel"]
        check("%s Andarielq (H) Unique/Set/Rare/Magic factors equal the raw table" % mode, got["u"] * 10 ** 9 + got["s"] * 10 ** 6 + got["r"] * 10 ** 3 + got["m"], n(a_["Unique"]) * 10 ** 9 + n(a_["Set"]) * 10 ** 6 + n(a_["Rare"]) * 10 ** 3 + n(a_["Magic"]))
    check("Andarielq (H) unique factor: 995 in LoD", L["lod"]["andariel"]["u"], 995)
    check("Andarielq (H) unique factor: 983 in RotW", L["rotw"]["andariel"]["u"], 983)
    ROWS.append(("PASS" if L["lod"]["andariel"]["u"] != L["rotw"]["andariel"]["u"] else "FAIL", "Andarielq (H) differs between modes", L["lod"]["andariel"]["u"], L["rotw"]["andariel"]["u"], ""))
    if L["lod"]["andariel"]["u"] == L["rotw"]["andariel"]["u"]: FAIL.append("andariel modes")
    for key, c in js["lod"]["cases"].items():
        name, _, mfs, ps = key.split("|")
        mf = int(mfs[2:])
        mon = ref_l.monstats["andariel"] if name == "Andariel" else ref_l.monstats["mephisto"] if name == "Mephisto" else None
        if mon:
            check("LoD Hell %s mlvl" % name, c["mlvl"], n(mon["Level(H)"]))
        t_ = ref_l.totals(c["tc"], c["mlvl"], c["N"], mf)
        for q in ("unique", "set", "rare", "magic"):
            check("LoD %s Hell MF%d: expected %s items/kill vs base-table reference" % (name, mf, q), c["totals"][q], t_[q], 1e-9)
    check("LoD Hell Andariel P(Harlequin Crest) vs base-table reference",
          js["lod"]["hcAndariel"], ref_l.target(js["lod"]["cases"]["Andariel|H|mf0|p1"]["tc"], js["lod"]["cases"]["Andariel|H|mf0|p1"]["mlvl"], 1, 0, "unique", "Harlequin Crest"), 1e-9)
    ok = abs(js["lod"]["hcAndariel"] - js["lod"]["hcAndarielRotw"]) > 1e-9
    ROWS.append(("PASS" if ok else "FAIL", "Hell Andariel P(Harlequin Crest) differs between modes", js["lod"]["hcAndariel"], js["lod"]["hcAndarielRotw"], ""))
    if not ok: FAIL.append("andariel hc modes")
    # expansion bounds of desecratedzones for LoD, rotw section for RotW
    dzs = json.load(open(os.path.join(SRC, "hd", "desecratedzones.json"), encoding="utf-8"))["desecrated_zones"][0]["game_difficulties"]
    for mode, sec in (("lod", "expansion"), ("rotw", "rotw")):
        want = [(dzs[sec][d]["defaults"]["bound_incl_min"], dzs[sec][d]["defaults"]["bound_incl_max"]) for d in ("normal", "nightmare", "hell")]
        got = [(b["min"], b["max"]) for b in L[mode]["tzBounds"]]
        check("%s terror zone bounds come from desecratedzones section %s" % (mode, sec), 1 if got == want else 0, 1)

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
        ROWS.append(("PASS" if r["area"] == "Colossal Summit" and r["act"] == 5 else "FAIL", "%s area/act" % nm, "%s / act %s" % (r["area"], r["act"]), "Colossal Summit / act 5", ""))
        if not (r["area"] == "Colossal Summit" and r["act"] == 5): FAIL.append("uber area")
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
    # ---- item generation rules (staff mods, magic exact odds, rare affix loop): engine vs the independent D2MOO re-implementation
    RU = Rules(ref); RUL = js["rules"]
    FIRE = [("res-fire", 10)]; BOTH = [("res-fire", 10), ("res-cold", 10)]
    check("staffMods config: P(0..3 skills) = 31/40/20/9 %", 1 if RUL["cfg"]["count"] == [31, 40, 20, 9] else 0, 1, 0)
    for c in RUL["staff"]:
        tag = "%s (%s idx %d, +%d, ilvl %d)" % (c["code"], c["cls"], c["idx"], c["min"], c["ilvl"])
        ps = RU.staff(c["code"], c["ilvl"], c["idx"], c["min"])
        pf = RU.magic(c["code"], c["ilvl"], FIRE)
        check("staff mod %s: magic, staff only == reference" % tag, c["magicStaff"], ps, 1e-9)
        check("staff mod %s: rare, staff only == reference" % tag, c["rareStaff"], ps, 1e-9)
        check("staff mod %s: magic, staff + fire res >= 10 == staff x affix (reference)" % tag, c["magicBoth"], ps * pf, 1e-9)
        check("staff mod %s: magic, fire res >= 10 alone == reference exact" % tag, c["magicFire"], pf, 1e-9)
        check("staff mod %s: rare, staff + fire res == staff x engine rare fire" % tag, c["rareBoth"], ps * c["rareFire"], 1e-9)
        info("staff mod %s: P(staff skill) per magic item" % tag, "%.6f%%" % (100 * ps), "-", "listed in statList: %s" % c["inList"])
    L = RUL["lodNoStaff"]
    check("LoD wand rolls the same staff mods as RotW (same tables)", L["wand"], L["wandRotw"], 1e-12)
    ref_lod_rules = Rules(Ref("base"))
    check("LoD wand staff mod == LoD reference", L["wand"], ref_lod_rules.staff("wnd", 20, 12, 1), 1e-9)
    check("LoD knife has no StaffMods (RotW only: 'war')", 1 if (L["knifeSm"] == "" and L["knifeSmRotw"] == "war") else 0, 1, 0)
    check("LoD data has no Warlock skill list; no Hex skill offered on a LoD knife", 1 if (not L["warStaff"] and L["listed"] == 0) else 0, 1, 0)
    check("RotW knife offers Warlock staff mod skills in statList", 1 if L["listedRotw"] > 0 else 0, 1, 0)
    for c in RUL["magic"]:
        tag = "%s ilvl %d (alvl %d)" % (c["code"], c["ilvl"], c["alvl"])
        check("magic exact %s: fire res >= 10 == reference" % tag, c["one"], RU.magic(c["code"], c["ilvl"], FIRE), 1e-9)
        check("magic exact %s: fire res >= 10 and cold res >= 10 == reference" % tag, c["two"], RU.magic(c["code"], c["ilvl"], BOTH), 1e-9)
    for c in RUL["rare"]:
        tag = "%s ilvl %d" % (c["code"], c["ilvl"])
        N = 150000
        for key, conds in (("one", FIRE), ("two", BOTH)):
            pm = RU.rare_mc(c["code"], c["ilvl"], conds, N, 4242)
            sd = math.sqrt(max(pm * (1 - pm), 1e-12) / N)
            z = (c[key] - pm) / sd
            ROWS.append(("PASS" if abs(z) < 5 else "FAIL", "rare MC %s, %d condition(s): engine vs Python game-loop simulation (%dk rolls), |z| < 5" % (tag, len(conds), N // 1000), c[key], pm,
                         "z = %.2f, sigma = %.2e" % (z, sd)))
            if abs(z) >= 5:
                FAIL.append("rare MC " + tag)
        if c["code"] != "jew":   # power of the test: the old uniform 3-6 affix count assumption is clearly distinguishable
            pu = RU.rare_mc(c["code"], c["ilvl"], FIRE, N, 4243, counts=[3, 4, 5, 6])
            su = math.sqrt(max(pu * (1 - pu), 1e-12) / N)
            info("rare MC %s: the OLD assumption (uniform 3-6 affixes) would give" % tag, pu, c["one"], "engine is %.1f sigma away from it" % ((c["one"] - pu) / su))
    # ---- socket affixes: ITEMMODS_PropertyFunc14 (count rolled 1-2 / fixed 3 / fixed 4, clamped to the base's max sockets at the item level)
    for c in RUL["sock"]:
        tag = "%s %s ilvl %d, >= %d sockets" % (c["code"], c["q"], c["ilvl"], c["min"])
        SOCK = [("sock", c["min"])]
        check("socket max %s ilvl %d == reference (gemsockets / MaxSockets by level / size)" % (c["code"], c["ilvl"]), c["maxS"], ref.max_sockets(c["code"], c["ilvl"]), 0)
        if c["q"] == "magic":
            check("socket %s: exact == reference" % tag, c["p"], RU.magic(c["code"], c["ilvl"], SOCK), 1e-9)
        else:
            N = 150000
            pm = RU.rare_mc(c["code"], c["ilvl"], SOCK, N, 4244)
            sd = math.sqrt(max(pm * (1 - pm), 1e-12) / N)
            z = (c["p"] - pm) / sd
            ROWS.append(("PASS" if abs(z) < 5 else "FAIL", "socket rare MC %s: engine vs Python game-loop simulation, |z| < 5" % tag, c["p"], pm, "z = %.2f, sigma = %.2e" % (z, sd)))
            if abs(z) >= 5:
                FAIL.append("socket rare MC " + tag)
        info("socket %s: chance" % tag, "%.6g" % c["p"], "-", "listed in statList: %s" % c["listed"])
    SKT = {(c["code"], c["q"], c["ilvl"], c["min"]): c for c in RUL["sock"]}
    sk = lambda *k: SKT[k]["p"]
    check("Monarch magic ilvl 80 (alvl 61): P(4 sockets) > 0 (Jeweler's) and P(3+) > P(4)", 1 if sk("uit", "magic", 80, 4) > 0 and sk("uit", "magic", 80, 3) > sk("uit", "magic", 80, 4) else 0, 1, 0)
    check("Monarch magic ilvl 60 (alvl 36): Jeweler's (level 55) not yet possible, P(4 sockets) = 0", sk("uit", "magic", 60, 4), 0, 0)
    check("Monarch rare: 4 sockets impossible (Jeweler's is not rare)", sk("uit", "rare", 80, 4), 0, 0)
    check("Gothic Plate magic ilvl 75: 4 sockets possible (MaxSockets2 = 4, gemsockets 4)", 1 if sk("gth", "magic", 75, 4) > 0 else 0, 1, 0)
    check("Monarch rare: 3+ sockets impossible (Artificer's is not rare)", 1 if sk("uit", "rare", 60, 2) > 0 and sk("uit", "rare", 60, 1) > 0 else 0, 1, 0)
    check("Cap (gemsockets 2) magic: 3 sockets impossible", sk("cap", "magic", 60, 3), 0, 0)
    check("Circlet ilvl 20 (MaxSockets1 = 1): 2 sockets impossible; ilvl 30 (MaxSockets2 = 2): possible",
          1 if sk("ci0", "magic", 20, 2) == 0 and sk("ci0", "rare", 20, 2) == 0 and sk("ci0", "magic", 30, 2) > 0 and sk("ci0", "rare", 30, 2) > 0 else 0, 1, 0)
    for k in (("rin", "magic", 80, 1), ("amu", "magic", 80, 1), ("rin", "rare", 80, 1), ("jew", "magic", 80, 1), ("jew", "rare", 80, 1)):
        check("%s %s: no socket affix (no inventory / not socketable): P = 0, not offered as a stat" % (k[0], k[1]), SKT[k]["p"] + (1 if SKT[k]["listed"] else 0), 0, 0)
    check("Monarch offers 'Socketed (#)' as a stat", 1 if SKT[("uit", "magic", 80, 4)]["listed"] else 0, 1, 0)
    # ---- item builder: engine vs the raw-table reference
    B = js["builder"]
    DJ = json.load(open(os.path.join(HERE, "data.json"), encoding="utf-8"))
    KEYCODE = {}
    for a in DJ["prefixes"] + DJ["suffixes"] + DJ["automagic"]:
        for m_ in a["mods"]:
            KEYCODE[m_[4]] = KEYCODE.get(m_[4], frozenset()) | {m_[0]}
    for t in ("boot", "circ", "ashd", "wand"):
        exp = sorted(c for c, r in ref.items.items() if n(r.get("spawnable")) and t in ref.item_anc(c) and n(r.get("level")) > 0 and ref.item_anc(c) and not n(r.get("quest")))
        check("builder type %s: bases == raw-table spawnable items of the type" % t, 1 if B["types"][t] == exp else 0, 1, 0, "%d engine, %d reference" % (len(B["types"][t]), len(exp)))
    check("builder tiers: boots 5 normal / 5 exceptional / 5 elite; jewelry ignores the tier", 1 if B["tiers"]["boot"] == [5, 5, 5] and B["tiers"]["amu"][0] == B["tiers"]["amu"][1] else 0, 1, 0, str(B["tiers"]))
    for e in B["appear"]:
        code, il = e["code"], e["ilvl"]
        refd = RU.appear(code, il)
        eng = {}
        for side, lvl, mods_, pm, pr, nOn, _ in e["rows"]:
            k = ({"prefix": "p", "suffix": "s", "auto": "a"}[side], lvl, len(mods_))
            eng[k] = eng.get(k, 0.0) + pm
        keys = set(k for k in refd if refd[k] > 0) | set(k for k in eng if eng[k] > 0)
        err = max([abs(eng.get(k, 0.0) - refd.get(k, 0.0)) for k in keys] or [0])
        if err > 1e-9:
            for k in sorted(keys):
                if abs(eng.get(k, 0.0) - refd.get(k, 0.0)) > 1e-9:
                    print("  appearance mismatch", code, k, eng.get(k), refd.get(k))
        check("per-affix magic appearance %s ilvl %d: %d affix rows == exact reference (max abs error)" % (code, il, len(keys)), err, 0, 0, "max abs err %.2e" % err)
        sp = sum(v for k, v in refd.items() if k[0] == "p"); ss = sum(v for k, v in refd.items() if k[0] == "s")
        info("appearance %s: sum of prefix / suffix odds" % code, "%.4f / %.4f" % (sp, ss), "-", "")
    N = 150000
    pm = RU.rare_mc("cap", 60, [("res-fire", 1)], N, 4245)
    sd = math.sqrt(max(pm * (1 - pm), 1e-12) / N + max(B["rareFire"] * (1 - B["rareFire"]), 1e-12) / 200000)
    z = (B["rareFire"] - pm) / sd
    ROWS.append(("PASS" if abs(z) < 5 else "FAIL", "per-affix rare appearance cap ilvl 60: sum over fire resist rows vs Python game-loop simulation, |z| < 5", B["rareFire"], pm, "z = %.2f" % z))
    if abs(z) >= 5:
        FAIL.append("rare appearance fire")
    for a in B["agg"]:
        tag = "boots %s, %d condition(s), act 1 Hell" % (a["q"], a["nc"])
        check("type aggregation %s: type result == sum of per-base results (max rel diff)" % tag, a["maxRel"], 0, 0, "%d sources, %.1e" % (a["rows"], a["maxRel"]))
        check("type aggregation %s: sources with a result match (%d vs %d)" % (tag, a["rows"], a["sumRows"]), a["rows"], a["sumRows"], 0)
        check("type aggregation %s: pruning impossible pools changes nothing" % tag, a["maxRelPrune"], 0, 0)
        check("type aggregation %s: per-base contributions add up to the total" % tag, a["maxBB"], 0, 0)
    # odds weighting: weighted table == sum of weight x per-base reference odds (independent Python reference of the magic split, 1e-9)
    BW = B["weights"]
    def wrows(rows):
        d = {}
        for side, lvl, nm, pm in rows:
            k = ({"prefix": "p", "suffix": "s", "auto": "a"}[side], lvl, nm)
            d[k] = d.get(k, 0.0) + pm
        return d
    refs = [RU.appear(c, BW["il"]) for c in BW["boots"]]
    keys = set(k for r in refs for k in r)
    def refmix(wts):
        tot = sum(wts)
        return {k: (sum(wi * r.get(k, 0.0) for wi, r in zip(wts, refs)) / tot if tot else 0.0) for k in keys}
    def maxerr(eng, ref):
        return max([abs(eng.get(k, 0.0) - ref.get(k, 0.0)) for k in set(eng) | set(ref)] or [0])
    check("odds weighting (boots, Hell Chaos Sanctuary, %d sources): base drop weights == perRun x chanceFor reference (max abs diff)" % BW["n"], max(abs(a - b) for a, b in zip(BW["w"], BW["wChance"])), 0, 0)
    check("odds weighting: weights sum to 1 (%d bases)" % len(BW["boots"]), sum(BW["w"]), 1, 1e-9)
    check("odds weighting: equal-weight (default) table == plain average of the per-base reference (max abs err)", maxerr(wrows(BW["equal"]), refmix([1.0] * len(refs))), 0, 0)
    check("odds weighting: area-weighted table == sum(weight x per-base reference odds) (max abs err)", maxerr(wrows(BW["weighted"]), refmix(BW["w"])), 0, 0)
    check("odds weighting: one monster (%s) weighted table == hand-computed weighted sum (max abs err)" % BW["srcName"], maxerr(wrows(BW["one"]), refmix(BW["w1"])), 0, 0)
    check("odds weighting: nobody drops there -> every odds figure is 0", max(BW["none"]), 0, 0)
    check("odds weighting: per-base odds on each row average to the table figure in equal mode", 1 if BW["pbOk"] else 0, 1, 0)
    def cvt(key, mn):
        if key == B["staffKey"]:
            return ("staff", 1, mn)     # the staff list's idx 2 skill is tier 1
        return (KEYCODE[key], mn)
    for sp in B["combos"]:
        conds = [cvt(k, mn) for k, mn in sp["conds"]]
        for q in ("magic", "rare"):
            per = sp["per"][q]
            step = 1 if len(conds) < 3 else 5
            bad = 0
            for i in range(0, len(per), step):
                code, ok, lo, hi, rq = per[i]
                rok, rlo, rhi, rrq = RU.combo(code, conds, q)
                if (ok, lo, hi, rq) != (rok, rlo, rhi, rrq):
                    bad += 1; print("  builder mismatch", sp["name"], q, code, (ok, lo, hi, rq), (rok, rlo, rhi, rrq))
            check("builder levels, %s (%s): ok / lowest item level / last item level / required level per base == brute-force reference (%d bases)" % (sp["name"], q, len(range(0, len(per), step))), bad, 0, 0)
            if per and per[0][1]:
                info("builder %s (%s)" % (sp["name"], q), "ilvl %s-%s, req %s" % (per[0][2], per[0][3], per[0][4]), "-", "first base %s" % per[0][0])
    CB = {c["name"]: c["an"] for c in B["combos"]}
    check("2 prefixes (fire + cold resist, boots): fits a magic? no (1 prefix) -> rare only", 1 if (CB["boots fire30 + cold20 (2 prefixes)"]["magic"] is False and CB["boots fire30 + cold20 (2 prefixes)"]["rare"]) else 0, 1, 0)
    check("3 prefixes (boots): rare only, with an explanation for magic", 1 if (not CB["boots ED30 + cold20 + fire20 (3 prefixes)"]["magic"] and CB["boots ED30 + cold20 + fire20 (3 prefixes)"]["rare"] and CB["boots ED30 + cold20 + fire20 (3 prefixes)"]["why"]["magic"]) else 0, 1, 0)
    check("Jeweler's (Monarch, 4 sockets): magic only", 1 if (CB["monarch sockets 4"]["magic"] and not CB["monarch sockets 4"]["rare"]) else 0, 1, 0)
    check("Chromatic-class automagic (auric shield, group 304): offered on magic, never on rare", 1 if (B["chromatic"]["magic"] > 0 and B["chromatic"]["rare"] == 0) else 0, 1, 0, str(B["chromatic"]))
    check("lower-is-better condition (le): -30 <= -20 holds, -30 >= -20 does not", B["le"]["reqLe"] + 10 * B["le"]["reqGe"], 1, 0)
    check("old deep link ?q2=Monarch&ql=magic&c=Socketed (#):4 resolves in the page: magic result, rare impossible", 1 if ("Magic" in js["deeplink"] and "77" in js["deeplink"] and "not possible" in js["deeplink"] and "sources" in js["deeplink"]) else 0, 1, 0, js["deeplink"][:160].replace(chr(10), " "))
    # ---- low / normal / superior items: sockets, ethereal, superior bonus (independent reference from the raw tables and the D2MOO rules) ----
    WH = js["white"]
    class White:
        """Written from the research notes (D2MOO Items.cpp sub_6FC4D6B0 / ITEMS_MakeEthereal, ItemsMagic.cpp sub_6FC54690, ItemMods.cpp ITEMMODS_CanItemBeHighQuality), reading the raw .txt tables."""
        SOCK_CHANCE, ETH_CHANCE, DIFF_CAP = 0.33, 0.05, (3, 4, 6)
        QI = rd("qualityitems")
        OWN = {"shie": "shield", "scep": "scepter", "wand": "wand", "staf": "staff", "bow": "bow", "xbow": "bow", "boot": "boots", "glov": "gloves", "belt": "belt"}
        PROP = {"ar": "att", "dm": "dmg%", "ed": "ac%", "dur": "dur%"}

        def __init__(self, ref, rules):
            self.ref, self.rules = ref, rules

        def sock_dist(self, code, q, ilvl, diff):
            r = self.ref.items[code]
            N = 0
            if q in ("normal", "sup") and not n(r.get("stackable")):
                N = min(self.ref.max_sockets(code, ilvl), self.DIFF_CAP[diff])
            if N <= 0:
                return [1.0]
            return [1 - self.SOCK_CHANCE] + [self.SOCK_CHANCE / N] * N

        def eth_ok(self, code):
            r = self.ref.items[code]
            if r["_f"] == "misc":
                return False
            return n(r.get("durability")) > 0 and n(r.get("nodurability")) != 1     # ITEMS_HasDurability; bows and crossbows are nodurability

        def eth_p(self, code, q):
            return self.ETH_CHANCE if q in ("normal", "sup", "magic", "rare", "unique", "crafted") and self.eth_ok(code) else 0.0

        def sup_rows(self, code):
            r = self.ref.items[code]
            if r["_f"] == "misc":
                return []
            anc = self.ref.item_anc(code)
            first = r["type"]
            col = self.OWN.get(first)
            thr = n(self.ref.types[first].get("Throwable"))
            cnt = 4 if (thr or n(r.get("nodurability"))) else len(self.QI)
            out = []
            for i in range(cnt):
                row = self.QI[i]
                if col:
                    ok = n(row[col]) == 1
                elif "weap" in anc:
                    ok = n(row["weapon"]) == 1
                elif "armo" in anc:
                    ok = n(row["armor"]) == 1
                else:
                    ok = False
                if ok:
                    out.append(i)
            return out

        @staticmethod
        def ge(mn, mx, m):
            return 1.0 if m <= mn else 0.0 if m > mx else (mx - m + 1) / (mx - mn + 1)

        def prob(self, code, q, ilvl, diff, conds):
            """conds: ('sock', m) ('eth', 1) ('ed'|'dm'|'ar'|'dur', m) ('auto', property, m) ('auto2', prop1, m1, prop2, m2); all sources independent"""
            sd = self.sock_dist(code, q, ilvl, diff)
            p = 1.0
            sup = [c for c in conds if c[0] in self.PROP]
            for c in conds:
                if c[0] == "sock":
                    p *= sum(sd[k] for k in range(len(sd)) if k >= c[1])
                elif c[0] == "eth":
                    p *= self.eth_p(code, q)
            if sup:
                rows = self.sup_rows(code) if q == "sup" else []
                if not rows:
                    return 0.0
                tot = 0.0
                for i in rows:
                    row = self.QI[i]
                    mods = [(row["mod%dcode" % k], n(row["mod%dmin" % k]), n(row["mod%dmax" % k])) for k in (1, 2) if row.get("mod%dcode" % k)]
                    pr = 1.0
                    for c in sup:
                        best = 0.0
                        for code_, mn, mx in mods:
                            if code_ == self.PROP[c[0]]:
                                best = max(best, self.ge(mn, mx, c[1]))
                        pr *= best
                    tot += pr / len(rows)
                p *= tot
            au = [c for c in conds if c[0] in ("auto", "auto2")]
            if au:
                pool = self.rules.pool(code, self.rules.alvl(code, ilvl), False, ilvl)["a"]
                W = sum(a["w"] for a in pool)
                tot = 0.0
                for a in pool:
                    pr = 1.0
                    for c in au:
                        pairs = [(c[1], c[2])] if c[0] == "auto" else [(c[1], c[2]), (c[3], c[4])]
                        for pc, pm in pairs:
                            pr *= self.rules.cond_p(a, [(pc, pm)])[0]
                    tot += a["w"] / W * pr
                p *= tot
            return p

    WHR = White(ref, RU)
    for c in WH["cases"]:
        conds = [tuple(x) for x in c["conds"]]
        want = WHR.prob(c["code"], c["q"], c["ilvl"], c["diff"], conds)
        check("white/superior: %s: engine == independent reference" % c["name"], c["p"], want, 1e-9)
    CASE = {c["name"]: c["p"] for c in WH["cases"]}
    # closed forms from the rules
    check("white Monarch Hell ilvl 60: P(4 sockets) = 0.33 * 1/4", CASE["Monarch normal ilvl 60 Hell sockets >= 4"], 0.33 / 4, 1e-12)
    check("white Monarch Hell ilvl 85: P(4 sockets) = 0.33 * 1/4 (same as ilvl 60)", CASE["Monarch normal ilvl 85 Hell sockets >= 4"], 0.33 / 4, 1e-12)
    check("white Monarch Hell ilvl 30 (max 3): P(3 sockets) = 0.33 / 3", CASE["Monarch normal ilvl 30 Hell sockets >= 3"], 0.33 / 3, 1e-12)
    check("white Monarch Hell ilvl 30: P(4 sockets) = 0", CASE["Monarch normal ilvl 30 Hell sockets >= 4"], 0)
    check("white Monarch Nightmare ilvl 60 (cap 4): P(4 sockets) = 0.33 / 4", CASE["Monarch normal ilvl 60 Nightmare sockets >= 4"], 0.33 / 4, 1e-12)
    check("white Monarch Normal difficulty (cap 3): P(3 sockets) = 0.33 / 3", CASE["Monarch normal ilvl 85 Normal sockets >= 3"], 0.33 / 3, 1e-12)
    check("white Monarch Normal difficulty (cap 3): P(4 sockets) = 0", CASE["Monarch normal ilvl 85 Normal sockets >= 4"], 0)
    check("white Monarch: P(socketed) = 0.33 flat", CASE["Monarch normal ilvl 60 Hell sockets >= 1"], 0.33, 1e-12)
    check("low quality Monarch is never socketed", CASE["Monarch low ilvl 60 Hell sockets >= 1"], 0)
    check("superior Monarch: P(4 sockets) = 0.33 / 4", CASE["Monarch superior ilvl 60 Hell sockets >= 4"], 0.33 / 4, 1e-12)
    for cde in ("lbt", "lgl", "mbl", "jav", "tkf", "amu", "rin"):
        check("%s (%s) is never socketed as a white item (no inventory / stackable / jewelry)" % (cde, ref.items[cde]["type"]), CASE["%s (no sockets possible) normal ilvl 85 Hell sockets >= 1" % cde], 0)
    hi0 = [c_ for c_, r_ in ref.items.items() if r_["_f"] != "misc" and n(r_.get("hasinv")) and not n(r_.get("gemsockets")) and n(r_.get("spawnable"))]
    info("bases with an inventory but gemsockets 0 (never socketed white / magic)", len(hi0), "-", ", ".join(hi0[:6]))
    check("combined P(ethereal and 4 sockets | white Monarch ilvl 60 Hell) = 0.05 * 0.33 / 4", CASE["Monarch normal ilvl 60 Hell sockets >= 4 and ethereal"], 0.05 * 0.33 / 4, 1e-12)
    for q in ("normal", "sup", "magic", "rare"):
        check("ethereal 5%% on a %s Monarch" % q, CASE["Monarch %s ethereal" % q], 0.05, 1e-12)
        check("ethereal 0 on a %s Short Bow (bows are never ethereal)" % q, CASE["Short Bow sbw %s ethereal" % q], 0)
    check("low quality Monarch is never ethereal", CASE["Monarch low ethereal"], 0)
    check("low quality bow is never ethereal", CASE["Short Bow sbw low ethereal"], 0)
    for cde in ("lxb", "am1"):
        check("%s (crossbow / Amazon bow) is never ethereal" % ref.items[cde]["type"], CASE["%s normal ethereal" % cde], 0)
    check("Phase Blade (nodurability) is never ethereal", CASE["7cr normal ethereal"], 0)
    check("amulet is never ethereal", CASE["amu normal ethereal"], 0)
    check("javelin (durability, nodurability unset) follows the code rule: 5%", CASE["jav normal ethereal"], 0.05, 1e-12)
    for k_, v_ in WH["ethChance"].items():
        check("ethChance(Monarch, %s) = %s" % (k_, "5%" if k_ in ("normal", "sup", "magic", "rare", "unique") else "0 (never)"), v_, 0.05 if k_ in ("normal", "sup", "magic", "rare", "unique") else 0, 1e-12)
    ethmis = [c_ for c_, e_ in WH["ethList"].items() if bool(e_) != WHR.eth_ok(c_)]
    check("ethereal-eligible bases: engine == raw-table rule for all %d weapons and armor (mismatches)" % len(WH["ethList"]), len(ethmis), 0, 0, ", ".join(ethmis[:8]))
    ethby = {}
    for c_, e_ in WH["ethList"].items():
        t_ = ref.items[c_]["type"]
        ethby.setdefault(t_, [0, 0])[0 if e_ else 1] += 1
    info("ethereal-eligible item types (bases eligible / not)", len([t_ for t_, v_ in ethby.items() if v_[0]]), "-", "; ".join("%s %d/%d" % (t_, v_[0], v_[1]) for t_, v_ in sorted(ethby.items()) if v_[0] or v_[1]))
    # superior bonus rows
    check("superior armor (Monarch): P(+% Enhanced Defense) = 2/3", CASE["Monarch (armor) superior +% enhanced defense >= 1"], 2 / 3, 1e-12)
    check("superior weapon (Long Sword): P(+% Enhanced Damage) = 1/2", CASE["Long Sword superior +% enhanced damage >= 1"], 1 / 2, 1e-12)
    check("superior bow (Short Bow): P(+% Enhanced Damage) = 2/3 (rows 1 and 3 of {0, 1, 3})", CASE["Short Bow superior +% enhanced damage >= 1"], 2 / 3, 1e-12)
    check("superior armor: P(ED >= 15) = (2/3) * (1/11)", CASE["Monarch superior enhanced defense >= 15"], (2 / 3) / 11, 1e-12)
    check("superior bow: no durability bonus (first 4 rows only)", CASE["Short Bow superior max durability >= 10"], 0)
    check("superior Phase Blade (nodurability): no durability bonus", CASE["Phase Blade superior max durability >= 10"], 0)
    check("superior javelin (throwable): no durability bonus", CASE["Javelin superior max durability >= 10"], 0)
    check("superior Long Sword: attack rating AND enhanced damage together = row 3 = 1/6", CASE["Long Sword superior attack rating >= 1 and enhanced damage >= 5"], 1 / 6, 1e-12)
    check("superior armor: ED >= 5 AND durability >= 10 = row 7 = 1/3", CASE["Monarch superior enhanced defense >= 5 and durability >= 10"], 1 / 3, 1e-12)
    check("superior: three bonuses never come together (rows carry at most 2 mods): level check says not possible", 1 if WH["levels"]["threeRows"]["sup"] else 0, 0)
    check("automagic on white / low / superior Paladin shields: same odds, equal to the reference pool", abs(CASE["pa5 low All Resistances >= 35 (automagic)"] - CASE["pa5 sup All Resistances >= 35 (automagic)"]) + abs(CASE["pa5 normal All Resistances >= 35 (automagic)"] - CASE["pa5 sup All Resistances >= 35 (automagic)"]), 0, 0)
    # low quality staff mods are always +1
    SL = WH["staffLow"]
    sref1 = RU.staff("wnd", SL["ilvl"], SL["idx"], 1)
    check("low quality wand: P(tier-5 staff skill) == reference (%s)" % SL["key"], SL["one"], sref1, 1e-9)
    check("low quality wand: staff skill values are always +1: P(+2 or more) = 0", SL["two"], 0)
    check("normal wand: P(staff skill >= +2) == reference", SL["normalTwo"], RU.staff("wnd", SL["ilvl"], SL["idx"], 2), 1e-9)
    check("magic wand: P(staff skill >= +1) == reference (no automagic on wands interferes)", SL["magicOne"], RU.staff("wnd", SL["ilvl"], SL["idx"], 1), 1e-9)
    check("magic wand: P(staff skill >= +2) == reference", SL["magicTwo"], RU.staff("wnd", SL["ilvl"], SL["idx"], 2), 1e-9)
    ROWS.append(("PASS" if SL["one"] > 0 else "FAIL", "low quality wand gets staff skills at all (P > 0)", SL["one"], ">0", ""))
    if not SL["one"] > 0: FAIL.append("low staff")
    # per kill: the search result for a real source equals P(base quality) x the rule
    PK = WH["perKill"]
    def base_q(code, tc, mlvl):
        tot = {"normal": 0.0, "sup": 0.0, "base": 0.0}
        for (kind, cd, f), p in ref.dist(tc, mlvl, 1).items():
            if kind != "i" or cd != code:
                continue
            qq = ref.quality(code, mlvl, 0, f)
            rem = 1.0 - qq["unique"] - qq["set"] - qq["rare"] - qq["magic"]
            row = ref.ratio_row(code)
            q_ = n(ref.items[code]["level"])
            ph = ref.succ(n(row["HiQuality"]), n(row["HiQualityDivisor"]), None, q_, mlvl, None, None, 0)
            pn = ref.succ(n(row["Normal"]), n(row["NormalDivisor"]), None, q_, mlvl, None, None, 0)
            hq = rem * ph
            tot["sup"] += p * hq
            tot["normal"] += p * (rem - hq) * pn
            tot["base"] += p
        return tot
    bq = base_q("uit", PK["tc"], PK["mlvl"])
    check("per kill (%s, %s): P(normal Monarch) engine == reference" % (PK["name"], PK["tc"]), PK["normal"], bq["normal"], 1e-9)
    check("per kill: P(superior Monarch) engine == reference", PK["sup"], bq["sup"], 1e-9)
    check("per kill: P(white Monarch with >= 4 sockets) = P(Monarch normal) * 0.33 / 4", PK["n4"], bq["normal"] * 0.33 / 4, 1e-9)
    check("per kill: P(superior Monarch with >= 4 sockets) = P(Monarch superior) * 0.33 / 4", PK["s4"], bq["sup"] * 0.33 / 4, 1e-9)
    check("per kill: P(white Monarch, 4 sockets, ethereal) = P(normal) * 0.33 / 4 * 0.05", PK["n4e"], bq["normal"] * 0.33 / 4 * 0.05, 1e-9)
    check("per kill: low quality Monarch never socketed (search finds nothing)", PK["l1"], 0)
    check("per kill: P(ethereal magic Monarch) = P(magic Monarch) * 0.05", PK["me"], PK["magic"] * 0.05, 1e-9)
    # feasibility / levels
    LV = WH["levels"]
    check("Monarch with 4 sockets (Hell): possible as normal, superior, magic; not low, not rare", 1 if (LV["sock4"]["normal"] and LV["sock4"]["sup"] and LV["sock4"]["magic"] and not LV["sock4"]["low"] and not LV["sock4"]["rare"]) else 0, 1, 0, str(LV["sock4Il"]))
    check("Monarch 4 sockets: white at item level 72 (elite base level), magic at 77 (Jeweler's affix level 55)", 1 if (LV["sock4Il"]["normal"][0] == 72 and LV["sock4Il"]["sup"][0] == 72 and LV["sock4Il"]["magic"][0] == 77) else 0, 1, 0)
    check("Monarch 4 sockets in Normal difficulty: white impossible (cap 3), magic still possible", 1 if (not LV["sock4Normal"]["normal"] and not LV["sock4Normal"]["sup"] and LV["sock4Normal"]["magic"]) else 0, 1, 0)
    check("Monarch 3 sockets in Normal difficulty: white possible", 1 if (LV["sock3Normal"]["normal"] and LV["sock3Normal"]["sup"]) else 0, 1, 0)
    check("ethereal bow: impossible at every quality", sum(1 for v_ in LV["ethBow"].values() if v_), 0)
    check("ethereal Monarch: not low quality", 1 if (not LV["ethMonarch"]["low"] and LV["ethMonarch"]["normal"]) else 0, 1, 0)
    check("rings are never normal / superior / low: socket condition impossible in every quality", sum(1 for v_ in LV["ringSock"].values() if v_), 0)
    check("ED >= 5 and max durability >= 10 on a Monarch: only a superior item (row 7)", 1 if (LV["edDur"]["sup"] and not LV["edDur"]["normal"] and not LV["edDur"]["magic"]) else 0, 1, 0)
    # known facts
    FA = WH["facts"]
    def fact(name, ok, note=""):
        ROWS.append(("PASS" if ok else "FAIL", "known fact: " + name, 1 if ok else 0, 1, note))
        if not ok: FAIL.append("fact " + name)
    fact("a magic Monarch with Jeweler's can have 4 sockets", FA["jewelerMagic4"] > 0, "P = %.5f at item level 85" % FA["jewelerMagic4"])
    fact("a rare Monarch gets at most 2 sockets (from affixes): P(>= 1) > 0, P(>= 3) = 0", FA["rareSock1"] > 0 and FA["rareSock3"] == 0, "P(>= 1) = %.4f" % FA["rareSock1"])
    fact("socketed white and superior bases drop (Monarch, sources found: %d / %d)" % (FA["whiteDrops"]["normalSock"], FA["whiteDrops"]["supSock"]), FA["whiteDrops"]["normalSock"] > 0 and FA["whiteDrops"]["supSock"] > 0)
    fact("no ethereal set items (ethChance(set) = 0, 'Ethereal' row offers no set quality)", WH["ethChance"]["set"] == 0 and "set" not in FA["ethSetQuals"])
    fact("bows and crossbows (incl. Amazon bows) can never be ethereal (Stag Bow, Short Bow, Light Crossbow: P = 0 at every quality; the Bow type offers no Ethereal row)", all(FA["bowEth"][c_][q_] == 0 for c_ in FA["bowEth"] for q_ in FA["bowEth"][c_]) and not FA["bowEthRow"] and FA["monarchEthRow"], str(FA["bowEth"]["am1"]))
    fact("Chromatic never on a rare Paladin shield (0 of %d bases), but on magic ones (%d)" % (FA["chromatic"]["bases"], FA["chromatic"]["magic"]), FA["chromatic"]["rare"] == 0 and FA["chromatic"]["magic"] == FA["chromatic"]["bases"])
    fact("Archer's / Lancer's never on rare Amazon weapons (0 of %d), but on magic ones (%d)" % (FA["archer"]["bases"], FA["archer"]["magic"]), FA["archer"]["rare"] == 0 and FA["archer"]["magic"] == FA["archer"]["bases"])
    fact("of Anthrax never on rare Necromancer heads (0 of %d), but on magic ones (%d)" % (FA["anthrax"]["bases"], FA["anthrax"]["magic"]), FA["anthrax"]["rare"] == 0 and FA["anthrax"]["magic"] == FA["anthrax"]["bases"])
    fact("Great Wyrm's / of the Colossus never on rare orbs (0 of %d), but on magic ones (%d); Wyrm's is allowed on rares (%d)" % (FA["orbs"]["bases"], FA["orbs"]["magic"], FA["orbs"]["wyrmRare"]), FA["orbs"]["rare"] == 0 and FA["orbs"]["magic"] == FA["orbs"]["bases"] and FA["orbs"]["wyrmRare"] == FA["orbs"]["bases"])
    fact("an orb cannot have both a life and a mana automagic (P both = 0; each alone > 0)", FA["orbLifeMana"]["both"] == 0 and FA["orbLifeMana"]["life"] > 0 and FA["orbLifeMana"]["mana"] > 0, "life %.3f, mana %.3f" % (FA["orbLifeMana"]["life"], FA["orbLifeMana"]["mana"]))
    fact("Paladin shield automagic Knight's gives both +Attack Rating and +Enhanced Damage in one row, and is allowed on rares", FA["knight"]["rareRow"] == [["+# to Attack Rating", "+#% Enhanced Damage"]] and FA["knight"]["normalBoth"] > 0 and FA["knight"]["rareBoth"] > 0, "P(both | normal) = %.4f" % FA["knight"]["normalBoth"])
    for k_, G_ in FA["groups"].items():
        fact("%s: merged champion / unique / minion / herald rows have the same per-kill odds as each member (Hell, Monarch; %d raw rows -> %d merged, %d member checks)" % (k_, G_["rawGroupable"], G_["grouped"], G_["members"]),
             G_["members"] > 0 and G_["worst"] < 1e-9 and abs(G_["totRaw"] - G_["totGrp"]) <= 1e-9 * max(G_["totRaw"], 1e-300), "worst rel diff %.2g, per-run total %.6g vs %.6g" % (G_["worst"], G_["totRaw"], G_["totGrp"]))
    G_ = FA["groups"]["noTz"]
    fact("Drifter Cavern (Hell): one 'Champion monsters' row and one 'Unique monsters' row (was %d champion rows)" % G_["drifterChampRaw"], G_["drifterChamp"] == 1 and G_["drifterUnique"] == 1 and G_["drifterChampRaw"] > 1)
    G_ = FA["groups"]["tz"]
    fact("terror zone Blood Moor (Hell): heralds merged into one row (was %d)" % G_["bloodMoorHeraldRaw"], G_["bloodMoorHerald"] == 1 and G_["bloodMoorHeraldRaw"] > 1)
    H_ = FA["heraldTiers"]
    fact("All tiers: Blood Moor (Hell) lists Herald tier 1-5, each equal to that tier's per-monster herald (Flame Rift)", H_["names"] == ["Herald tier %d" % t for t in range(1, 6)] and H_["worst"] < 1e-9, " / ".join("%.3g" % x for x in H_["p"]))
    T_ = FA["talTombs"]
    fact("the seven identical Tal Rasha's Tombs (66-72) are listed once, as area 66; no other area is a copy (copies %s)" % T_["dupOf"], T_["dupOf"] == [[k, 66] for k in range(67, 73)] and T_["areas"] == [66] and T_["maxRowsPerMon"] == 1, "areas %s, rows per monster %s" % (T_["areas"], T_["maxRowsPerMon"]))
    fact("Mephisto (Hell) drops Harlequin Crest", FA["drops"]["hc"] > 0, "1 in %.0f" % (1 / FA["drops"]["hc"]))
    fact("Andariel (Hell) drops Talic's Anguish (ua1)", FA["drops"]["ua1"] > 0, "1 in %.1f" % (1 / FA["drops"]["ua1"]))
    fact("the Summoner (Hell) drops the Key of Hate (pk2)", FA["drops"]["pk2"] > 0, "1 in %.1f" % (1 / FA["drops"]["pk2"]))
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
