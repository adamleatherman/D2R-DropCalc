#!/usr/bin/env python3
"""Placement factor of every level from the real map layouts (floor share of the preset rooms).

Usage:  python tools/floor_share.py [excel-folder-with-the-tables] [--tiles <folder>] [--lod]    (prints a per-level report)
Used by build.py (`level_pl`).  Only the Python standard library is used.  Input: the lvlprest / lvlmaze / lvltypes / levels tables and
excel/tiles/**/*.ds1, *.dt1 (see tools/extract_tables.py).

What it computes.  Every spawn roll that wins puts a pack on a random spot of its room: the game tries 20 random subtiles in the room box and
takes the first one whose collision mask has no wall bit (D2Game MonsterRegion.cpp sub_6FC66260: `for i < 20`, x = rand(w-1) + left + 1, y likewise,
so the first subtile row / column of the room is never picked).  With a share f of walkable subtiles in the room the pack is placed with
P_room = 1 - (1 - f)^20.  A level's placement factor pl is the roll-weighted mean of P_room over its populated rooms.

Formats and rules, each checked against the D2MOO decompilation (https://github.com/ThePhrozenKeep/D2MOO):
  .ds1  DrlgPreset.cpp DRLGPRESET_ParseDS1File: version, width, height (the layers hold (w+1)*(h+1) cells; room size = w x h tiles), act (v>=8),
        substitution method (v>=10), strings (v>=3), 2 ints (9<=v<14), wall layers (+ tile type layer each), floor layers (v>=16, else 1), shadow.
  cell  D2DrlgRoomTile.h D2C_PackedTileInformation: style bits 20-25, sequence bits 8-15, bit 17 unwalkable, bit 27 shadow, bit 31 hidden.
        A floor / wall layer cell is a tile iff it is non-zero (bit 1 / bit 0 are always set on real cells).
  tiles DrlgRoomTile.cpp DRLGROOMTILE_LoadInitRoomTiles: floor tile = (orientation 0, style, sequence); wall tile = (tile type layer value, style,
        sequence); type 3 also places the type 4 tile; type 10 / 11 with style >= 8 and hidden doors / warps (types 8-11) place no tile; cells with
        the shadow bit also place a shadow tile (type 13).  A floor layer 0 cell without floor of a FillBlanks preset gets the hidden filler floor
        (style 30, sequence 0, or 1 in the Arcane Sanctuary).  Tile set: lvltypes File 1-32 selected by the preset's Dt1Mask bit i -> File i+1
        (DRLGROOMTILE_LoadDT1FilesForRoom), plus Blank / InvisWal / Warp.dt1.  Not modelled: lvlsub substitution dt1 files.
  .dt1  D2CMP.h D2TileLibraryEntryStrc: header nTiles at 0x10C, first entry at 0x110; entries of 0x60 bytes; orientation 0x14, style 0x18,
        sequence 0x1C, rarity 0x20, 25 collision bytes at 0x28 (read as dwTileFlags[4]; D2Collision.cpp sub_6FD411F0 reads 25 bytes, row y of the
        tile = flag row 4 - y).  Entries sharing a key are chosen by rarity (DRLGROOMTILE_GetTileCache; all rarities 0 -> the first): the blocked
        chance of a subtile is the rarity-weighted share of entries that block it.
  coll. D2Collision.cpp sub_6FD413E0: the collision mask of a room ORs the 25 flag bytes of every floor, wall and roof (shadow) tile, plus
        COLLIDE_WALL on the whole 5x5 when the tile has the unwalkable bit (MAPTILE_UNWALKABLE).  A pack spot is refused when the mask has
        COLLIDE_WALL (bit 0x01; COLLIDE_MASK_MONSTER_PATH).  The hidden bit does not change collision.  A subtile without any floor is counted as
        not walkable.  Objects, doors and other monsters are not modelled.
  rooms DrlgPreset.cpp DRLGPRESET_BuildArea: a preset is cut into 8x8-tile rooms (the last ones smaller), a maze cell up to 12x12 is one room.
"""
import csv
import glob
import math
import os
import struct
import sys

