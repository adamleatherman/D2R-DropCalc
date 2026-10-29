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
sys.path.insert(0, os.path.join(HERE, "tools"))
import floor_share
import maze_cells
import preset_monsters
SRC =sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "excel")
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
            "throw": num(r.get("Throwable"), 0),
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
                "lv": num(r.get("levelreq")),   # character level the base itself requires
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
            # durability: ITEMS_HasDurability (D2Common Items.cpp) = !nodurability && durability != 0 -> only those can be made ethereal (ITEMS_MakeEthereal)
            # and `nd` (the nodurability flag itself, not the durability value) limits the superior bonus to the first 4 qualityitems rows
            if kind != "m":
                nd_flag = num(r.get("nodurability"), 0)
                it["nd"] = 1 if nd_flag else 0
                it["hd"] = 1 if (not nd_flag and num(r.get("durability"), 0) > 0) else 0
                if num(r.get("stackable"), 0):
                    it["st"] = 1
                it["th"] = 1 if num(own.get("throw"), 0) else 0   # first type is Throwable (ITEMS_CheckIfThrowable): javelins, throwing knives / axes, potions
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
    # Level geometry for the per-run model (engine.js areaRolls). DrlgType 1 (maze): lvlmaze Rooms[diff] cells of SizeX x SizeY tiles
    # (D2MOO D2Common DrlgMaze.cpp DRLGMAZE_GenerateLevel adds cells until pLevel->nRooms == dwRooms[difficulty]); levels.txt SizeX/SizeY is only
    # the bounding box there. Others: levels.txt SizeX/SizeY. Act 5 Frigid Highlands / Arreat Plateau / Frozen Tundra are forced to 64x160 or 160x64
    # tiles by the Act 5 level linker (DrlgOutRoom.cpp DRLGOUTROOM_LinkLevelsByLevelCoords / ...ByOffsetCoords / ...ByLevelDef; levels.txt: -1 / 128x80).
    # Fixed single-preset caves (Frozen River, Drifter Cavern, Icy Cellar) and the Hell1-3 lava layouts get no extra special-preset cells.
    maze = {num(r.get("Level")): r for r in rd("lvlmaze") if r.get("Level")}
    # "pl" = placement factor from the real map layouts (tools/floor_share.py: share of walkable subtiles of each populated preset room, 20 placement
    # tries per pack). 1 where the layout is not modelled (open outdoor levels with generated fill). Left out when excel/tiles was not extracted.
    # Maze cell counts: tools/maze_cells.py replays the cave generator (DrlgMaze.cpp) and counts the cells and the lvlprest rows of every maze level;
    # maze_cells.json holds the result. "cells" below = populated cells (Populate 1 rows of THIS mode's lvlprest.txt) per difficulty; floor_share /
    # preset_monsters weight the cell presets by the same expected row counts. A stale file (tables changed since it was made) is not used.
    sim, tomb_kinds = {}, None
    mc_path = os.path.join(HERE, "tools", "maze_cells.json")
    if os.path.isfile(mc_path):
        with open(mc_path, encoding="utf-8") as f:
            mc = json.load(f)
        if mc["meta"]["digest"] == maze_cells.input_digest(TDIR):
            sim = {int(k): v["kinds_mean"] for k, v in mc["levels"].items()}
            tomb_kinds = mc["levels"].get("66", {}).get("tomb_cases", {}).get("kinds")   # Tal Rasha's Tomb cases (staff / boss / plain), maze_cells.tomb_split
        else:
            print("warning: %s: tools/maze_cells.json is stale (levels / lvlmaze / lvlprest changed): run python -I tools/maze_cells.py; "
                  "cave cell counts fall back to the lvlmaze Rooms rule of thumb" % mode)
    else:
        print("warning: no tools/maze_cells.json (python -I tools/maze_cells.py); cave cell counts fall back to the lvlmaze Rooms rule of thumb")
    populate = {}
    for r in rd("lvlprest"):
        populate.setdefault(r.get("Name"), num(r.get("Populate")))
    tiles_dir = os.path.join(SRC, "tiles")
    pls = pres = pm = None
    if os.path.isdir(tiles_dir):
        pls = floor_share.level_pl(TDIR, tiles_dir, sim)
        pres, pm = preset_monsters.level_pre(TDIR, tiles_dir, sim)
        if pm.unresolved:
            print("warning: %s: monplace classes without a spawn rule: %s" % (mode, dict(pm.unresolved)))
    else:
        print("warning: no %s (re-run tools/extract_tables.py --force); levels get no 'pl' placement factor" % tiles_dir)
    # Pandemonium areas that can only be opened in Hell (`ho` 1: engine.js sources() skips them in Normal and Nightmare): Matron's Den, Forgotten Sands,
    # Furnace of Pain, Uber Tristram. levels.txt has monsters and treasure classes for every difficulty, but the three keys (pk1-pk3) only drop from Hell
    # treasure classes (Countess Item (H), Summoner (H), Nihlathak (H)) and the finale items (dhn / bey / mbr) from the Uber bosses. D2MOO parses the portal
    # recipes (HoradricCube.cpp, "Pandemonium Portal" / "Pandemonium Finale Portal" -> CUBEOP_UBERDUNGEON / CUBEOP_UBERTRISTRAM) but has no code that opens
    # them and no recipe "min diff" (the Colossal Summit recipe has min diff 2, enforced in PlrTrade.cpp), so this is game knowledge, not a decompiled check.
    HELL_ONLY = {133, 134, 135, 136}
    ACT5_LINKED = {111: (64, 160), 112: (64, 160), 117: (64, 160)}
    FIXED_MAZE = {114, 116, 119, 125, 126, 127}
    TOMB_LEVELS = set(range(66, 73))      # Tal Rasha's Tomb 1-7 (identical rows; maze_cells.tomb_split cases)
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
            "rs": num(r.get("rangedspawn")),
            "nw": sum(1 for i in range(8) if num(r.get("Vis%d" % i), 0) > 0),   # adjacent levels (warps); each costs about one room of spawn rolls (WarpDist)
        }
        mz = maze.get(lid)
        L = levels[str(lid)]
        if lid in HELL_ONLY:
            L["ho"] = 1
        if pls is not None:
            p = pls.get(lid, {}).get("pl")
            L["pl"] = 1 if p is None else round(p, 4)
        if num(r.get("DrlgType")) == 1 and mz:
            L["geo"] = {"t": "maze", "cells": [num(mz.get("Rooms")), num(mz.get("Rooms(N)")), num(mz.get("Rooms(H)"))],
                        "w": num(mz.get("SizeX")), "h": num(mz.get("SizeY")), "fixed": 1 if lid in FIXED_MAZE else 0}
            if lid in sim:     # replayed generator: expected populated cells per difficulty (the engine then adds no special-preset cells)
                L["geo"]["cells"] = [round(sum(v[d] for n, v in sim[lid].items() if populate.get(n)), 3) for d in range(3)]
                L["geo"]["sim"] = 1
                if tomb_kinds and lid in TOMB_LEVELS:   # every tomb gets it, so the seven stay identical (engine DUP_OF lists them once)
                    L["geo"]["tomb"] = {c: [round(sum(v[d] for n, v in kk.items() if populate.get(n)), 3) for d in range(3)] for c, kk in tomb_kinds.items()}
        elif lid in ACT5_LINKED:
            L["geo"] = {"t": "area", "w": [ACT5_LINKED[lid][0]] * 3, "h": [ACT5_LINKED[lid][1]] * 3}
        else:
            L["geo"] = {"t": "area", "w": L["sx"], "h": L["sy"]}

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
            # spawn-model fields (engine.js areaRun): party / unique minions, group forced to 1 for Fallen / Scarab bases (PopulateRoom),
            # sparsePopulate, placespawn -> spawn swap, rangedtype (levels rangedspawn re-rolls the first list pick for one)
            "mn": [x for x in (r.get("minion1"), r.get("minion2")) if x],
            "g1": 1 if r.get("BaseId") in ("fallen1", "scarab1") else 0,
            "spp": num(r.get("sparsePopulate")),
            "ps": r.get("spawn") if num(r.get("placespawn")) and r.get("spawn") else "",
            "rt": num(r.get("rangedtype")),
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
    ms_rows = {r["Id"]: r for r in rd("monstats") if r.get("Id")}
    # Minions that D2GAME_SpawnSuperUnique_6FC6F690 (MonsterUnique.cpp, the switch on dwHcIdx after the generic minions) spawns on top of MinGrp / MaxGrp, as
    # [monster id, count]: Radament 2-6 skeleton5 (mean 4) + a poison / cold / fire / lightning skeleton mage, Siege Boss (Shenk) 20 x minion1, Nihlathak Boss 20 x the
    # level's variant of minion1 (D2Common_11063, resolved below), Baal Subject 2 (Achmel) 10 x skmage_cold3 (sub_6FC6A230 spawns nCount copies as owned minions).
    SU_EXTRA_MINIONS = {
        "Radament": [["skeleton5", 4], ["skmage_pois3", 1], ["skmage_cold4", 1], ["skmage_fire3", 1], ["skmage_ltng3", 1]],
        "Siege Boss": [["minion1", 20]], "Nihlathak Boss": [["minion1", 20]], "Baal Subject 2": [["skmage_cold3", 10]],
    }
    if pm is not None:      # Nihlathak: the Halls of Vaught variant of minion1 (preset_monsters.level_variant = D2Common_11063)
        SU_EXTRA_MINIONS["Nihlathak Boss"] = [[pm.level_variant(124, "minion1"), 20]]
    su = []
    for r in rd("superuniques"):
        name = r.get("Superunique")
        if not name or not r.get("Class") or not r.get("TC(H)") and not r.get("TC"):
            continue
        # Minions (MonsterUnique.cpp D2GAME_SpawnSuperUnique_6FC6F690): D2GAME_SpawnMinions_6FC6F440(..., 1, MinGrp, MaxGrp) after MinGrp / MaxGrp are
        # raised by the difficulty when both are non-zero; the minion type is the class's monstats minion1 when valid, else the class itself ("mn")
        m1 = (ms_rows.get(r["Class"]) or {}).get("minion1")
        su.append({
            "id": name,
            "n": name_of("monsters", r.get("Name"), r.get("Name", name)),   # id stays the table key
            "cls": r["Class"],
            "mg": [num(r.get("MinGrp")), num(r.get("MaxGrp"))],
            "mn": m1 if m1 in ms_rows else r["Class"],
            "tc": [r.get("TC", ""), r.get("TC(N)", ""), r.get("TC(H)", "")],
            "dtc": [r.get("TC Desecrated", ""), r.get("TC(N) Desecrated", ""), r.get("TC(H) Desecrated", "")],
        })
        if name in SU_EXTRA_MINIONS:
            su[-1]["xm"] = SU_EXTRA_MINIONS[name]

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

    # Preset monsters (tools/preset_monsters.py: the .ds1 unit lists of the presets each level uses; expected per full clear [Normal, NM, Hell]):
    #   "pre"  fixed monsters [{"m": id, "r": "regular", "n": [N, NM, H]}]: only ids with a treasure class, not act bosses (BOSS_AREA are separate rows)
    #   "pb"   preset unique packs "u" and champion packs "c" ([N, NM, H] each): a monster picked like a random boss pack (engine areaRun)
    #   "pk"   [N, NM, H] units that raise the level's unique count (unique / champion packs and the super uniques placed, which are separate rows)
    # Left out when excel/tiles was not extracted (like "pl").
    if pres is not None:
        r3 = lambda v: [round(x, 3) for x in v]
        for lid, res in pres.items():
            L = levels.get(str(lid))
            if L is None:
                continue
            pre = [{"m": k, "r": "regular", "n": r3(v)} for k, v in sorted(res["mon"].items())
                   if any(v) and k in monsters and k not in BOSS_AREA and any(monsters[k]["tc"])]
            if pre:
                L["pre"] = pre
            pb = {k: r3(res[k]) for k in ("u", "c") if any(res[k])}
            if pb:
                L["pb"] = pb
            if any(res["k"]):
                L["pk"] = r3(res["k"])

    # ------------------------------------------------------ uniques / sets / sets
    uniques, urows = [], []
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
        urows.append(r)
    # Uniques sharing one index (the eight Rainbow Facets) get a distinct id and name from their own properties: the engine and the
    # search match uniques by id, so with one id a "Rainbow Facet" search counted all eight. Facets: the element of the dmg-* property
    # and the trigger of the death-skill / levelup-skill property, e.g. "Rainbow Facet (Cold, Level up)". Other duplicates keep their id (Azurewrath:
    # an unused Crystal Sword row next to the real Phase Blade one; the engine keeps the later, spawnable row).
    ELEM = {"ltng": "Lightning", "cold": "Cold", "fire": "Fire", "pois": "Poison", "mag": "Magic"}
    dup = {}
    for u in uniques:
        dup[u["id"]] = dup.get(u["id"], 0) + 1
    for u, r in zip(uniques, urows):
        if dup[u["id"]] < 2:
            continue
        props = [r.get("prop%d" % k, "") for k in range(1, 13)]
        el = next((ELEM.get(p_[4:]) for p_ in props if p_.startswith("dmg-") and ELEM.get(p_[4:])), None)
        trig = "Death" if "death-skill" in props else "Level up" if "levelup-skill" in props else None
        if not (el and trig):
            continue
        tag = el + ", " + trig
        u["id"] = u["id"] + " (" + tag + ")"
        u["n"] = u["n"] + " (" + tag + ")"
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
    SKILL_LV = {}      # skill id / name -> (required level, max level) for the skill levels that depend on the item level
    CLASS_SKILLS = {}  # charclass code -> [(skill id, skill name, itypea1)]
    SKILL_CLASS = {}   # skill name -> charclass code (for "(Sorceress Only)")
    sdesc = {r["skilldesc"]: r for r in rd("skilldesc") if r.get("skilldesc")}
    for r in rd("skills"):
        if r.get("skill") and r.get("*Id"):
            dn = name_of("skills", (sdesc.get(r.get("skilldesc")) or {}).get("str name"), r["skill"])
            SKILLS[r["*Id"]] = dn
            SKILLS[r["skill"]] = dn
            SKILL_LV[r["*Id"]] = SKILL_LV[r["skill"]] = (num(r.get("reqlevel")), num(r.get("maxlvl")))
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

    def skill_levels(par, lvl):
        """[lowest, highest] skill level a property rolls on items up to item level 99 (ITEMMODS_PropertyFunc11 / Func19, D2Common ItemMods.cpp):
        lvl > 0 is fixed; lvl < 0 is (ilvl - skill reqlevel) / ((99 - reqlevel) / -lvl) (at least 1); 0 is (ilvl - reqlevel) / 4 + 1 capped at the skill max level (20 if none)."""
        req, mxl = SKILL_LV.get(str(par), (0, 0))
        if lvl > 0:
            return [lvl, lvl]
        if lvl < 0:
            return [1, max(1, (99 - req) // max(1, max(1, 99 - req) // -lvl))]
        return [1, max(1, min((99 - req) // 4 + 1, mxl if mxl > 0 else 20))]

    def multi_mod(c, par, mn, mx, label):
        """Mod [code, param, min, max, label(, slots)].  min / max are the number the builder slider filters on; a label with several numbers also
        carries `slots`, one [lowest, highest] per '#' of the label in text order, so the game's tooltip numbers can be shown:
          dmg-fire / ltng / mag / cold (func 15 + 16), dmg-pois (+ func 17): min and max damage are fixed values of the row (func 15 / 16 do not roll), the
            filter is the maximum damage; poison is stored per frame in 1/256, the tooltip shows value * frames / 256 over frames / 25 seconds (param = frames)
          hit / att / gethit / kill / death / levelup-skill (func 11): param = skill, min = chance % (0 -> 5), max = skill level; the filter is the chance
          charged (func 19): param = skill, max = skill level, min = max charges (0 -> 5; < 0: level * -min / 8 - min, 1..255); the item drops with
            1 + max/8 .. max charges left (rolled); the filter is the skill level (at item level 99, lower on lower item levels)"""
        mod = [c, par, mn, mx, label]
        p = props.get(c)
        if not p or label.count("#") < 2:
            return mod
        f = p["f"]
        if f == 15:
            if "poison" in p["st"][0][1]:
                fr = num(par)
                assert fr > 0, (c, par)
                mn, mx = mn * fr // 256, mx * fr // 256
                slots = [[mn, mn], [mx, mx], [fr // 25, fr // 25]]
            else:
                slots = [[mn, mn], [mx, mx]]
            mod[2] = mod[3] = mx
        elif f == 11:
            ch = mn if mn > 0 else 5
            slots = [[ch, ch], skill_levels(par, mx)]
            mod[2] = mod[3] = ch
        elif f == 19:
            lv = skill_levels(par, mx)
            ts = []
            for L in range(lv[0], lv[1] + 1):
                t = 5 if mn == 0 else min(255, max(1, mn if mn > 0 else L * -mn // 8 - mn))
                ts.append(t)
            slots = [lv, [min(t // 8 + 1 for t in ts), max(ts)], [min(ts), max(ts)]]
            mod[2] = mod[3] = lv[1]
        else:
            return mod
        assert len(slots) == label.count("#"), (c, label)
        return mod + [slots]

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
            mods.append(multi_mod(c, par, mn, mx, label_for(c, par)))
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

    # superior bonus (qualityitems.txt): one row per superior item, uniform among the rows ITEMMODS_CanItemBeHighQuality accepts, within the first
    # 4 rows for throwable or nodurability items (D2Game ItemsMagic.cpp sub_6FC54690). Each item gets `sq` = its eligible row indices.
    qi = []
    for r in rd("qualityitems"):
        mods = []
        for i in (1, 2):
            c = r.get("mod%dcode" % i)
            if c:
                par = r.get("mod%dparam" % i, "") or "0"
                mods.append(multi_mod(c, par, num(r.get("mod%dmin" % i), 0), num(r.get("mod%dmax" % i), 0), label_for(c, par)))
        qi.append({"m": mods, "f": {k: num(r.get(k), 0) for k in ("armor", "weapon", "shield", "scepter", "wand", "staff", "bow", "boots", "gloves", "belt")}})
    SPECIAL = {"shie": "shield", "scep": "scepter", "wand": "wand", "staf": "staff", "bow": "bow", "xbow": "bow", "boot": "boots", "glov": "gloves", "belt": "belt"}

    def can_hq(it, row):
        """ITEMMODS_CanItemBeHighQuality (D2Common ItemMods.cpp): generic weapon / armor rows apply to every weapon / armor whose FIRST type is not one of
        the special types; those use their own columns (matched on the first type only)."""
        f, t = row["f"], it["t"]
        is_w, is_a = "weap" in it["anc"], "armo" in it["anc"]
        if f["weapon"] and is_w and t not in ("staf", "bow", "xbow", "scep", "wand"):
            return True
        if f["armor"] and is_a and t not in ("shie", "boot", "glov", "belt"):
            return True
        return bool(t in SPECIAL and f[SPECIAL[t]])

    for it in items.values():
        if it["k"] == "m":
            continue
        n_rows = 4 if (it["th"] or it["nd"]) else len(qi)
        it["sq"] = [i for i in range(n_rows) if can_hq(it, qi[i])]

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
        "prefixes": prefixes, "suffixes": suffixes, "automagic": automagic, "staff": staff, "qi": [r["m"] for r in qi],
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
