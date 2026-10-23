#!/usr/bin/env python3
"""Preset monsters: the monsters the map layouts (.ds1 unit lists) place directly, expected per full clear of every level.

Usage:  python tools/preset_monsters.py [excel-folder-with-the-tables] [--tiles <folder>] [--lod] [level ids...]    (prints a per-level report)
Used by build.py (`level_pre`).  Only the Python standard library is used.  Reuses floor_share (ds1 parser, path resolution, lvlprest tables).

What a preset monster is.  A .ds1 holds a unit list (DrlgPreset.cpp DRLGPRESET_ParseDS1File: unit type, id, x, y, flags): type 1 = monster, id = row of
monpreset.txt in the file's act (rows of Act 1..5 are consecutive; ids past the table are dropped).  The row's Place is resolved at load time
(MonsterTbls.cpp DATATBLS_MonPresetPlaceLinker) first as a super unique (superuniques.txt), else a monster (monstats Id), else a monplace.txt code.
DRLGPRESET_AddPresetUnitToDrlgMap keeps the Act 2 vendors, lightning spires and fire towers with chance 1/3 (rand % 3 == 0) per map copy.
When a room is activated the game spawns its preset units before the random population (Game.cpp sub_6FC385A0: SUNIT_SpawnPresetUnitsInRoom, then
D2GAME_PopulateRoom): SUNIT_SpawnPresetUnit -> SUNIT_CreatePresetUnit -> D2GAME_SpawnPresetMonster_6FC66560 (MonsterRegion.cpp):
  monster id           one monster of that type (critters are never spawned; the NPCs / traps / spires are listed but have no treasure class)
  super unique         D2GAME_SpawnSuperUnique_6FC6F690 (modelled by the super unique rows; here it only counts towards the unique cap)
  place_unique_pack    2: a unique pack of a type from the level (Normal: umon list, NM / Hell: by rarity) with 3-6 minions, no champion roll (sub_6FC6E8D0, a5 = 0)
  place_champion       3: a champion pack (leader + 1-3 champions) of the same kind of pick
  place_rogue_warner   4: navi            place_bloodraven   5: bloodraven            place_tightspotboss   8: maggotqueen1
  place_tentacle_ns / ew   10 / 11: tentaclehead chain by level (Great Marsh, jungles +1, Sewers 2)
  place_fallen / fallenshaman / fetish / fetishshaman   17 / 18 / 22 / 23: that type, mapped to the level's own variant (D2Common_11063: the
                       mon1.. entry of the same base class, else up the NextInClass chain while its Normal level <= the level's MonLvlEx + 1),
                       then Black Marsh / Tamoe / Pit overrides to fallen2 / 3 and shaman2 / 3
  place_impgroup / miniongroup   24 / 26: only in Normal (nDifficulty != 0 returns): imp1 (deathmauler1 in the Bloody Foothills) / minion1 with
                       MinGrp..MaxGrp members (the first one + rand(MaxGrp - MinGrp + 1) - 1 more)
  place_reanimateddead 32: reanimatedhorde3 (dead mode, flag set; its AI (AITHINK_Fn114_ReanimatedHorde) is a valid target and reanimates)
  place_deadminion / deadimp / deadbarb   29 / 30 / 31: dead corpses (mode MONMODE_DEAD, never killed): not counted
  everything else (npc_pack, rivermonster, amphibian, nests, talking guards, maggot / mosquito, imp, minion, bloodlord, group25..100): no spawn
Preset monsters sit at fixed spots: no MonDen roll, no placement loss.  Unique packs, champion packs and super uniques raise the level's unique
count (MonsterUnique.cpp D2GAME_SpawnMonster_6FC6F220 / D2GAME_MONSTERS_Unk_6FC6FFD0: ++dwUniqueCount), which MONSTERCHOOSE_GetBossSpawnType
compares with MonUMin / MonUMax; plain monsters (even act bosses) do not.  Level, drops: same as random monsters (Monster.cpp: monstats Level,
Expansion NM / Hell the area's MonLvlEx unless the monster is a boss or noRatio).

Which presets a level uses (expected count of each, per difficulty).  Preset levels (DrlgType 2): their lvlprest row.  Maze levels: lvlmaze Rooms
cells (`Rooms` / `(N)` / `(H)`), a cell is the family preset of its direction mask (equal weights, as floor_share); the Act 1-3 types roll
max(2, rooms / 5 + 1) of them into theme presets (DrlgMaze.cpp DRLGMAZE_RollAct_1_2_3_BasicPresets: preset + 15, masks 1-14); special presets are
placed once (DRLGMAZE_GenerateLevel and the PlaceAct* functions) and replace a cell; the SPECIAL table below lists the ones with monsters, each
4-direction variant equally likely.  Outdoor levels: only those whose preset list is fixed by the code (Act 1 wilderness DrlgOutWild.cpp
DRLGOUTWILD_SpawnSpecialPresets, Act 4 mesas DrlgOutdoors.cpp DRLGOUTDOORS_InitAct4OutdoorLevel, Travincal DrlgOutPlace.cpp, Bloody Foothills
DrlgOutSiege.cpp: 15 strips).  Not modelled: generated fill (Act 2 desert, jungles' clearings, Kurast, Act 5 barricade / Arreat / Tundra fill and prisons).
"""
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import floor_share as fs

