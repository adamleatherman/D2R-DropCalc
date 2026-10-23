#!/usr/bin/env python3
"""Parse D2R excel tables into compact data.json (Reign of the Warlock) and data-lod.json (Lord of Destruction) for the drop calculator.

Usage:  python build.py [path-to-excel-folder] [data.json] [data-lod.json]
Default folder: excel/ next to this script (see tools/extract_tables.py)   Default outputs: data.json and data-lod.json (next to this script)
Only the Python standard library is used. Input files are only read.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "excel")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "data.json")
OUT_LOD = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(OUT), "data-lod.json")
TDIR = SRC   # table folder of the mode being built (set by build)


def check_extract():
    """Fail early when the root folder is a copy of base\\ (a bad extract: the LoD tables in place of the RotW ones).
    Today 53 of the 91 root tables legitimately equal their base\\ copy; the four key tables below must differ."""
    base = os.path.join(SRC, "base")
    if not os.path.isdir(base):
        return
    def same(name):
        a, b = os.path.join(SRC, name), os.path.join(base, name)
        if not (os.path.isfile(a) and os.path.isfile(b)):
            return False
        with open(a, "rb") as fa, open(b, "rb") as fb:
            return fa.read() == fb.read()
    tables = sorted(f for f in os.listdir(SRC) if f.endswith(".txt") and os.path.isfile(os.path.join(SRC, f)))
    matched = [f for f in tables if same(f)]
    key = [f for f in ("treasureclassex.txt", "uniqueitems.txt", "monstats.txt", "misc.txt") if f in matched]
    if key or len(matched) > 60:
        sys.exit("bad extract: %s looks like a copy of base\\ (LoD tables) instead of the Reign of the Warlock tables.\n"
                 "  %d of %d root tables are byte-identical to base\\ (expected about 53 of 91, at most 60)%s\n"
                 "  identical: %s\n  Re-extract with tools/extract_tables.py." % (
                     SRC, len(matched), len(tables), "; key tables identical: " + ", ".join(key) if key else "", ", ".join(matched)))
    print("extract check ok: %d of %d root tables equal base\\ (key tables differ)" % (len(matched), len(tables)))


check_extract()


def load_strings():
    """English string tables extracted by tools/extract_tables.py (excel/strings/*.json, shared by both modes).
    -> {file: {lower-cased key: enUS text}}.  The game compares keys case-insensitively, the first row of a key wins."""
    need = ("item-names", "item-nameaffixes", "item-modifiers", "monsters", "levels", "skills")
    d = os.path.join(SRC, "strings")
    missing = [n for n in need if not os.path.isfile(os.path.join(d, n + ".json"))]
    if missing:
        sys.exit("missing string tables in %s: %s\n  Re-run tools/extract_tables.py --force (it extracts data/local/lng/strings/*.json into excel/strings/)." % (
            d, ", ".join(n + ".json" for n in missing)))
    out = {}
    for n in need:
        with open(os.path.join(d, n + ".json"), encoding="utf-8-sig") as f:
            rows = json.load(f)
        m = {}
        for r in rows:
            k, v = r.get("Key"), r.get("enUS")
            if k and v is not None:
                m.setdefault(k.lower(), v)
        out[n] = m
    return out


STR = load_strings()


def name_of(table, key, default=None):
    """Display name of a table key from string file `table` (None/empty key or no string -> default, which falls back to the key)."""
    if key:
        v = STR[table].get(key.lower())
        if v:
            return v.strip()
    return default if default is not None else key


def rd(name):
    """Read a tab separated table of the mode being built (TDIR) -> list of dicts (header names as keys)."""
    path = os.path.join(TDIR, name + ".txt")
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
def build(mode):
    """Build the data dict for one game mode: 'rotw' = Reign of the Warlock (root tables), 'lod' = Lord of Destruction (excel/base tables)."""
    global TDIR
    TDIR = SRC if mode == "rotw" else os.path.join(SRC, "base")
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
            "rar": num(r.get("Rarity")),
            "cls": r.get("Class", ""),
            "sm": r.get("StaffMods", ""),   # class code of the class skill bonuses this item type rolls (D2MOO ITEMS_GetStaffMods)
            # max sockets by item level (ITEMS_GetMaxSockets): [MaxSockets1, threshold1, MaxSockets2, threshold2, MaxSockets3]; ilvl <= th1 -> 1, <= th2 -> 2, else 3
            "ms": [num(r.get("MaxSockets1"), 0), num(r.get("MaxSocketsLevelThreshold1"), 0), num(r.get("MaxSockets2"), 0),
                   num(r.get("MaxSocketsLevelThreshold2"), 0), num(r.get("MaxSockets3"), 0)],
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
            # "No quality": a misc item whose type can be neither rare, magic nor normal (ItemTypes Rare/Magic/Normal all 0 along the
            # type chain). Today that is exactly the quest-type items (keys of terror/hate/destruction, essences, organs, statue pieces,
            # worldstone shards, Khalim's/Horadric parts, ...). Such items have no quality, so they cannot be magic or better.
            no_quality = kind == "m" and not (can_rare or always_magic or always_normal or any(types[a]["rare"] or types[a]["magic"] for a in anc if a in types))
            tier = 0
            if kind != "m":
                if r.get("ubercode") == code:
                    tier = 1
                elif r.get("ultracode") == code:
                    tier = 2
            it = {
                "n": name_of("item-names", r.get("namestr"), r.get("name", code).strip()),   # display name (string table); the code stays the id
                "k": kind,
                "t": t,
                "anc": anc,
                "q": num(r.get("level")),
                "r": max(1, own.get("rar", 0)),   # generic weapN/armoN weight = ItemTypes.txt Rarity of the first type, floor 1 (D2MOO DATATBLS_CreateItemTypeTreasureClasses)
                "sp": num(r.get("spawnable")),
                "ml": num(r.get("magic lvl")),
                "tier": tier,
                "cr": 1 if can_rare else 0,
                "am": 1 if always_magic else 0,
                "an": 1 if always_normal else 0,
                "nq": 1 if no_quality else 0,
                "cs": 1 if cls_specific else 0,
                "ap": num(r.get("auto prefix"), 0) if r.get("auto prefix") else 0,
                "ver": num(r.get("version"), 0),
                # socket capacity: the base's socket limit (armor/weapons gemsockets), 0 without an inventory (hasinv), and the inventory size
                # (the sock property caps the count at width * height, ITEMMODS_PropertyFunc14)
                "gs": num(r.get("gemsockets"), 0) if num(r.get("hasinv"), 0) else 0,
                "sz": num(r.get("invwidth"), 0) * num(r.get("invheight"), 0),
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
            "name": name_of("levels", r.get("LevelName"), r.get("LevelName") or r.get("Name", str(lid))),
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
              ("TreasureClassDesecratedUnique", "dun"), ("TreasureClassHerald", "hr")]
    for r in rd("monstats"):
        mid = r.get("Id")
        if not mid:
            continue
        m = {
            "n": name_of("monsters", r.get("NameStr"), r.get("NameStr", mid)),
            "lv": [num(r.get("Level")), num(r.get("Level(N)")), num(r.get("Level(H)"))],
            "boss": num(r.get("boss")),
            "nr": num(r.get("noRatio")),
            "sp": num(r.get("isSpawn")),
            "kill": num(r.get("killable")),
            "rar": num(r.get("Rarity")),
            "g": [num(r.get("MinGrp"), 1), num(r.get("MaxGrp"), 1)],
            "pm": [num(r.get("PartyMin")), num(r.get("PartyMax"))],
            "npc": num(r.get("npc")),
            "nh": num(r.get("CannotHerald")),
            "en": num(r.get("enabled")),
        }
        tc = [{}, {}, {}]
        for col, key in TCCOLS:
            for d, suf in enumerate(("", "(N)", "(H)")):
                v = r.get(col + suf)
                if v:
                    tc[d][key] = v
        m["tc"] = tc
        if r.get("TCQuestId"):  # quest TC (replaces the TC on the first kill while the quest is open)
            m["qid"] = num(r.get("TCQuestId")); m["qcp"] = num(r.get("TCQuestCP"))
            m["qtc"] = [r.get("TreasureClassQuest" + suf, "") for suf in ("", "(N)", "(H)")]
        monsters[mid] = m

    # ---------------------------------------------------------------- superuniques
    su = []
    for r in rd("superuniques"):
        name = r.get("Superunique")
        if not name or not r.get("Class") or not r.get("TC(H)") and not r.get("TC"):
            continue
        su.append({
            "id": name,
            "n": name_of("monsters", r.get("Name"), r.get("Name", name)),   # id stays the table key
            "cls": r["Class"],
            "tc": [r.get("TC", ""), r.get("TC(N)", ""), r.get("TC(H)", "")],
            "dtc": [r.get("TC Desecrated", ""), r.get("TC(N) Desecrated", ""), r.get("TC(H) Desecrated", "")],
        })

    # Where each boss / superunique lives (level Id from levels.txt). levels.txt has no such column,
    # so this table is hand-written from game knowledge: EDIT here if something is wrong.
    # Sources (cross-checked): AS = Arreat Summit super unique pages, classic.battle.net/diablo2exp/monsters/act{1..5}-superuniques.shtml;
    # PD = PureDiablo "Superunique Monsters Overview", https://www.purediablo.com/?p=4271 . Changes vs the earlier hand-written table are marked.
    SU_AREA = {
        "Bishibosh": 3, "Bonebreak": 18, "Coldcrow": 9, "Rakanishu": 4, "Treehead WoodFist": 5,
        "Griswold": 38, "The Countess": 25, "Boneash": 33, "The Smith": 28, "Corpsefire": 8,
        "Pitspawn Fouldog": 30,   # CHANGED 29 -> 30: Jail Level 2 (AS act1, PD)
        "Radament": 49, "Bloodwitch the Wild": 60, "Fangskin": 61, "Beetleburst": 43, "Leatherarm": 59,
        "Coldworm the Burrower": 64, "Fire Eye": 54, "Dark Elder": 44, "The Summoner": 74,
        "Ancient Kaa the Soulless": 66,   # CHANGED 65 -> 66: Tal Rasha's Tomb (random of 66-72, same levels), not Ancient Tunnels (AS act2, PD)
        "Web Mage the Burning": 85, "Witch Doctor Endugu": 91,
        "Stormtree": 79,          # CHANGED 89 -> 79: entering Lower Kurast / Flayer Jungle edge (AS "Entering Lower Kurast", PD); 78 and 79 share level
        "Sarina the Battlemaid": 94,   # CHANGED 81 -> 94: Ruined Temple (AS act3, PD)
        "Icehawk Riftwing": 92,   # CHANGED 93 -> 92: Sewers Level 1 (AS act3, PD)
        "Ismail Vilehand": 83, "Geleb Flamefinger": 83, "Toorc Icefist": 83,   # Travincal (AS, PD)
        "Bremm Sparkfist": 102, "Wyand Voidfinger": 102, "Maffer Dragonhand": 102,   # CHANGED 83 -> 102: Durance of Hate Level 3 (AS act3, PD)
        "Infector of Souls": 108, "Lord De Seis": 108, "Grand Vizier of Chaos": 108,
        "The Cow King": 39, "The Feature Creep": 107,
        "Siege Boss": 110,        # CHANGED 128 -> 110: Shenk the Overseer, Bloody Foothills (AS act5, PD)
        "Dac Farren": 110,        # CHANGED 111 -> 110: Bloody Foothills (AS act5, PD)
        "Megaflow Rectifier": 111,   # CHANGED 113 -> 111: Eldritch the Rectifier, Frigid Highlands (AS, PD)
        "Eyeback Unleashed": 111,    # unchanged: Frigid Highlands (AS, PD)
        "Sharp Tooth Sayer": 111,    # CHANGED 112 -> 111: Sharptooth Slayer, Frigid Highlands (AS, PD)
        "Threash Socket": 112,    # CHANGED 129 -> 112: Arreat Plateau (AS, PD)
        "Frozenstein": 114,       # CHANGED 118 -> 114: Frozen River (AS, PD)
        "Bonesaw Breaker": 115,   # CHANGED 113 -> 115: Glacial Trail (AS, PD)
        "Snapchip Shatter": 119,  # unchanged: Icy Cellar (AS, PD)
        "Pindleskin": 121, "Nihlathak Boss": 124,
        # ADDED: Baal's minion waves, all in the Throne of Destruction (AS act5 lists Colenzo/Achmel/Bartuc/Ventar/Lister there; PD agrees)
        "Baal Subject 1": 131, "Baal Subject 2": 131, "Baal Subject 3": 131, "Baal Subject 4": 131, "Baal Subject 5": 131,
    }
    # Rows present in superuniques.txt that never spawn as super uniques: absent from every Arreat Summit act list and the PureDiablo
    # list (Act 4 has only Izual/Hephasto/Vizier/De Seis/Infector; Act 5 only the ones above). REMOVED from SU_AREA.
    # Flamespike the Crawler: removed from LoD (replaced by a dead rogue) per the Diablo wiki; also absent from AS/PD -> treated as unused (unresolved).
    SU_UNUSED = [
        "Winged Death", "The Tormentor", "Taintbreeder", "Riftwraith the Cannibal",
        "Axe Dweller", "Anodized Elite", "Vinvear Molech", "Magma Torquer", "Blaze Ripper",
        "Flamespike the Crawler",
    ]
    SU_AREA = {k: v for k, v in SU_AREA.items() if k not in SU_UNUSED}
    BOSS_AREA = {  # monstats Id -> level Id (these use their own monstats Level, not the area's)
        "andariel": 37, "duriel": 73, "mephisto": 102, "diablo": 108, "baalcrab": 132,
        "summoner": 74, "radament": 49, "izual": 105, "bloodraven": 17, "griswold": 38, "nihlathakboss": 124,
        "colossal1": 137, "colossal2": 137, "colossal3": 137,   # Uber Talic / Madawc / Korlic (Colossal Summit, Hell TC only; ancientbarb1-3 have no TC and stay skipped)
    }
    # the three "Fighting Act 5 mini bosses" etc are intentionally skipped.

    # ------------------------------------------------------ uniques / sets / sets
    uniques = []
    for r in rd("uniqueitems"):
        if not r.get("index") or not r.get("code"):
            continue
        uniques.append({
            "id": r["index"],
            "n": name_of("item-names", r["index"]),
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
            "n": name_of("item-names", r["index"]),
            "code": r["item"],
            "set": r.get("set", ""),
            "sn": name_of("item-names", r.get("set", "")),
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
    # Stat descriptions are built the way the game does it: properties.txt (property code -> stats) -> itemstatcost.txt (descfunc, descstrpos,
    # descstr2, dgrp*) -> string keys resolved in item-modifiers.json.  The value is written as "#" so a label doubles as the stat key
    # ("+#% Faster Cast Rate"); the UI substitutes a value or a range.  Stats without usable description data fall back to the properties.txt
    # *Tooltip (see FALLBACKS, reported by the build).
    props = {}
    for r in rd("properties"):
        code = r.get("code")
        if code:
            props[code] = {"tip": r.get("*Tooltip", ""), "val1": r.get("val1", ""),
                           "st": [(num(r.get("func%d" % i)), r["stat%d" % i]) for i in range(1, 8) if r.get("stat%d" % i)],
                           "f": num(r.get("func1"))}
    ISC = {r["Stat"]: r for r in rd("itemstatcost") if r.get("Stat")}
    MOD = STR["item-modifiers"]

    def ms(key):
        return MOD.get(key.lower()) if key else None

    SKILLS = {}
    CLASS_SKILLS = {}  # charclass code -> [(skill id, skill name, itypea1)]
    SKILL_CLASS = {}   # skill name -> charclass code (for "(Sorceress Only)")
    sdesc = {r["skilldesc"]: r for r in rd("skilldesc") if r.get("skilldesc")}
    for r in rd("skills"):
        if r.get("skill") and r.get("*Id"):
            dn = name_of("skills", (sdesc.get(r.get("skilldesc")) or {}).get("str name"), r["skill"])
            SKILLS[r["*Id"]] = dn
            SKILLS[r["skill"]] = dn
            SKILL_CLASS[r["skill"]] = r.get("charclass", "")
            if r.get("charclass"):
                CLASS_SKILLS.setdefault(r["charclass"], []).append((int(r["*Id"]), r["skill"], r.get("itypea1", "")))
    # class order = charstats rows (the blank "Expansion" separator row has no strings and is skipped); class index * 3 + tab - 1 = skilltab id
    CLASSES = [r for r in rd("charstats") if r.get("StrAllSkills")]
    CLASS_CODES = {"ama": 0, "sor": 1, "nec": 2, "pal": 3, "bar": 4, "dru": 5, "ass": 6, "war": 7}

    def tpl(fmt, args=()):
        """printf style game string -> template: every %d/%i (also %+d) becomes '#' ('+#'), %s takes the next arg, %% -> %."""
        it = iter(args)
        def sub(m):
            t = m.group(0)
            if t == "%%":
                return "%"
            if t == "%s":
                return next(it, "?")
            return "+#" if "+" in t else "#"
        return re.sub(r"%%|%s|%\+?[di]", sub, fmt)

    def skill_name(par):
        return SKILLS.get(str(par), str(par))

    # time of day suffix of func 17 stats without a "(Based on Character Level)" string 2
    TIMES = [re.sub(r"^%s \(Increases\s+(.*)\)$", r"", ms(k) or "") for k in ("ModStre9e", "ModStre9f", "ModStre9g", "ModStre9d")]
    # damage stats the game combines into one "Adds #-# <element> damage" line when both halves are present (hard-coded in the game, the strings are ours)
    RANGE = {"firemindam": "strModFireDamageRange", "lightmindam": "strModLightningDamageRange", "coldmindam": "strModColdDamageRange",
             "magicmindam": "strModMagicDamageRange", "poisonmindam": "strModPoisonDamageRange", "mindamage": "strModMinDamageRange"}
    # properties.txt funcs that name their stat implicitly (no stat column)
    IMPLICIT = {5: "mindamage", 6: "maxdamage", 20: "item_indesctructible"}
    # stats with no description row at all (extra halves of the damage ranges, sockets): readable fallbacks, listed in FALLBACKS
    STAT_FALLBACK = {"coldlength": "Cold Damage Length (# frames)", "poisonlength": "Poison Damage Length (# frames)"}
    FALLBACKS = {}

    def stat_text(stat, par, val1):
        """Description template of one stat (the game's descfunc rules), or None when the data has none."""
        d = ISC.get(stat)
        if not d or not d.get("descfunc") or not ms(d.get("descstrpos")):
            return None
        fn = num(d["descfunc"])
        s1, s2 = ms(d["descstrpos"]), ms(d.get("descstr2"))
        if fn == 13:   # +# to <Class> Skill Levels
            c = num(val1, -1)
            return tpl(ms(CLASSES[c]["StrAllSkills"])) if 0 <= c < len(CLASSES) else None
        if fn == 14:   # +# to <skill tab> Skills (<Class> Only)
            t = num(par, -1)
            c, k = t // 3, t % 3
            if not 0 <= c < len(CLASSES):
                return None
            return tpl(ms(CLASSES[c]["StrSkillTab%d" % (k + 1)])) + " " + (ms(CLASSES[c]["StrClassOnly"]) or "")
        if fn in (15, 16, 24, 28):   # skill on event / aura / charged / non-class skill: the skill name comes from the parameter
            return tpl(s1, [skill_name(par)])
        if fn == 27:   # +# to <skill> (<Class> Only)
            cc = SKILL_CLASS.get(skill_name(par), SKILL_CLASS.get(str(par), ""))
            ci = [i for i, c in enumerate(CLASSES) if (c.get("class") or "")[:3].lower() == cc]
            return tpl(s1, [skill_name(par), (ms(CLASSES[ci[0]]["StrClassOnly"]) if ci else "") or ""]).strip()
        if fn in (23, 29) or fn > 29 or fn < 1:
            return None   # reanimate (needs a monster), damage resist: not implemented, tooltip fallback
        if "%" in s1:
            out = tpl(s1)   # D2R strings carry their own format (descfunc 19 is plain sprintf; the old value layouts are folded into the string)
        else:   # classic layout: value text before (descval 1, default) or after (2) the string, 0 = no value
            vt = {1: "+#", 6: "+#", 12: "+#", 2: "#%", 7: "#%", 3: "#", 9: "#", 4: "+#%", 8: "+#%", 5: "#%", 10: "#%", 20: "-#%", 21: "-#", 22: "#%"}.get(fn, "")
            dv = d.get("descval", "")
            out = s1 if dv == "0" or not vt else (s1 + " " + vt if dv == "2" else vt + " " + s1)
        if fn == 17 and not s2:
            out += " (Increases " + " / ".join(TIMES) + ")"
        elif s2:
            out += " " + s2
        return out

    def label_for(code, par):
        """Human readable description template for a property (code + parameter).  The label doubles as the stat key."""
        p = props.get(code)
        if p is None:
            return code
        stats = [s for _, s in p["st"]] or ([IMPLICIT[p["f"]]] if p["f"] in IMPLICIT else [])
        text = None
        if p["f"] == 7 and not p["st"]:   # dmg%: the game shows min% and max% together as "Enhanced Damage"
            text = ms("strModEnhancedDamage")
            text = tpl(text) if text else None
        elif len(stats) >= 2 and stats[0] in RANGE and stats[1].replace("min", "max") in ISC and ms(RANGE[stats[0]]):
            text = tpl(ms(RANGE[stats[0]]))
        elif len(stats) >= 2 and all(ISC.get(s, {}).get("dgrp") for s in stats) and len({ISC[s]["dgrp"] for s in stats}) == 1 and ms(ISC[stats[0]].get("dgrpstrpos")):
            d = ISC[stats[0]]
            text = tpl(ms(d["dgrpstrpos"])) + (" " + ms(d["dgrpstr2"]) if ms(d.get("dgrpstr2")) else "")
        elif stats:
            text = stat_text(stats[0], par, p["val1"])
        if text:
            return re.sub(r"\s+", " ", text).strip()
        tip = re.sub(r"\s+", " ", p["tip"] or STAT_FALLBACK.get(stats[0] if stats else "", "") or code).strip()
        if "[Skill]" in tip:
            tip = tip.replace("[Skill]", skill_name(par))
        FALLBACKS.setdefault(code, ("descfunc " + (ISC.get(stats[0], {}).get("descfunc") or "-") if p["st"] else "implicit func %s" % p["f"], tip))
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
            pr = props.get(c)
            if pr and pr["st"] and num(ISC.get(pr["st"][0][1], {}).get("descfunc")) in (5, 10):   # descfunc 5/10 show value*100/128 (hit causes monster to flee: 32 -> 25%)
                mn, mx = round(mn * 100 / 128), round(mx * 100 / 128)
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
                "n": r["Name"], "dn": name_of("item-nameaffixes", r["Name"]), "k": kind, "sp": num(r.get("spawnable")), "rare": num(r.get("rare")),
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

    # coverage report: run every property code that any affix, automagic, unique or set item uses through label_for (fallbacks are collected in FALLBACKS)
    used = set()
    for L in (prefixes, suffixes, automagic):
        for a in L:
            used.update(m[0] for m in a["mods"])
    for fname, cols in (("uniqueitems", ["prop%d" % i for i in range(1, 13)]),
                        ("setitems", ["prop%d" % i for i in range(1, 10)] + ["aprop%da" % i for i in range(1, 6)] + ["aprop%db" % i for i in range(1, 6)]),
                        ("sets", ["PCode%da" % i for i in range(2, 6)] + ["PCode%db" % i for i in range(2, 6)] + ["FCode%d" % i for i in range(1, 9)])):
        for r in rd(fname):
            used.update(r[c] for c in cols if r.get(c))
    for c in sorted(used):
        label_for(c, "0")
    DESC_REPORT[mode] = {"checked": len(used), "fallback": dict(FALLBACKS)}

    # class skill lists for the staff mods (D2MOO sub_6FC52650: the game picks class first skill id + 5 * (tier - 1) + 0..4, so the 30 class
    # skills must be consecutive ids). Each entry: id, stat key (= description label of the single skill stat) and the item type the skill needs.
    staff = {}
    for cc in sorted({t["sm"] for t in types.values() if t["sm"]}):
        L = sorted(CLASS_SKILLS.get(cc, []))
        if not L:
            continue
        assert len(L) == 30 and L[-1][0] - L[0][0] == 29, "class %s skills are not 30 consecutive ids" % cc
        staff[cc] = [{"id": i, "k": label_for("skill", nm), "ia": ia} for i, nm, ia in L]

    # ----------------------------------------------------------- terror zones
    tz = {"bounds": [], "levels": {}, "zones": {}}
    with open(os.path.join(SRC, "hd", "desecratedzones.json"), encoding="utf-8") as f:
        dz = json.load(f)["desecrated_zones"][0]
    gd = dz["game_difficulties"].get("rotw" if mode == "rotw" else "expansion", {})
    for diff in ("normal", "nightmare", "hell"):
        d = gd.get(diff, {}).get("defaults", {})
        tz["bounds"].append({"min": d.get("bound_incl_min", 1), "max": d.get("bound_incl_max", 99),
                             "boost": d.get("boost_level", 2), "xp": d.get("boost_experience_percent", 0),
                             "ladder": gd.get(diff, {}).get("ladder_enabled", True),
                             "nonladder": gd.get(diff, {}).get("non_ladder_enabled", True)})
    # herald tiers exist only in the rotw section (the engine allows heralds exactly when this list is non-empty)
    tz["herald"] = []
    for t in gd.get("hell", {}).get("defaults", {}).get("herald_tiers", []):
        tz["herald"].append({
            "boost": t.get("herald_treasure_class_level_boost", 0),
            "minions": t.get("min_minions", 0), "mods": t.get("min_unique_mods", 0),
            "slope": t.get("zone_chance_slope"), "mid": t.get("zone_chance_midpoint"),
            "asym": t.get("zone_chance_asymptote"), "shift": t.get("zone_chance_vertical_shift"),
            "hp": t.get("herald_health_boost_percent"), "dmg": t.get("herald_damage_boost_percent"),
        })
    for z in dz.get("zones", []) + [zz for g in dz.get("manual_zones", []) for zz in g.get("zones", [])]:
        ids = []
        for lv in z.get("levels", []):
            lid = lv.get("level_id")
            if lid is not None:
                ids.append(lid)
                tz["levels"][str(lid)] = z["id"]
        tz["zones"][z["id"]] = ids

    return {
        "types": types, "items": items, "tc": tcs, "groups": groups, "levels": levels,
        "monsters": monsters, "su": su, "su_area": SU_AREA, "su_unused": SU_UNUSED, "boss_area": BOSS_AREA,
        "uniques": uniques, "sets": setitems, "ratio": ratio,
        "prefixes": prefixes, "suffixes": suffixes, "automagic": automagic, "staff": staff,
        "tz": tz,
    }


DESC_REPORT = {}
EXTRACT = {}
try:
    with open(os.path.join(SRC, "extract.json"), encoding="utf-8") as f:
        EXTRACT = json.load(f)
except (OSError, ValueError):
    print("warning: no readable extract.json in %s; game version unknown" % SRC)

META = {"gameVersion": EXTRACT.get("gameVersion") or "unknown", "buildKey": EXTRACT.get("buildKey") or "unknown",
        "built": __import__("time").strftime("%Y-%m-%d %H:%M:%S")}
for mode, path in (("rotw", OUT), ("lod", OUT_LOD)):
    data = {"meta": dict(META, mode=mode)}
    data.update(build(mode))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    print("wrote %s (%.1f KB, mode %s): %d items, %d TCs, %d monsters, %d levels, %d uniques, %d sets, %d prefixes, %d suffixes" % (
        path, os.path.getsize(path) / 1024, mode, len(data["items"]), len(data["tc"]), len(data["monsters"]), len(data["levels"]),
        len(data["uniques"]), len(data["sets"]), len(data["prefixes"]), len(data["suffixes"])))
    dr = DESC_REPORT[mode]
    print("  descriptions: %d property codes checked, %d use the properties.txt tooltip as fallback: %s" % (
        dr["checked"], len(dr["fallback"]), ", ".join("%s (%s)" % (k, v[0]) for k, v in sorted(dr["fallback"].items()))))
