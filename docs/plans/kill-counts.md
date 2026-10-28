# Plan: more trustworthy kills per run

Status: not started (written 2026-10-28). Needs a machine with the extracted D2R tables (`excel/`, `excel/tiles/`) and,
for step 1, a Lord of Destruction 1.14d `levels.txt`. Related: `docs/plans/tal-rashas-tombs.md` (the tombs are one case of
the same problem).

## Why

Chance per kill comes straight from the drop tables and is well tested. Kills per run (whole-area clears) is the weak part:
`areaRun` in `engine.js` applies spawn rules from the D2MOO decompilation of LoD 1.10-1.14 to each area's size, then one
global `CONFIG.run.placeFactor = 0.56`. That factor is not from the code: it was fitted so the Hell Cow Level gives about
516 cows per run, a count from a LoD-era guide (the rules alone give about 924). It scales every area. Nothing has been
checked against D2R itself. Fixed-kill farms (bosses, super uniques and their minions: seal pop, council, Pindleskin, ...)
do not use this model and are solid.

Confidence ranking (2026-10-28, Hell): best are the Cow Level (it is the calibration point) and the regular caves (size from
the replayed cave generator, `tools/maze_cells.py`); weaker are open outdoor areas (levels.txt bounding box, walkable share
`pl` = 1), Act 5 outdoors (64x160 linker size), Act 3 jungles, preset-built levels; weakest are Chaos Sanctuary (`pl` 0.18),
Arcane Sanctuary (350 kills looks high), Halls of Vaught (`pl` 0.36) and Tal Rasha's Tomb (see the tombs plan).

Known D2R changes so far are table changes, which the calculator already reads from D2R's own files: patch 2.4 raised
monster levels in a set of areas to 85 and increased unique monster density there (e.g. Ancient Tunnels, Drifter Cavern,
Icy Cellar have 6-8 unique packs in Hell in `data.json`). No evidence found either way about changes to the spawn code or
the map generators.

## 1. Diff D2R's levels.txt against LoD 1.14d (do this first)

Goal: an exact list of the density / size / pack settings D2R changed through the tables, and a check that the 0.56
calibration still holds.

* Get a 1.14d `levels.txt` (from the classic game's MPQs, or a community-hosted 1.14d txt dump; note its source in the
  README). D2R's own LoD-mode copy (`excel/base/levels.txt`) is **not** 1.14d: it is D2R's data for the LoD mode.
* Add `tools/levels_diff.py` (standard library, like the other tools): match rows by `Id` / `Name`, compare at least
  `MonDen`, `MonDen(N)`, `MonDen(H)`, `MonUMin*`, `MonUMax*`, `SizeX*`, `SizeY*`, `NumMon`, `mon1..`, `nmon1..`, `umon1..`,
  `MonLvl*`, `MonLvlEx*`, `Rangedspawn`. Print a table of changed rows (area, column, 1.14d, D2R) for both D2R folders
  (`excel/` RotW and `excel/base/` LoD mode).
* **The Cow Level row decides the calibration.** If its density / size / pack columns are unchanged from 1.14d, the
  LoD-era count still fits D2R's tables and 0.56 stands. If they changed, either rescale the guide's count with the change
  (e.g. density x1.25 -> expect about 1.25x cows) or drop it and wait for a D2R count (step 5); update
  `CONFIG.run.placeFactor` and its comment, and the README "Per-run estimate" paragraph.
* Record the findings in the README (a short "D2R vs 1.14d tables" note: which areas changed and how), so the reasoning
  is not lost.

## 2. Terror zone raw fields

`build.py` reads `excel/hd/desecratedzones.json` (search `desecratedzones`) and exports level bounds, the level boost, XP
and the herald tiers. Check the raw file for any density-like field (monster density, pack counts, champion / unique
counts) that is not exported. If one exists, export it and apply it in `areaRun` when the terror zone is on; add a test.
If none exists, note "terror zones do not change density in the data" in the README.

## 3. Replay the outdoor generator (biggest structural win)

Like `tools/maze_cells.py` for caves: replay D2MOO's outdoor generation (`DrlgOutdoors.cpp`, `DrlgOutRoom.cpp`,
`DrlgOutDesr.cpp`, `DrlgOutJung.cpp`, `DrlgOutSiege.cpp`, ...) for many seeds per outdoor level and difficulty, measure the
walkable share of the generated rooms with the `tools/floor_share.py` rules, and export the mean populated area per level
(`geo.sim` for outdoor levels). This replaces the bounding box and `pl` = 1 for Act 1-2 wilderness, Act 3 jungles and the
Act 5 outdoors. Store the result like `tools/maze_cells.json` (seeds, digest of the input tables).

## 4. Preset-built levels, and the 0.56 factor

* Build the preset-heavy levels from their actual preset pieces: Arcane Sanctuary, Chaos Sanctuary, Travincal, Durance of
  Hell 3, Halls of Vaught, Tal Rasha's tomb variants (see the tombs plan). Settles the "looks high" flags (Arcane 350,
  the tombs).
* Read the D2MOO spawn path closely (`D2GAME_PopulateRoom_6FC67190`, `MonsterRegion.cpp`, room activation, collision checks,
  any per-room or per-level cap) to find which real rules the 0.56 stands in for. Replace it with those rules where found;
  keep a smaller residual factor only for what is still unexplained, and say so.

## 5. Check against D2R

Steps 1-4 can only reproduce LoD rules on D2R's tables; only real counts catch D2R code changes. Do a few careful manual
full-clear counts in D2R (Hell, 1 player): a cave (Ancient Tunnels or the Pit), an open outdoor area, Chaos Sanctuary,
Arcane Sanctuary and the Cow Level. Several runs each. Compare with the engine; if caves and outdoors disagree in the same
direction, split `placeFactor` into a cave and an outdoor factor. Record the counts and their sources in the README.

## Tests

* `test_engine.py`: the levels diff tool's output is current (or its findings are frozen in a fixture); the Cow Level
  calibration (engine count == the target count within the fit tolerance) after any `placeFactor` change.
* For step 3: the outdoor replay is reproducible (seeded) and its digest matches the input tables, like `maze_cells.json`.
* Every change to kills per run: the fixed-kill farms (seal pop, council, Pindleskin, ...) and every chance per kill stay
  unchanged.

## Not in scope

* Decompiling the D2R client: Blizzard's license forbids reverse engineering it. Use D2MOO (LoD 1.10-1.14) plus in-game
  counts instead.
* How thoroughly a player clears an area (dead ends skipped, monsters out of reach): no game file says; the model stays a
  full clear.