TENTACLE_ROW = 261                       # MonsterRegion.cpp: MONSTERMODE_GetMonStatsTxtRecord(261) = tentaclehead1
TENTACLE_LEVELS = {76: 1, 77: 1, 78: 1, 92: 2, 93: 2}   # chain steps (everywhere else 0)
FALLEN_LEVELS = {6: ("fallen2", "fallenshaman2"), 7: ("fallen3", "fallenshaman2"), 12: ("fallen3", "fallenshaman3"), 16: ("fallen3", "fallenshaman3")}
FOOTHILLS = 110
# AddPresetUnitToDrlgMap: kept with chance 1/3
THIRD = {"act2vendor1", "act2vendor2", "lightningspire", "firetower"}
NOT_SPAWNED = {"place_nothing", "place_npc_pack", "place_rivermonster_right", "place_rivermonster_left", "place_amphibian", "place_fallennest",
               "place_fetishnest", "place_talkingrogue", "place_talkingguard", "place_dumbguard", "place_maggot", "place_maggotegg", "place_mosquitonest",
               "place_imp", "place_minion", "place_bloodlord", "place_group25", "place_group50", "place_group75", "place_group100"}
DEAD = {"place_deadminion", "place_deadimp", "place_deadbarb"}
# special presets with monsters: level id -> [(row name or 4-variant prefix, expected count)]; "prefix*" = mean of the W / E / S / N rows
SPECIAL = {
    8: [("Act 1 - Cave Den Of Evil *", 1)], 9: [("Act 1 - Cave Coldcrow *", 1)],         # super unique presets (counted towards the unique cap only)
    18: [("Act 1 - Crypt Bonebreak *", 1)],
    19: [("Act 1 - Crypt Chest *", 1)], 133: [("Act 1 - Crypt Chest *", 1)],           # Mausoleum, Pandemonium Run 1
    28: [("Act 1 - Barracks Court Connect", 1), ("Act 1 - Barracks Forge *", 1)],
    30: [("Act 1 - Jail Pitspawn *", 1)],
    49: [("Act 2 - Sewer Radament's Lair *", 1)], 65: [("Act 2 - Sewer Chest *", 1)],     # Sewers 3, Ancient Tunnels
    59: [("Act 2 - Tomb Chest *", 1), ("Act 2 - Tomb Leatherarm *", 1)],                 # Stony Tomb 2
    60: [("Act 2 - Tomb Cube *", 1)],                                                    # Halls of the Dead 3
    64: [("Act 2 - Lair Tight Spot S", 1)],
    85: [("Act 3 - Spider Chest NW", 1)],
    92: [("Act 3 - Sewer Chest *", 1), ("Act 3 - Sewer Drain *", 1)],
    107: [("Act 4 - Lava Forge W", 0.5), ("Act 4 - Lava Forge E", 0.5)],
    113: [("Act 5 - Ice Down *", 1)], 115: [("Act 5 - Ice Down *", 1), ("Act 5 - Ice Theme *", 1)], 118: [("Act 5 - Ice Down *", 1)],
}
for _l in range(66, 73):                                                                # Tal Rasha's tombs: chest unless it is the staff tomb (6 of 7), Kaa in the boss tomb (1 of 7)
    SPECIAL[_l] = [("Act 2 - Tomb Chest *", 6 / 7), ("Act 2 - Tomb Kaa *", 1 / 7)]
