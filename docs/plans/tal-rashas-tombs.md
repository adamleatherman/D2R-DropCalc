# Plan: Tal Rasha's Tombs per-run math

Status: not started (written 2026-10-28; tab 1 section, named-runs follow-up and per-case elite packs added the same day). Related:
`docs/plans/kill-counts.md` (kills per run in general; its step 1 checks the calibration every area, the tombs included, rests on). Work it on a machine that has the extracted game tables (`excel/`), so `build.py`
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

Regular kills per run scale with spawn rolls, which scale with cells (`areaRolls` in `engine.js`); elite packs do not
(every tomb gets about 8-9 in Hell, see step 3). So:

* **All seven tombs** (the usual farm, especially as a terror zone: levels 66-73 are all in the TZ list) is about
  18.24 + 12.71 + 5 x 6.37 = 62.8 cells: about **3.5x** the kills and **6.6x** the elite packs the app shows today.
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

### 3. Engine: level 66 means all seven tombs by default (`engine.js`)

Decision (2026-10-28): the merged "Tal Rasha's Tomb" row should mean **all seven tombs** everywhere a whole-area clear is
used (tab 1, tab 2's Other area..., the item builder's farm table), because that is how the tombs are farmed; the true tomb
alone becomes the special case (a tab 2 farm). Doing it in the engine keeps every tab consistent.

