#!/usr/bin/env python3
"""Parse D2R excel tables into a compact data.json for the drop calculator.

Usage:  python build.py [path-to-excel-folder] [output.json]
Default folder: C:\\Users\\thein\\D2R-excel   Default output: data.json (next to this script)
Only the Python standard library is used. Input files are only read.
"""
import json
import os
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\thein\D2R-excel"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")


def rd(name):
    """Read a tab separated table -> list of dicts (header names as keys)."""
    path = os.path.join(SRC, name + ".txt")
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = [l.rstrip("\r\n").split("\t") for l in f]
    head = lines[0]
    rows = []
    for l in lines[1:]:
        if not l or not l[0].strip():
            continue
        d = {}
        for i, h in enumerate(head):
            if h and i < len(l) and l[i] != "":
                d[h] = l[i]
        rows.append(d)
    return rows


def num(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default


# ----------------------------------------------------------------- item types
types_rows = rd("itemtypes")
types = {}
for r in types_rows:
    code = r.get("Code")
    if not code:
        continue
    types[code] = {
        "n": r.get("ItemType", code),
        "eq": [r[k] for k in ("Equiv1", "Equiv2") if k in r],
        "rare": num(r.get("Rare")),
        "magic": num(r.get("Magic")),
        "normal": num(r.get("Normal")),
        "tc": num(r.get("TreasureClass")),
        "cls": r.get("Class", ""),
    }


def ancestors(code, seen=None):
    seen = seen if seen is not None else []
    if code in seen or code not in types:
        return seen
    seen.append(code)
    for p in types[code]["eq"]:
        ancestors(p, seen)
    return seen


# --------------------------------------------------------------------- items
items = {}
for fname, kind in (("armor", "a"), ("weapons", "w"), ("misc", "m")):
    for r in rd(fname):
        code = r.get("code")
        if not code:
            continue
        t = r.get("type", "")
        anc = list(ancestors(t))
        if r.get("type2"):
            anc += [x for x in ancestors(r["type2"]) if x not in anc]
        own = types.get(t, {})
        # Rare / Magic flags are read from the item's own type row (the 'misc' row has Rare=1
        # which must not leak to charms); Normal is inherited (gems, potions, ...) unless overridden.
        can_rare = bool(own.get("rare"))
        always_magic = bool(own.get("magic"))
        always_normal = bool(own.get("normal")) or (
            any(types[a]["normal"] for a in anc if a in types) and not (own.get("magic") or own.get("rare")))
        cls_specific = "clas" in anc
        tier = 0
        if kind != "m":
            if r.get("ubercode") == code:
                tier = 1
            elif r.get("ultracode") == code:
                tier = 2
        it = {
            "n": r.get("name", code).strip(),
            "k": kind,
            "t": t,
            "anc": anc,
            "q": num(r.get("level")),
            "r": num(r.get("rarity")),
            "sp": num(r.get("spawnable")),
            "ml": num(r.get("magic lvl")),
            "tier": tier,
            "cr": 1 if can_rare else 0,
            "am": 1 if always_magic else 0,
            "an": 1 if always_normal else 0,
            "cs": 1 if cls_specific else 0,
            "ap": num(r.get("auto prefix"), 0) if r.get("auto prefix") else 0,
            "ver": num(r.get("version"), 0),
        }
        if r.get("type2"):
            it["t2"] = r["type2"]
        # jewels hold at most 4 affixes (CONFIG in engine), nothing needed here
        items[code] = it

# ------------------------------------------------------------ treasure classes
tcs = {}
tc_order = []
for r in rd("treasureclassex"):
    name = r.get("Treasure Class")
    if not name:
        continue
    ents = []
    for i in range(1, 11):
        it = r.get("Item%d" % i)
        pr = r.get("Prob%d" % i)
        if it:
            ents.append([it.strip().strip('"'), num(pr, 0)])
    tc = {
        "g": num(r.get("group")),
        "l": num(r.get("level")),
        "p": num(r.get("Picks"), 1) if r.get("Picks") not in (None, "") else 1,
        "u": num(r.get("Unique")),
        "s": num(r.get("Set")),
        "r": num(r.get("Rare")),
        "m": num(r.get("Magic")),
        "nd": num(r.get("NoDrop")),
        "e": ents,
    }
    if r.get("firstLadderSeason"):
        tc["fl"] = num(r["firstLadderSeason"])
    if r.get("lastLadderSeason"):
        tc["ll"] = num(r["lastLadderSeason"])
    if r.get("ConditionCalc"):
        tc["cc"] = r["ConditionCalc"]
    tcs[name] = tc
    tc_order.append(name)

# group -> sorted list of (level, name) preserving file order
groups = {}
for n in tc_order:
    g = tcs[n]["g"]
    if g:
        groups.setdefault(str(g), []).append([tcs[n]["l"], n])
for g in groups:
    groups[g].sort(key=lambda x: x[0])

# --------------------------------------------------------------------- levels
levels = {}
for r in rd("levels"):
    lid = num(r.get("Id"), -1)
    if lid <= 0:
        continue

    def trio(base):
        return [num(r.get(base)), num(r.get(base + "(N)")), num(r.get(base + "(H)"))]

    def sz(base):
        return [num(r.get(base)), num(r.get(base + "(N)"), num(r.get(base))), num(r.get(base + "(H)"), num(r.get(base)))]

    monl = trio("MonLvlEx")
    levels[str(lid)] = {
        "name": r.get("LevelName") or r.get("Name", str(lid)),
        "act": num(r.get("Act")) + 1,
        "lvl": monl,
        "sx": sz("SizeX"),
        "sy": sz("SizeY"),
        "den": trio("MonDen"),
        "umin": [num(r.get("MonUMin")), num(r.get("MonUMin(N)")), num(r.get("MonUMin(H)"))],
        "umax": [num(r.get("MonUMax")), num(r.get("MonUMax(N)")), num(r.get("MonUMax(H)"))],
        "num": num(r.get("NumMon")),
        "mon": [r["mon%d" % i] for i in range(1, 26) if r.get("mon%d" % i)],
        "nmon": [r["nmon%d" % i] for i in range(1, 26) if r.get("nmon%d" % i)],
        "umon": [r["umon%d" % i] for i in range(1, 26) if r.get("umon%d" % i)],
        "wp": 1 if r.get("Waypoint") and num(r.get("Waypoint"), 255) < 255 else 0,
    }

# ------------------------------------------------------------------- monsters
monsters = {}
TCCOLS = [("TreasureClass", "tc"), ("TreasureClassChamp", "ch"), ("TreasureClassUnique", "un"),
          ("TreasureClassDesecrated", "dtc"), ("TreasureClassDesecratedChamp", "dch"),
          ("TreasureClassDesecratedUnique", "dun")]
for r in rd("monstats"):
    mid = r.get("Id")
    if not mid:
        continue
    m = {
        "n": r.get("NameStr", mid),
        "lv": [num(r.get("Level")), num(r.get("Level(N)")), num(r.get("Level(H)"))],
        "boss": num(r.get("boss")),
        "nr": num(r.get("noRatio")),
        "sp": num(r.get("isSpawn")),
        "kill": num(r.get("killable")),
        "rar": num(r.get("Rarity")),
        "g": [num(r.get("MinGrp"), 1), num(r.get("MaxGrp"), 1)],
        "pm": [num(r.get("PartyMin")), num(r.get("PartyMax"))],
        "npc": num(r.get("npc")),
        "en": num(r.get("enabled")),
    }
    tc = [{}, {}, {}]
    for col, key in TCCOLS:
        for d, suf in enumerate(("", "(N)", "(H)")):
            v = r.get(col + suf)
            if v:
                tc[d][key] = v
    m["tc"] = tc
    monsters[mid] = m

# ---------------------------------------------------------------- superuniques
su = []
for r in rd("superuniques"):
    name = r.get("Superunique")
    if not name or not r.get("Class") or not r.get("TC(H)") and not r.get("TC"):
        continue
    su.append({
        "id": name,
        "n": r.get("Name", name),
        "cls": r["Class"],
        "tc": [r.get("TC", ""), r.get("TC(N)", ""), r.get("TC(H)", "")],
        "dtc": [r.get("TC Desecrated", ""), r.get("TC(N) Desecrated", ""), r.get("TC(H) Desecrated", "")],
    })

# Where each boss / superunique lives (level Id from levels.txt). levels.txt has no such column,
# so this table is hand-written from game knowledge: EDIT here if something is wrong.
SU_AREA = {
    "Bishibosh": 3, "Bonebreak": 18, "Coldcrow": 9, "Rakanishu": 4, "Treehead WoodFist": 5,
    "Griswold": 38, "The Countess": 25, "Pitspawn Fouldog": 29, "Flamespike the Crawler": 15,
    "Boneash": 33, "The Smith": 28, "Corpsefire": 8,
    "Radament": 49, "Bloodwitch the Wild": 60, "Fangskin": 61, "Beetleburst": 43, "Leatherarm": 59,
    "Coldworm the Burrower": 64, "Fire Eye": 54, "Dark Elder": 44, "The Summoner": 74,
    "Ancient Kaa the Soulless": 65,
    "Web Mage the Burning": 85, "Witch Doctor Endugu": 91, "Stormtree": 89, "Sarina the Battlemaid": 81,
    "Icehawk Riftwing": 93, "Ismail Vilehand": 83, "Geleb Flamefinger": 83, "Bremm Sparkfist": 83,
    "Toorc Icefist": 83, "Wyand Voidfinger": 83, "Maffer Dragonhand": 83,
    "Winged Death": 107, "The Tormentor": 107, "Taintbreeder": 106, "Riftwraith the Cannibal": 106,
    "Infector of Souls": 108, "Lord De Seis": 108, "Grand Vizier of Chaos": 108,
    "The Cow King": 39, "The Feature Creep": 107,
    "Siege Boss": 128, "Axe Dweller": 118, "Bonesaw Breaker": 113, "Dac Farren": 111,
    "Megaflow Rectifier": 113, "Eyeback Unleashed": 111, "Threash Socket": 129, "Pindleskin": 121,
    "Snapchip Shatter": 119, "Anodized Elite": 115, "Vinvear Molech": 116, "Sharp Tooth Sayer": 112,
    "Magma Torquer": 114, "Blaze Ripper": 117, "Frozenstein": 118, "Nihlathak Boss": 124,
}
BOSS_AREA = {  # monstats Id -> level Id (these use their own monstats Level, not the area's)
    "andariel": 37, "duriel": 73, "mephisto": 102, "diablo": 108, "baalcrab": 132,
    "summoner": 74, "radament": 49, "izual": 105, "bloodraven": 17, "griswold": 38, "nihlathakboss": 124,
}
# the three "Fighting Act 5 mini bosses" etc are intentionally skipped.

# ------------------------------------------------------ uniques / sets / sets
uniques = []
for r in rd("uniqueitems"):
    if not r.get("index") or not r.get("code"):
        continue
    uniques.append({
        "id": r["index"],
        "code": r["code"],
        "lvl": num(r.get("lvl")),
        "r": num(r.get("rarity"), 1),
        "sp": num(r.get("spawnable")),
        "dis": num(r.get("disabled")),
        "ver": num(r.get("version")),
        "fl": num(r.get("firstLadderSeason")),
        "ll": num(r.get("lastLadderSeason")),
        "lr": num(r.get("lvl req")),
        "dc": r.get("DropConditionCalc", ""),
    })
setitems = []
for r in rd("setitems"):
    if not r.get("index") or not r.get("item"):
        continue
    setitems.append({
        "id": r["index"],
        "code": r["item"],
        "set": r.get("set", ""),
        "lvl": num(r.get("lvl")),
        "r": num(r.get("rarity"), 1),
        "sp": num(r.get("spawnable")),
        "dis": num(r.get("disabled")),
        "fl": num(r.get("firstLadderSeason")),
        "ll": num(r.get("lastLadderSeason")),
        "lr": num(r.get("lvl req")),
        "dc": r.get("DropConditionCalc", ""),
    })

# -------------------------------------------------------------------- item ratio
ratio = []
for r in rd("itemratio"):
    ratio.append({
        "ver": num(r.get("Version")), "uber": num(r.get("Uber")), "cls": num(r.get("Class Specific")),
        "u": [num(r.get("Unique")), num(r.get("UniqueDivisor"), 1), num(r.get("UniqueMin"))],
        "s": [num(r.get("Set")), num(r.get("SetDivisor"), 1), num(r.get("SetMin"))],
        "r": [num(r.get("Rare")), num(r.get("RareDivisor"), 1), num(r.get("RareMin"))],
        "m": [num(r.get("Magic")), num(r.get("MagicDivisor"), 1), num(r.get("MagicMin"))],
        "h": [num(r.get("HiQuality")), num(r.get("HiQualityDivisor"), 1)],
        "n": [num(r.get("Normal")), num(r.get("NormalDivisor"), 1)],
    })

# ---------------------------------------------------------------- properties
SKILLTABS = {
    0: "Bow and Crossbow", 1: "Passive and Magic", 2: "Javelin and Spear",
    3: "Fire", 4: "Lightning", 5: "Cold",
    6: "Curses", 7: "Poison and Bone", 8: "Summoning",
    9: "Combat", 10: "Offensive Auras", 11: "Defensive Auras",
    12: "Combat", 13: "Combat Masteries", 14: "Warcries",
    15: "Summoning", 16: "Shape Shifting", 17: "Elemental",
    18: "Traps", 19: "Shadow Disciplines", 20: "Martial Arts",
}
CLASSTAB = {}
for t in range(0, 21):
    CLASSTAB[t] = ["Amazon", "Sorceress", "Necromancer", "Paladin", "Barbarian", "Druid", "Assassin"][t // 3]
props = {}
for r in rd("properties"):
    code = r.get("code")
    if code:
        tip = r.get("*Tooltip", "")
        props[code] = {"f": num(r.get("func1")), "tip": tip}

# ------------------------------------------------------------------ affixes
SKILLS = {}
for r in rd("skills"):
    if r.get("skill") and r.get("*Id"):
        SKILLS[r["*Id"]] = r["skill"]
        SKILLS[r["skill"]] = r["skill"]


def label_for(code, par):
    """Human readable label for a stat (property code + parameter).  The label doubles as the stat key."""
    p = props.get(code, {})
    tip = p.get("tip") or code
    tip = re.sub(r"\s+", " ", tip).strip()
    if code == "skilltab":
        t = num(par, -1)
        nm = SKILLTABS.get(t, "tab %s" % par)
        cl = CLASSTAB.get(t, "")
        return "+# to %s Skills (%s only)" % (nm, cl)
    if "[Skill]" in tip:
        nm = SKILLS.get(str(par), str(par))
        tip = tip.replace("[Skill]", nm)
    return tip

def parse_affix(r):
    mods = []
    for i in (1, 2, 3):
        c = r.get("mod%dcode" % i)
        if not c:
            continue
        par = r.get("mod%dparam" % i, "")
        mn = num(r.get("mod%dmin" % i), 0)
        mx = num(r.get("mod%dmax" % i), mn)
        mods.append([c, par, mn, mx, label_for(c, par)])
    return mods


def affix_rows(fname, kind):
    out = []
    for r in rd(fname):
        if not r.get("Name"):
            continue
        ver = num(r.get("version"), 0)
        freq = num(r.get("frequency"), 0)
        if ver < 1 or freq <= 0:
            continue
        it = [r[k] for k in ("itype%d" % i for i in range(1, 8)) if k in r]
        et = [r[k] for k in ("etype%d" % i for i in range(1, 6)) if k in r]
        out.append({
            "n": r["Name"], "k": kind, "sp": num(r.get("spawnable")), "rare": num(r.get("rare")),
            "lvl": num(r.get("level")), "max": num(r.get("maxlevel"), 0) if r.get("maxlevel") else 0,
            "lr": num(r.get("levelreq")),
            "cs": 1 if r.get("classspecific") else 0, "cls": r.get("classspecific", ""),   # (the separate `class` column only names the class of the mod, it does not restrict the item)
            "f": freq, "g": num(r.get("group")), "it": it, "et": et,
            "mods": parse_affix(r),
        })
    return out


prefixes = affix_rows("magicprefix", "p")
suffixes = affix_rows("magicsuffix", "s")
automagic = affix_rows("automagic", "a")

# ----------------------------------------------------------- terror zones
tz = {"bounds": {}, "levels": {}, "zones": {}}
with open(os.path.join(SRC, "hd", "desecratedzones.json"), encoding="utf-8") as f:
    dz = json.load(f)["desecrated_zones"][0]
for mode in ("expansion", "rotw"):
    gd = dz["game_difficulties"].get(mode, {})
    tz["bounds"][mode] = []
    for diff in ("normal", "nightmare", "hell"):
        d = gd.get(diff, {}).get("defaults", {})
        tz["bounds"][mode].append({"min": d.get("bound_incl_min", 1), "max": d.get("bound_incl_max", 99),
                                   "boost": d.get("boost_level", 2), "xp": d.get("boost_experience_percent", 0),
                                   "ladder": gd.get(diff, {}).get("ladder_enabled", True),
                                   "nonladder": gd.get(diff, {}).get("non_ladder_enabled", True)})
for z in dz.get("zones", []) + [zz for g in dz.get("manual_zones", []) for zz in g.get("zones", [])]:
    ids = []
    for lv in z.get("levels", []):
        lid = lv.get("level_id")
        if lid is not None:
            ids.append(lid)
            tz["levels"][str(lid)] = z["id"]
    tz["zones"][z["id"]] = ids

data = {
    "meta": {"source": SRC, "built": __import__("time").strftime("%Y-%m-%d %H:%M:%S")},
    "types": types, "items": items, "tc": tcs, "groups": groups, "levels": levels,
    "monsters": monsters, "su": su, "su_area": SU_AREA, "boss_area": BOSS_AREA,
    "uniques": uniques, "sets": setitems, "ratio": ratio,
    "prefixes": prefixes, "suffixes": suffixes, "automagic": automagic,
    "tz": tz,
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(data, f, separators=(",", ":"))
print("wrote %s (%.1f KB): %d items, %d TCs, %d monsters, %d levels, %d uniques, %d sets, %d prefixes, %d suffixes" % (
    OUT, os.path.getsize(OUT) / 1024, len(items), len(tcs), len(monsters), len(levels), len(uniques), len(setitems),
    len(prefixes), len(suffixes)))