SUBTILES = 5
TRIES = 20            # random spots tried per pack (MonsterRegion.cpp sub_6FC66260)
FILLER = (0, 30)      # hidden filler floor of FillBlanks presets: orientation 0, style 30, sequence 0 (1 in the Arcane Sanctuary)
EXTRA_DT1 = ("act1/outdoors/blank.dt1", "act1/barracks/inviswal.dt1", "act1/barracks/warp.dt1")
ARCANE = 74

# D2MOO DrlgMaze.cpp DRLGMAZE_PickRoomPreset: a maze cell's preset is base + direction mask (1-15), base by level type; the lvlprest row of the
# base is named here (rows base+1 .. base+15 are the "<family> W, E, EW, S, SW, SE, SEW, N, NW, NE, NEW, NS, NSW, NSE, NSEW" cells)
MAZE_BASE = {3: "Act 1 - DOE Entrance", 4: "Act 1 - Graveyard", 7: "Act 1 - Barracks Court Connect", 8: "Act 1 - Barracks Forge N",
             10: "Act 1 - Cathedral", 13: "Act 2 - Town ", 17: "Act 2 - Desert Ruins Elder", 18: "Act 2 - Duriel's Lair",
             19: "Act 2 - Lair Tight Spot S", 22: "Act 3 - Temple 6", 24: "Act 3 - Spider Chest NE", 25: "Act 3 - Dungeon Treasure 2",
             28: "Act 4 - Lava X", 33: "Act 5 - Barricade 16 Snow", 34: "Act 5 - Lava NS"}
# level types whose presets come from a hardcoded remapping (only these cells exist): harem / basement / spider cave diagonals, Nihlathak's temple,
# the Act 5 lava levels (Hell 1-3, Pandemonium 3); DrlgMaze.cpp nExpansionHardcodedPresetsRemapping
MAZE_NAMED = {14: ["Act 2 - Corrupt Harem " + d for d in ("SW", "SE", "NW", "NE")],
              15: ["Act 2 - Basement " + d for d in ("SW", "SE", "NW", "NE")],
              23: ["Act 3 - Spider " + d for d in ("SW", "SE", "NW", "NE")],
              32: ["Act 5 - Temple SW", "Act 5 - Temple SE up", "Act 5 - Temple NW", "Act 5 - Temple NE"],
              35: ["Act 5 - Lava " + d for d in ("W", "E", "EW", "S", "N", "NS")]}
# fixed single-preset caves (DrlgMaze.cpp: Cellar of Pity = level 114 picks Ice River A or B, Echo Chamber = 116 Ice Pool A, Glacial Caves 2 = 119 Ice Pool B)
FIXED = {114: ["Act 5 - Ice River A", "Act 5 - Ice River B"], 116: ["Act 5 - Ice Pool A"], 119: ["Act 5 - Ice Pool B"]}
# Chaos Sanctuary (DrlgOutdoors.cpp nLavaLvlPrestIds): a 5x5 grid of 24x24 cells; only these 6 hold a Diablo preset, the other 19 are Lava X (Populate 0)
CHAOS = (108, 25, ["Act 4 - Diablo Arm N", "Act 4 - Diablo Arm W", "Act 4 - Diablo Heart", "Act 4 - Diablo Arm E", "Act 4 - Diablo Arm S", "Act 4 - Diablo Entry"])
# Act 3 jungles (DrlgOutJung.cpp): the whole level is covered by 32x32 river presets
JUNGLE = {76, 77, 78}
JUNGLE_BASE = "Act 3 - Jungle W"


