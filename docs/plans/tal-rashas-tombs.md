# Plan: Tal Rasha's Tombs per-run math

Status: not started (written 2026-10-28). Work it on a machine that has the extracted game tables (`excel/`), so `build.py`
and `test_engine.py` can run.

## Problem

The seven Tal Rasha's Tombs (levels 66-72) are byte-identical in `levels.txt`, so the engine lists them once, as level 66
(`Engine.DUP_OF`, `engine.js` near "Areas that are exact copies"). `tools/maze_cells.py` simulates every tomb level as the
**staff (true) tomb**, so that row's whole-area clear means "clear the one true tomb" (about 18.2 populated cells).

The generator (`DrlgDrlg.cpp`, replayed in `tools/maze_cells.py`) actually picks two different random tombs of the seven:
the **staff tomb** (orifice, `nAct2TombTalRashaIds`) and the **boss tomb** (Ancient Kaa, `nAct2TombKaaIds`). The other five
are plain tombs (with a chest preset). Mean cells per case, already in `tools/maze_cells.json` ->
`levels["66"]["tomb_cases"]` (`tomb_split`, 2000 seeds; `[mean cells, runs]`):

| Case | Tombs per game | Cells (Hell) |
|---|---|---|
| staff (true tomb) | 1 | 18.24 |
| boss (Kaa) | 1 | 12.71 |
| plain | 5 | 6.37 |

Kills per run scale with spawn rolls, which scale with cells (`areaRolls` in `engine.js`). So:

* **All seven tombs** (the usual farm, especially as a terror zone: levels 66-73 are all in the TZ list) is about
  18.24 + 12.71 + 5 x 6.37 = 62.8 cells, about **3.4x** what the app shows today.
* **One random tomb** averages about 9 cells, about **0.5x** what the app shows.
* Only "clear just the true tomb" matches today's numbers.

## Plan

### 1. Populated cells per tomb case (`tools/maze_cells.py`)

`tomb_split` records `len(lv.rooms)`, i.e. all cells. The engine uses **populated** cells (lvlprest `Populate 1` rows; see
`populated_mean` and `build.py` around `L["geo"]["cells"] = ...sim...`). For the staff tomb both are 18.24, but for the plain
and boss tombs a preset cell (chest, Kaa) may not be populated. Extend `tomb_split` to also store the populated count per
case (count rooms whose preset has `Populate` = 1, the same rule `run()` uses for `populated_mean`), e.g.
`tomb_cases[dN][case] = [mean cells, runs, mean populated]`. Re-run `python -I tools/maze_cells.py` (needs `excel/`; its
digest check then matches) and commit the new `tools/maze_cells.json`.

### 2. Export the cases (`build.py`)

Where `build.py` sets `L["geo"]` for maze levels (search `L["geo"]["sim"] = 1`), add for level 66 only:
`L["geo"]["tomb"] = {"staff": [p0, p1, p2], "boss": [...], "plain": [...]}` (populated cells per difficulty, from step 1).
Run `python build.py` so both `data.json` and `data-lod.json` carry it. Keep `geo.cells` as is (the staff tomb), so every
existing number stays the same.

### 3. Engine: a tomb-case scale in runs (`engine.js`)

Kills per run of every area row of level 66 are linear in `geo.cells` (rolls = cells x rolls per cell; champion / unique packs
and their minions too), except the preset monsters (Ancient Kaa, a super unique counted once per game, and Tal Rasha's
`pre` monsters, if any). So a run can scale the level-66 rows instead of re-running `areaRun` per case:

* Add a run option, e.g. `scale: { 66: <factor> }`, applied in `runSources` to the rows of a `clear` area: `perRun x factor`
  for regular / champion / unique / minion rows; super uniques and bosses keep `perRun` 1.
* Factor for all seven tombs = (staff + boss + 5 x plain) / staff, per difficulty, from `D.levels[66].geo.tomb`
  (compute it in the engine, not by hand).
* Check `areaRun` (`engine.js`, `function areaRun`) for any term that is not linear in cells (e.g. `warpLossRooms`, the
  `A.pre` preset monsters, `R.mazeSpecialCells`); if one exists, either compute each case with its own cells (a small
  `areaRun` variant taking a cells override) or note the approximation in the README.

### 4. Runs and farms (`engine.js` `CONFIG.runs` / `CONFIG.farms`)

* `tombs7: { name: "Tal Rasha's Tombs (all seven)", area: 66, su: [], boss: [], clear: [66], scale: 'tombs7' }` (or however
  step 3 spells it). Ancient Kaa stays one kill (he is the boss tomb's super unique; `SU_AREA` places him in 66).
* Act 2 farms: `"Tal Rasha's Tombs: all seven"` (`run|tombs7`) and `"Tal Rasha's Tomb: true tomb"` (`''`, the existing
  whole-area clear of 66). The farm list groups by act and puts variants with a shared prefix next to each other.
* Optional: `"Tal Rasha's Tomb: one random tomb"` (factor = (staff + boss + 5 x plain) / 7 / staff). Only if it is useful.

### 5. Labels

* The area name of 66 in the Area lists and the info line: say "(true tomb)" so a whole-area clear is not read as all seven
  (`app.js`: the Area options are built in `useEngine`, `areas.map(...)`; the README "Per-run estimate" paragraph describes
  the TRUE tomb already).
* README: Tab 2 farm list, named runs (`scale`), the Per-run estimate paragraph (all seven = sum of the three cases), the
  validation list.

### 6. Tests

`tests.js` (JSON for `test_engine.py`) and `test_engine.py` facts:

* `runSources(ctx, 'tombs7', d)` total kills / true-tomb total kills == (staff + boss + 5 x plain) / staff per difficulty, from
  the raw `tools/maze_cells.json` (independent of `data.json`), within the non-linear terms found in step 3.
* Ancient Kaa: exactly one kill in the all-seven run.
* The true-tomb farm and the old `?t3a=66` link give the same numbers as before (no regression).
* `test_engine.py`: the populated counts per case in `maze_cells.json` match a fresh `tomb_split` (or at least that
  `staff` populated == `populated_mean` of level 66).
* Run: `python3 test_engine.py` (headless Chrome / Edge + `excel/`), `python3 -I tools/theme_contrast.py` if labels or
  colours changed.

## Checks before committing

* Hell, all seven tombs: kills per run about 3.4x the true tomb (62.8 / 18.24 cells, adjusted for presets).
* Popular farms tab: both tomb farms under Act 2; per-run odds of the all-seven farm above the true tomb for every item.
* Terror zone on: the tomb rows use the TZ levels / Desecrated TCs as before.
* LoD mode: same tombs (levels 66-72 exist in both data files).

## Not in scope

* Tal Rasha's Chamber (73, Duriel) stays its own area; a "tombs + Duriel" run could be a later named run (`clear: [66]` +
  `boss: ['duriel']` + the scale).
* Whether D2R changed the tomb generator: the model replays the LoD 1.10-1.14 decompilation, like every other cave.