# levels that are one single special preset (DRLGMAZE_GenerateLevel: Claw Viper Temple 2 is Tainted Sun X alone)
ONLY = {61: [("Act 2 - Tomb Tainted Sun X", 1)]}
THEME_TYPES = {3, 4, 7, 8, 10, 13, 17, 22, 24, 25}      # level types rolled by DRLGMAZE_RollAct_1_2_3_BasicPresets (not the Den of Evil)
NO_THEMES = {8}
# fixed Act 1 wilderness presets (DRLGOUTWILD_SpawnSpecialPresets; a (rand & 3) coin = 1/4, two cottages / camps 1/4, a third cottage 3/4 * 1/2)
OUTDOOR = {
    2: [("Act 1 - Cottages 1", 1.25)],
    3: [("Act 1 - Cottages 2", 1.25), ("Act 1 - Cottages 3", 0.375), ("Act 1 - Fallen Camp Bishibosh", 1)],
    4: [("Act 1 - Camp", 1), ("Act 1 - Cairn Stones", 1), ("Act 1 - Cottages 1", 1.25), ("Act 1 - Cottages 3", 0.375), ("Act 1 - Fallen Camp 1", 1.25)],
    5: [("Act 1 - Inifus", 1), ("Act 1 - Ruin", 1), ("Act 1 - Tree Fill", 1), ("Act 1 - Cottages 2", 1.25), ("Act 1 - Cottages 3", 0.375),
        ("Act 1 - Fallen Camp 2", 1.25)],
    6: [("Act 1 - Cottages 1", 1.25), ("Act 1 - Cottages 3", 0.375), ("Act 1 - Fallen Camp 1", 1.25)],
    7: [("Act 1 - Cottages 2", 1.25), ("Act 1 - Cottages 3", 0.375), ("Act 1 - Fallen Camp 2", 1.25)],
    39: [("Act 1 - Bivouac", 1)],
    83: [("Act 3 - Travincal " + s, 1) for s in ("NW", "N", "NE", "SW", "S", "SE")],
}
# Act 4 mesas: (mesa preset family, pits family, counts of +0..+4 and +0..+3)
MESA_COUNTS = [1, 2, 2, 2, 4]
PITS_COUNTS = [1, 2, 2, 4]
MESA_SIZES = ["24X24", "16X16", "16X08", "08X16", "08X08"]
PITS_SIZES = ["16X16", "16X08", "08X16", "08X08"]
MESAS = {104: (1, 1), 105: (2, 2), 106: (3, 2)}


def norm(s):
    return " ".join(s.split()).lower()