def read_table(path):
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def num(v, d=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return d


class Tiles:
    """excel/tiles: path resolution (D2R moved some files: lvlprest says Act2/Arcane/SanctEW.ds1, the file is act2/sanctew.ds1), dt1 cache."""

    def __init__(self, root):
        self.root = root
        self.files = {}      # lower-cased relative path -> same
        self.byname = {}     # basename -> [relative paths]
        for p in glob.glob(os.path.join(root, "**", "*"), recursive=True):
            if os.path.isfile(p):
                rel = os.path.relpath(p, root).replace("\\", "/").lower()
                self.files[rel] = rel
                self.byname.setdefault(rel.rsplit("/", 1)[-1], []).append(rel)
        self.moved, self.ambiguous, self.missing = set(), set(), set()
        self._lib, self._keys, self._ds1 = {}, {}, {}

    def resolve(self, name):
        """lower-cased exact path first, then basename (same top folder preferred) -> relative path or None"""
        n = name.replace("\\", "/").lower().strip("/")
        if n in self.files:
            return n
        base = n.rsplit("/", 1)[-1]
        c = self.byname.get(base) or self.byname.get("t" + base, [])     # some files were renamed with a t prefix (Temple0.ds1 -> ttemple0.ds1)
        if not c:
            self.missing.add(name)
            return None
        same = [x for x in c if x.split("/")[0] == n.split("/")[0]]
        pick = sorted(same or c)
        if len(pick) > 1:
            self.ambiguous.add("%s -> %s" % (name, pick[0]))
        self.moved.add("%s -> %s" % (name, pick[0]))
        return pick[0]

    def dt1(self, rel):
        """-> {(orientation, style, sequence): [(rarity, flags(25 bytes))]}"""
        if rel in self._lib:
            return self._lib[rel]
        with open(os.path.join(self.root, rel), "rb") as f:
            b = f.read()
        if struct.unpack_from("<ii", b, 0) != (7, 6):
            raise ValueError("%s: dt1 version %s, only 7.6 is read" % (rel, struct.unpack_from("<ii", b, 0)))
        n, off = struct.unpack_from("<ii", b, 0x10C)
        out = {}
        for i in range(n):
            o = off + i * 0x60
            ori, style, seq, rar = struct.unpack_from("<4i", b, o + 0x14)
            out.setdefault((ori, style, seq), []).append((rar, b[o + 0x28:o + 0x28 + 25]))
        self._lib[rel] = out
        return out

    def blocked(self, libs, key):
        """libs: tuple of dt1 paths -> 25 chances (game row order, y down) that a subtile of tile `key` has the wall bit; None if no such tile"""
        ck = (libs, key)
        if ck in self._keys:
            return self._keys[ck]
        ents = []
        for lib in libs:
            ents += self.dt1(lib).get(key, [])
        res = None
        if ents:
            tot = sum(max(r, 0) for r, _ in ents)
            if tot <= 0:
                ents, ws = ents[:1], [1.0]
            else:
                ws = [max(r, 0) / tot for r, _ in ents]
            p = [0.0] * 25
            for (r, fl), w in zip(ents, ws):
                for sy in range(5):
                    for sx in range(5):
                        if fl[(4 - sy) * 5 + sx] & 1:
                            p[sy * 5 + sx] += w
            res = tuple(p)
        self._keys[ck] = res
        return res

    def ds1(self, rel):
        if rel not in self._ds1:
            with open(os.path.join(self.root, rel), "rb") as f:
                self._ds1[rel] = parse_ds1(f.read())
        return self._ds1[rel]


# D2MOO DrlgPreset.cpp DRLGPRESET_MapTileType (tile type layer of ds1 versions < 7)
OLD_TYPE = [0, 1, 2, 1, 2, 3, 3, 5, 5, 6, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 0, 0, 1, 2, 5, 5, 7, 9, 11, 13, 14, 15, 16, 17, 18, 19, 20]


def parse_ds1(b):
    """-> dict(version, w, h, walls=[layer], types=[layer], floors=[layer], shadow=layer); layers are tuples of (w+1)*(h+1) ints, row-major"""
    p = 0

    def i32():
        nonlocal p
        v = struct.unpack_from("<i", b, p)[0]
        p += 4
        return v
    ver, w, h = i32(), i32(), i32()
    if ver >= 8:
        i32()
    sub = i32() if ver >= 10 else 0
    if ver >= 3:
        for _ in range(i32()):
            p = b.index(0, p) + 1
    if 9 <= ver < 14:
        p += 8
    area = (w + 1) * (h + 1)
    if not (0 < w <= 1024 and 0 < h <= 1024) or p + 8 * area > len(b):
        raise ValueError("implausible ds1 header: version %d size %dx%d" % (ver, w, h))

    def lay():
        nonlocal p
        v = struct.unpack_from("<%di" % area, b, p)
        p += 4 * area
        return v
    walls, types, floors = [], [], []
    if ver < 4:
        walls.append(lay())
        floors.append(lay())
        types.append(lay())
        lay()
    else:
        nw = i32()
        nf = i32() if ver >= 16 else 1
        for _ in range(nw):
            walls.append(lay())
            types.append(lay())
        for _ in range(nf):
            floors.append(lay())
    if ver < 7:
        types = [tuple(OLD_TYPE[t] if 0 <= t < len(OLD_TYPE) else t for t in L) for L in types]
    return {"version": ver, "w": w, "h": h, "walls": walls, "types": types, "floors": floors, "shadow": lay()}


def room_boxes(w, h, single):
    """rooms of a preset in tiles: [(x, y, rw, rh)]"""
    if single:
        return [(0, 0, w, h)]
    return [(x, y, min(8, w - x), min(8, h - y)) for y in range(0, h, 8) for x in range(0, w, 8)]


def rolls_of(rw, rh):
    """spawn rolls of a room: one per 3x3 subtiles (PopulateRoom)"""
    return math.floor(math.floor(5 * rw / 3) * 5 * rh / 3)


def ds1_share(tiles, rel, libs, fill_blanks, arcane, single):
    """-> dict(rolls, f, pl, w, h, nofloor, nokey): roll-weighted mean walkable share and placement chance over the rooms of one ds1"""
    d = tiles.ds1(rel)
    w, h, stride = d["w"], d["h"], d["w"] + 1
    nokey = [0]

    def walk_probs(cell):
        """25 blocked chances for the tile data at one cell, or None when there is no floor"""
        blk, floor = [1.0] * 25, False       # blk holds the chance that a subtile is still free; turned into blocked below
        tiles_here = []
        for L in d["floors"]:
            v = L[cell]
            if v:
                floor = True
                tiles_here.append(((0, (v >> 20) & 63, (v >> 8) & 255), v))
        if not floor and fill_blanks:
            floor = True
            tiles_here.append(((0, 30, 1 if arcane else 0), 0))
        for L, T in zip(d["walls"], d["types"]):
            v, t = L[cell], T[cell]
            if not v:
                continue
            style, seq = (v >> 20) & 63, (v >> 8) & 255
            if t in (10, 11) and style >= 8:
                continue
            if v < 0 and t in (8, 9, 10, 11):
                continue
            tiles_here.append(((t, style, seq), v))
            if t == 3:
                tiles_here.append(((4, style, seq), v))
        for L in list(d["walls"]) + list(d["floors"]) + [d["shadow"]]:
            v = L[cell]
            if v and (v >> 27) & 1:
                tiles_here.append(((13, (v >> 20) & 63, (v >> 8) & 255), 0))
        if not floor:
            return None
        for key, v in tiles_here:
            if (v >> 17) & 1:
                return [0.0] * 25
            p = tiles.blocked(libs, key)
            if p is None:
                nokey[0] += 1
                p = tiles.blocked(libs, (10, 0, 0))     # missing tile -> first (10, 0, 0) entry (DRLGROOMTILE_GetTileCache)
            if p:
                blk = [a * (1 - q) for a, q in zip(blk, p)]
        return blk

    free = []                                  # per cell, 25 chances of being walkable (game row order)
    nofloor = 0
    for y in range(h):
        for x in range(w):
            r = walk_probs(y * stride + x)
            if r is None:
                nofloor += 1
            free.append(r)
    rolls = fsum = psum = 0.0
    for x0, y0, rw, rh in room_boxes(w, h, single):
        tot = n = 0.0
        for sy in range(1, 5 * rh):            # the first subtile row / column of a room is never picked (sub_6FC66260)
            for sx in range(1, 5 * rw):
                c = free[(y0 + sy // 5) * w + x0 + sx // 5]
                if c is not None:
                    tot += c[(sy % 5) * 5 + sx % 5]
                n += 1
        f = tot / n if n else 0.0
        r = rolls_of(rw, rh)
        rolls += r
        fsum += r * f
        psum += r * (1 - (1 - f) ** TRIES)
    return {"rolls": rolls, "f": fsum / rolls, "pl": psum / rolls, "w": w, "h": h, "nofloor": nofloor / (w * h), "nokey": nokey[0]}


class Layouts:
    def __init__(self, table_dir, tiles_dir):
        self.t = Tiles(tiles_dir)
        self.levels = {num(r["Id"], -1): r for r in read_table(os.path.join(table_dir, "levels.txt")) if r.get("Id")}
        self.rows = read_table(os.path.join(table_dir, "lvlprest.txt"))
        self.types = {num(r["Id"], -1): r for r in read_table(os.path.join(table_dir, "lvltypes.txt")) if r.get("Id")}
        self.maze = {num(r["Level"]): r for r in read_table(os.path.join(table_dir, "lvlmaze.txt")) if r.get("Level")}
        self.byname = {}
        for i, r in enumerate(self.rows):
            self.byname.setdefault(r["Name"], i)
        self.cache = {}
        self.notes = {}

    def libs(self, ltype, mask):
        row = self.types.get(ltype, {})
        out = []
        for i in range(32):
            f = row.get("File %d" % (i + 1), "")
            if (mask >> i) & 1 and f and f != "0":
                r = self.t.resolve(f)
                if r:
                    out.append(r)
        for f in EXTRA_DT1:
            r = self.t.resolve(f)
            if r:
                out.append(r)
        return tuple(out)

    def preset(self, row_index, ltype, lid=0):
        """mean over the ds1 files of one lvlprest row -> dict(rolls, f, pl, nf) or None (Populate 0 / no file)"""
        key = (row_index, ltype, lid)
        if key in self.cache:
            return self.cache[key]
        r = self.rows[row_index]
        res = None
        if num(r["Populate"]):
            libs = self.libs(ltype, num(r["Dt1Mask"]))
            single = 0 < num(r["SizeX"]) <= 12 and 0 < num(r["SizeY"]) <= 12
            parts = []
            for i in range(1, max(1, num(r["Files"])) + 1):     # the game rolls the file among File1..Files (0 = File1 only; DRLGPRESET_SetPickedFile)
                rel = self.t.resolve(r["File%d" % i]) if r["File%d" % i] not in ("", "0") else None
                if rel:
                    parts.append(ds1_share(self.t, rel, libs, bool(num(r["FillBlanks"])), lid == ARCANE, single))
            if parts:
                res = {k: sum(p[k] for p in parts) / len(parts) for k in ("rolls", "f", "pl", "nofloor", "nokey")}
                res["nf"] = len(parts)
                res["wh"] = (parts[0]["w"], parts[0]["h"])
        self.cache[key] = res
        return res

    def mean(self, rows, ltype, lid=0, denominator=None):
        """equal-weight mean over lvlprest rows -> (f, pl, used) ; denominator > len(rows): the missing share holds Populate 0 rooms (no monsters)"""
        got = [self.preset(i, ltype, lid) for i in rows]
        got = [g for g in got if g]
        if not got:
            return None
        n = denominator or len(got)
        return (sum(g["f"] for g in got) / n, sum(g["pl"] for g in got) / n, len(got))

    def level(self, lid):
        """-> dict(pl, f, how) ; pl None when the level has no preset model (the engine then assumes 1)"""
        L = self.levels[lid]
        dt, ltype = num(L["DrlgType"]), num(L["LevelType"])
        name = L.get("Name", "")
        if dt == 2:
            idx = [i for i, r in enumerate(self.rows) if num(r["LevelId"]) == lid]
            m = self.mean(idx, ltype, lid)
            return {"how": "preset %s" % ", ".join(self.rows[i]["Name"] for i in idx), "m": m}
        if dt == 1:
            mz = self.maze.get(lid)
            if lid in FIXED:
                idx = [self.byname[n] for n in FIXED[lid]]
                return {"how": "fixed " + "/".join(FIXED[lid]), "m": self.mean(idx, ltype, lid)}
            if ltype in MAZE_NAMED:
                idx = [self.byname[n] for n in MAZE_NAMED[ltype]]
                return {"how": "cells " + ", ".join(n.rsplit(" ", 1)[-1] for n in MAZE_NAMED[ltype]), "m": self.mean(idx, ltype, lid)}
            if ltype in MAZE_BASE and mz:
                b = self.byname[MAZE_BASE[ltype]]
                idx = list(range(b + 1, b + 16))
                sz = (num(mz["SizeX"]), num(mz["SizeY"]))
                m = self.mean(idx, ltype, lid)
                if m and self.rows[b + 1]["SizeX"] and (num(self.rows[b + 1]["SizeX"]), num(self.rows[b + 1]["SizeY"])) != sz:
                    return {"how": "maze cells %s: lvlmaze cell %dx%d differs from the preset size" % (MAZE_BASE[ltype], sz[0], sz[1]), "m": None}
                return {"how": "15 cells after '%s'" % MAZE_BASE[ltype], "m": m}
            return {"how": "maze, no preset family", "m": None}
        if lid in JUNGLE:
            b = self.byname[JUNGLE_BASE]
            return {"how": "15 river cells '%s'.." % JUNGLE_BASE, "m": self.mean(list(range(b, b + 15)), ltype, lid)}
        if lid == CHAOS[0]:
            idx = [self.byname[n] for n in CHAOS[2]]
            return {"how": "6 of %d cells hold Diablo presets (rest Lava X, Populate 0)" % CHAOS[1], "m": self.mean(idx, ltype, lid, CHAOS[1])}
        return {"how": "open outdoor (generated fill): not modelled", "m": None}


def level_pl(table_dir, tiles_dir):
    """-> {level id: {"pl": placement factor or None, "f": walkable share, "how": text}} for every level of levels.txt"""
    lay = Layouts(table_dir, tiles_dir)
    out = {}
    for lid, r in sorted(lay.levels.items()):
        if lid <= 0:
            continue
        res = lay.level(lid)
        m = res["m"]
        out[lid] = {"name": r.get("Name", ""), "drlg": num(r["DrlgType"]), "how": res["how"],
                    "pl": m[1] if m else None, "f": m[0] if m else None, "n": m[2] if m else 0}
    out["_tiles"] = lay.t
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = args[0] if args else os.path.join(here, "excel")
    if "--lod" in sys.argv:
        src = os.path.join(src, "base")
    tiles = os.path.join(args[0] if args else os.path.join(here, "excel"), "tiles")
    if "--tiles" in sys.argv:
        tiles = sys.argv[sys.argv.index("--tiles") + 1]
    res = level_pl(src, tiles)
    t = res.pop("_tiles")
    print("%4s  %-28s %s  %6s %6s  %s" % ("id", "name", "drlg", "f", "pl", "presets"))
    for lid, r in res.items():
        print("%4d  %-28s %4d  %6s %6s  %s" % (lid, r["name"][:28], r["drlg"], "-" if r["f"] is None else "%.3f" % r["f"],
                                              "(1)" if r["pl"] is None else "%.4f" % r["pl"], r["how"]))
    print("\nfallback (pl not modelled, engine uses 1): %s" % ", ".join(str(k) for k, v in res.items() if v["pl"] is None))
    print("files found under another path (lvlprest / lvltypes path -> file): %d" % len(t.moved))
    for s in sorted(t.moved)[:8]:
        print("   ", s)
    print("ambiguous: %s" % (sorted(t.ambiguous) or "none"))
    print("missing: %s" % (sorted(t.missing) or "none"))


if __name__ == "__main__":
    main()