**Compute each tomb case with its own cells; do not scale the true tomb by one factor.** Regular kills are about linear in
cells, but champion / unique packs are not: `areaRun` spawns them until the level's MonUMin is reached (Hell 7, MonUMax 9;
`levels.txt` 66: umin 0/4/7, umax 2/6/9), so even a small plain tomb gets about 8 elite packs. Measured with the current
engine by overriding `geo.cells` of level 66 (Hell, 1 player, 2026-10-28, before step 1's populated counts):

| Case | Cells | Kills | Elite packs (champion packs + uniques) |
|---|---|---|---|
| staff (true tomb) | 18.24 | 626 | 8.99 |
| boss (Kaa tomb) | 12.71 | 437 | 8.92 |
| plain | 6.37 | 221 | 8.30 |
| **all seven** (staff + boss + 5 x plain) | 62.8 | **about 2168** | **about 59.4** |

One factor of 3.44 on the true tomb would give about the same kills (2160) but only about 31 elite packs: half the champions
and uniques, which matter most for drops. (Community figure for comparison: "7-9 boss / elite packs per tomb in Hell",
i.e. MonUMin / MonUMax restated; it agrees with the per-case model.)

So:

* Give `areaRun` (`engine.js`, `function areaRun`) a cells override (or a case argument read from `D.levels[66].geo.tomb`),
  keeping its cache keyed on it.
* In `sources()` (the "regular area monsters" loop, where `run = areaRun(lid, d)` is used), for level 66 build the rows from
  `areaRun(staff) + areaRun(boss) + 5 x areaRun(plain)`, per monster type and rank. Keep the per-case values on each row
  (e.g. `cases: { staff, boss, plain }` = kills per run of that row in one tomb of the case) so runs can pick a case (step 4).
  Super unique and boss rows keep `perRun` 1 (Ancient Kaa once). Mark the rows (e.g. `tombs: 7`) so the UI can label them.
* Also check `areaRun` for other terms that are not linear in cells (`warpLossRooms`, `A.pre` preset monsters,
  `R.mazeSpecialCells`); the per-case computation handles them automatically.
* Put it behind `CONFIG` (e.g. `CONFIG.run.tombsAllSeven: true`) so the tests can compare against the old numbers.

### 4. Runs and farms (`engine.js` `CONFIG.runs` / `CONFIG.farms`)

* Add a run option `tombCase: 'staff' | 'boss' | 'plain'` to `runSources`: for the rows of a `clear` area that carry
  `cases` (step 3), use `perRun = cases[tombCase]` instead of the all-seven value (super uniques and bosses keep 1).
* `truetomb: { name: "Tal Rasha's Tomb (true tomb only)", area: 66, su: [], boss: [], clear: [66], tombCase: 'staff' }`.
  Ancient Kaa is not in the true tomb: leave his row out of this run (he is in the boss tomb).
* Act 2 farms: `"Tal Rasha's Tombs: all seven"` (`''`, the whole-area clear of 66, now all seven) and
  `"Tal Rasha's Tomb: true tomb"` (`run|truetomb`). The farm list groups by act and puts variants with a shared prefix next to
  each other.
* Optional: `"Tal Rasha's Tomb: one random tomb"` (the all-seven rows / 7). Only if it is useful.

### 5. Tab 1 (item search)

Per kill nothing changes (all seven tombs share monsters, levels and TCs); only the per-run numbers move, and with step 3
they move by themselves:

* **Group by Area** (`groupAreas` in `app.js`, fed by `allRows` -> `getSources` -> `E.areaSources`): the tomb row's kills per
  run and chance per run become the all-seven values (about 3.5x the kills, about 6.6x the elite packs). Label it "Tal
  Rasha's Tombs (all seven)" (from the row mark of step 3) and add a tooltip: "all seven tombs; the true tomb alone has
  about 29% of the kills and 15% of the elite packs (tab 2: Tal Rasha's Tomb: true tomb)".
* **Monster view**: the tomb monsters' kills/run cells scale the same way, so both views agree; Ancient Kaa stays one kill.
* "Best per run" in the headline can now pick the tombs where it should.
* There is no tab 1 -> tab 2 link today; if one is added (see the follow-up below), a tomb row should open the all-seven farm.

### 6. Labels

* The area name of 66 in the Area lists and the info lines: "Tal Rasha's Tombs (all seven)" (`app.js`: the Area options are
  built in `useEngine`, `areas.map(...)`; `srcWhere` / `areaName` for rows).
* README: Tab 2 farm list, the `scale` run option, the Per-run estimate paragraph (it says the row is the TRUE tomb: change
  to all seven = sum of the three cases, true tomb = the tab 2 farm), the Merged rows paragraph (`DUP_OF` note:
  "kills/run stays per tomb (the true staff tomb)" changes), the validation list.

### 7. Tests

`tests.js` (JSON for `test_engine.py`) and `test_engine.py` facts:

* Level-66 area rows, per difficulty and rank: all-seven kills == staff + boss + 5 x plain of three independent
  `areaRun` calls with the case cells from the raw `tools/maze_cells.json` (independent of `data.json`). Hell, current
  engine: about 2168 kills and 59.4 elite packs (step 3 table; they move a little once step 1 adds populated counts).
* Elite packs per tomb case within MonUMin..MonUMax (Hell 7-9, NM 4-6, Normal 0-2) for every case, the plain tomb
  included. Use `CONFIG.run.tombsAllSeven = false` for the old numbers.
* `runSources(ctx, 'truetomb', d)` == the old whole-area clear of 66 without Ancient Kaa (no regression for the true tomb).
* Ancient Kaa: exactly one kill in the all-seven clear, none in the true-tomb run.
* Tab 1 per-kill odds of every tomb row unchanged; per-run odds of the area row == 1 - prod (1 - p)^kills with the scaled kills.
* `test_engine.py`: the populated counts per case in `maze_cells.json` match a fresh `tomb_split` (or at least that
  `staff` populated == `populated_mean` of level 66).
* Run: `python3 test_engine.py` (headless Chrome / Edge + `excel/`), `python3 -I tools/theme_contrast.py` if labels or
  colours changed.

## Checks before committing

* Hell, all seven tombs: about 2168 kills and 59 elite packs per run (true tomb: 626 and 9.0).
* Popular farms tab: both tomb farms under Act 2; per-run odds of the all-seven farm above the true tomb for every item.
* Tab 1: an item the tomb monsters drop (e.g. a mid rune) ranks the tombs higher per run than before, Group by Area shows
  "Tal Rasha's Tombs (all seven)" with the tooltip, per-kill odds unchanged.
* Item builder farm table: the tomb rows' per-run odds move the same way (it uses the same `perRun`).
* Terror zone on: the tomb rows use the TZ levels / Desecrated TCs as before.
* LoD mode: same tombs (levels 66-72 exist in both data files).

## Not in scope

* Tal Rasha's Chamber (73, Duriel) stays its own area; a "tombs + Duriel" run could be a later named run (`clear: [66]` +
  `boss: ['duriel']`).
* Whether D2R changed the tomb generator: the model replays the LoD 1.10-1.14 decompilation, like every other cave.

## Follow-up (separate change): named runs in tab 1

Tab 1 does not know about named runs (`CONFIG.runs`): the seal pop, Travincal council, Mephisto + council, Pindleskin,
Shenk + Eldritch, The Pit (both levels), Arcane ghosts + Summoner and the true tomb exist only in tab 2. Idea:

* In **Group by Area**, add one row per popular farm that is a run (`CONFIG.farms` with `src` `run|...`), next to the area
  rows: per kill = kill-weighted average, per run = 1 - prod (1 - p)^kills over `E.runSources(ctx, run, diff, list)` (the
  same numbers as tab 2). Label with the farm name and a "farm" tag; the Area / Act filters match the run's area(s)
  (a run can span areas: Shenk + Eldritch, The Pit).
* "Best per run" in the headline then considers farms too (e.g. picks "Chaos: seal pop" or "Mephisto: + full council" when
  they beat a whole-area clear).
* Clicking a farm row (or any area row) could open tab 2 on that farm / area (`?t3a=...&t3m=...`), giving tab 1 -> tab 2
  navigation.
* Cost: one `runSources` + `chanceFor` per farm per search; 17 farms, a few ms. Cache with the existing `allRows` cache
  (`allCache`, keyed on the target and settings).
* Tests: a farm row's per-run odds == tab 2's for the same farm and item; the seal pop row is never above the Chaos full
  clear row (as in tab 2).
* Open question for then: whether the Monster view should list runs at all (probably not: it is per monster type).