class PresetMonsters:
    def __init__(self, table_dir, tiles_dir):
        self.lay = fs.Layouts(table_dir, tiles_dir)
        self.t = self.lay.t
        rd = lambda n: fs.read_table(os.path.join(table_dir, n))
        self.mp = collections.defaultdict(list)                     # 0-based act -> Place names (monpreset.txt rows)
        for r in rd("monpreset.txt"):
            self.mp[fs.num(r["Act"]) - 1].append(r["Place"])
        self.place = [r["code"] for r in rd("monplace.txt")]
        self.su = {norm(r["Superunique"]): r["Superunique"] for r in rd("superuniques.txt") if r.get("Superunique")}
        ms = rd("monstats.txt")
        self.ms = {r["Id"]: r for r in ms if r.get("Id")}
        self.ms_rows = [r.get("Id", "") for r in ms]
        self.ms_lower = {norm(k): k for k in self.ms}
        ms2 = {r["Id"]: r for r in rd("monstats2.txt") if r.get("Id")}
        self.critter = {k for k, r in self.ms.items() if fs.num(ms2.get(r.get("MonStatsEx"), {}).get("critter"))}
        self.units_cache = {}
        self.unresolved = collections.Counter()
        self.rows_by_name = {}
        for i, r in enumerate(self.lay.rows):
            self.rows_by_name.setdefault(norm(r["Name"]), i)

    # ------------------------------------------------------------------ units of one lvlprest row
    def classify(self, act, idx):
        pl = self.mp.get(act, [])
        if not (0 <= idx < len(pl)):
            return ("unk", "act%d#%d" % (act, idx))
        n = pl[idx]
        if norm(n) in self.su:
            return ("su", self.su[norm(n)])
        if norm(n) in self.ms_lower:
            return ("mon", self.ms_lower[norm(n)])
        low = [p.lower() for p in self.place]
        if n.lower() in low:
            return ("place", self.place[low.index(n.lower())])
        return ("unk", n)

    def row_units(self, idx):
        """-> Counter {(kind, name): expected units}: mean over the File1..Files of the lvlprest row (Files 0 -> File1 only)"""
        if idx in self.units_cache:
            return self.units_cache[idx]
        r = self.lay.rows[idx]
        files = [r["File%d" % i] for i in range(1, max(1, fs.num(r["Files"])) + 1)]
        files = [f for f in files if f not in ("", "0")]
        out = collections.Counter()
        for f in files:
            rel = self.t.resolve(f)
            if not rel:
                continue
            for t, uid, x, y, flag in self.t.ds1(rel)["units"]:
                if t != 1 or flag & 1:          # UNIT_MONSTER; bSpawned & 1 = not spawned from the layout
                    continue
                kind = self.classify(self.t.ds1(rel)["act"], uid)
                out[kind] += (1 / 3 if kind[0] == "mon" and kind[1] in THIRD else 1) / len(files)
        self.units_cache[idx] = out
        return out

    # ------------------------------------------------------------------ monster class rules
    def base(self, mid):
        b = self.ms[mid].get("BaseId")
        return b if b in self.ms else mid

    def chain(self, mid):
        """nMaxChainId: monsters of the BaseId / NextInClass chain, base first"""
        n, cur = 0, self.base(mid)
        while cur in self.ms and n < 256:
            n += 1
            nxt = self.ms[cur].get("NextInClass")
            if nxt == cur or nxt not in self.ms:
                break
            cur = nxt
        return n

    def level_variant(self, lid, mid):
        """Monsters.cpp D2Common_11063: the level's own variant of monster mid"""
        L = self.lay.levels.get(lid)
        if not L:
            return mid
        normal = [L["mon%d" % i] for i in range(1, 26) if L.get("mon%d" % i) in self.ms]
        if not normal:
            return mid
        base = self.base(mid)
        for m in normal:
            if self.base(m) == base:
                return m
        res, nxt = mid, self.ms[base].get("NextInClass")
        for _ in range(self.chain(mid)):
            if nxt not in self.ms or fs.num(self.ms[nxt].get("Level")) > fs.num(L.get("MonLvlEx")) + 1:
                return res
            res, nxt = nxt, self.ms[nxt].get("NextInClass")
        return res

    def spawn(self, code, lid, d):
        """SpawnPresetMonster for a monplace class -> [(kind, key, count)]; kind 'mon' (monster id), 'u' unique pack, 'c' champion pack"""
        ms = self.ms
        if code == "place_unique_pack":
            return [("u", None, 1)]
        if code == "place_champion":
            return [("c", None, 1)]
        if code == "place_rogue_warner":
            return [("mon", "navi", 1)]
        if code == "place_bloodraven":
            return [("mon", "bloodraven", 1)]
        if code == "place_tightspotboss":
            return [("mon", "maggotqueen1", 1)]
        if code in ("place_tentacle_ns", "place_tentacle_ew"):
            mid = self.ms_rows[TENTACLE_ROW]
            cur = self.base(mid)
            for _ in range(TENTACLE_LEVELS.get(lid, 0)):
                cur = ms[cur].get("NextInClass")
            return [("mon", cur, 1)]
        if code in ("place_fallen", "place_fallenshaman", "place_fetish", "place_fetishshaman"):
            mid = {"place_fallen": "fallen1", "place_fallenshaman": "fallenshaman1", "place_fetish": "fetish1", "place_fetishshaman": "fetishshaman1"}[code]
            mid = self.level_variant(lid, mid)
            ov = FALLEN_LEVELS.get(lid)
            if ov and self.base(mid) == "fallen1":
                mid = ov[0]
            elif ov and self.base(mid) == "fallenshaman1":
                mid = ov[1]
            return [("mon", mid, 1)]
        if code in ("place_impgroup", "place_miniongroup"):
            if d != 0:
                return []
            mid = ("deathmauler1" if lid == FOOTHILLS else "imp1") if code == "place_impgroup" else "minion1"
            mid = self.level_variant(lid, mid)
            lo, hi = fs.num(ms[mid].get("MinGrp")), fs.num(ms[mid].get("MaxGrp"))
            return [("mon", mid, (lo + hi) / 2)] if lo and hi and hi >= lo else []
        if code == "place_reanimateddead":
            return [("mon", self.level_variant(lid, "reanimatedhorde3"), 1)]
        if code in DEAD or code in NOT_SPAWNED:
            return []
        self.unresolved[code] += 1
        return []

    # ------------------------------------------------------------------ which presets a level uses
    def row(self, name):
        return self.rows_by_name.get(norm(name))

    def named(self, name, w):
        """[(row, weight)] for a row name; 'prefix*' = mean of the W / E / S / N variants"""
        if name.endswith("*"):
            rows = [self.row(name[:-1] + s) for s in "WESN"]
            rows = [r for r in rows if r is not None]
            return [(r, w / len(rows)) for r in rows]
        r = self.row(name)
        return [(r, w)] if r is not None else []

    def maze(self, lid, d):
        lay, L = self.lay, self.lay.levels[lid]
        ltype, mz = fs.num(L["LevelType"]), lay.maze.get(lid)
        if not mz:
            return []
        cells = fs.num(mz[("Rooms", "Rooms(N)", "Rooms(H)")[d]])
        if lid in ONLY:
            return [x for name, w in ONLY[lid] for x in self.named(name, w)]
        if lid in fs.FIXED:
            names = fs.FIXED[lid]
            return [(lay.byname[n], 1 / len(names)) for n in names if n in lay.byname]
        if ltype in fs.MAZE_NAMED:
            names = [n for n in fs.MAZE_NAMED[ltype] if n in lay.byname]
            spec = [x for name, w in SPECIAL.get(lid, []) for x in self.named(name, w)]
            plain = max(0, cells - sum(w for _, w in spec))
            return spec + [(lay.byname[n], plain / len(names)) for n in names]
        if ltype not in fs.MAZE_BASE or fs.MAZE_BASE[ltype] not in lay.byname:
            return []
        b = lay.byname[fs.MAZE_BASE[ltype]]
        spec = [x for name, w in SPECIAL.get(lid, []) for x in self.named(name, w)]
        s = sum(w for _, w in spec)
        theme = 0
        if ltype in THEME_TYPES and lid not in NO_THEMES:
            theme = min(max(2, cells // 5 + 1), max(0, cells - s))
        plain = max(0, cells - s - theme)
        out = list(spec) + [(b + k, plain / 15) for k in range(1, 16)]
        if theme:
            out += [(b + 15 + k, theme / 14) for k in range(1, 15)]
        return out

    def level_rows(self, lid, d):
        L = self.lay.levels.get(lid)
        if not L:
            return []
        dt = fs.num(L["DrlgType"])
        if dt == 2:
            return [(i, 1) for i, r in enumerate(self.lay.rows) if fs.num(r["LevelId"]) == lid]
        if dt == 1:
            return self.maze(lid, d)
        if lid in OUTDOOR:
            return [x for name, w in OUTDOOR[lid] for x in self.named(name, w)]
        if lid in MESAS:
            m, p = MESAS[lid]
            out = []
            for k, (sz, c) in enumerate(zip(MESA_SIZES, MESA_COUNTS)):
                out += self.named("Act 4 - Mesa %d %s" % (m, sz), c)
            for sz, c in zip(PITS_SIZES, PITS_COUNTS):
                out += self.named("Act 4 - Pits %d %s" % (p, sz), c)
            if lid == 105:
                out += self.named("Act 4 - Mesa 2 Izual", 1)
            return out
        if lid == FOOTHILLS:
            b = self.row("Act 5 - Siege To Town")
            return [(b + i, 1) for i in range(15)] if b is not None else []
        return []

    def level(self, lid):
        """-> {"mon": {monster id: [N, NM, H]}, "u": [..], "c": [..], "k": [..], "su": {name: [..]}} expected per full clear (unique packs, champion packs,
        units counting towards the unique cap, super uniques placed)"""
        res = {"mon": collections.defaultdict(lambda: [0.0] * 3), "u": [0.0] * 3, "c": [0.0] * 3, "k": [0.0] * 3, "su": collections.defaultdict(lambda: [0.0] * 3),
               "other": collections.Counter()}
        for d in range(3):
            for idx, w in self.level_rows(lid, d):
                for (kind, key), n in self.row_units(idx).items():
                    n *= w
                    if kind == "mon":
                        if key not in self.critter:
                            res["mon"][key][d] += n
                    elif kind == "su":
                        res["su"][key][d] += n
                        res["k"][d] += n
                    elif kind == "place":
                        for k2, key2, c in self.spawn(key, lid, d):
                            if k2 == "mon":
                                res["mon"][key2][d] += n * c
                            else:
                                res[k2][d] += n * c
                                res["k"][d] += n * c
                    else:
                        res["other"][key] += n
        return res


def level_pre(table_dir, tiles_dir):
    """-> ({level id: level(...) result}, PresetMonsters) for every level of levels.txt"""
    pm = PresetMonsters(table_dir, tiles_dir)
    return {lid: pm.level(lid) for lid in sorted(pm.lay.levels) if lid > 0}, pm


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    root = args[0] if args and not args[0].isdigit() else os.path.join(here, "excel")
    ids = [int(a) for a in args if a.isdigit()]
    src = os.path.join(root, "base") if "--lod" in sys.argv else root
    tiles = sys.argv[sys.argv.index("--tiles") + 1] if "--tiles" in sys.argv else os.path.join(root, "tiles")
    res, pm = level_pre(src, tiles)
    f3 = lambda v: "/".join("%.2f" % x for x in v)
    for lid, r in res.items():
        if ids and lid not in ids:
            continue
        mons = ", ".join("%s %s" % (k, f3(v)) for k, v in sorted(r["mon"].items()) if any(v))
        sus = ", ".join("%s %s" % (k, f3(v)) for k, v in sorted(r["su"].items()))
        print("%3d %-26s packs u %s c %s  cap %s | %s | SU %s" % (lid, pm.lay.levels[lid].get("Name", "")[:26], f3(r["u"]), f3(r["c"]), f3(r["k"]), mons, sus))
    print("unresolved places:", dict(pm.unresolved) or "none")


if __name__ == "__main__":
    main()
