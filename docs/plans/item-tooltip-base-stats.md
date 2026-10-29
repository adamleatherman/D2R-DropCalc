# Plan: base stats in the item tooltip (defense, damage, requirements)

Status: planned (2026-10-29). Needs `excel/` (the build and the tests); written on a machine without it.

## Goal

The item tooltip (`itemTipHtml` in `app.js`; hover an item name in tab 2's table, tab 1's headline or a search suggestion) shows
name, base, set, type and tier, required level, quality level, stat lines and sockets, but none of the base's own stats. Add them
the way the game lists them, between the type line and the required level:

* armor: `Defense: 98-141`, shields also `Chance to Block: 20%` (and the Paladin / class block where the table has it), boots `Kick
  Damage: 37-64`
* weapons: `One-Hand Damage: 31-35` / `Two-Hand Damage: 12-60` (both lines for the 1-or-2-handed swords), `Throw Damage: ...` for
  throwing weapons, the attack speed class (`[Very Fast Attack Speed]`, from the base's `speed` / WSM) if it is cheap to add
* `Required Strength: 50`, `Required Dexterity: 25` (only the ones above 0)
* `Durability: 12` (`Indestructible` for `nodurability` bases such as the Phase Blade; no line for jewelry and charms)

`data.json` has none of these: `build.py` exports per item only what the drop math needs (quality level, level requirement, sockets,
durability flags; see the `it = {` dict under the item loop, with `gs` / `sz` / `nd` / `hd`).

## 1. Export the base stats (`build.py`)

In the item loop (weapons.txt / armor.txt rows; misc has none), add a compact `bs` object only where values exist, e.g.
`{"ac": [min, max], "blk": n, "kick": [min, max], "d1": [min, max], "d2": [min, max], "dt": [min, max], "rs": n, "rd": n, "dur": n, "spd": n}`.
Columns to check in the extracted tables (names differ between versions; print the headers first):

* armor.txt: `minac`, `maxac`, `block`, `mindam` / `maxdam` (boots kick, belt?), `reqstr`, `reqdex` (may not exist for armor),
  `durability`, `nodurability`
* weapons.txt: `mindam` / `maxdam` (one-hand), `2handmindam` / `2handmaxdam`, `minmisdam` / `maxmisdam` (throw), `1or2handed`,
  `2handed`, `reqstr`, `reqdex`, `speed`, `durability`, `nodurability`, `StrBonus` / `DexBonus` (not shown, skip)

Keep data size in mind: only non-zero fields, short keys. Both `data.json` and `data-lod.json` (LoD tables may lack RotW bases).

## 2. Show them (`app.js` `itemTipHtml`)

For a plain base: the ranges as the table gives them (`Defense: 98-141`; one value when min = max).

For a unique / set item, the game's tooltip applies the item's own stats. Do it, but only where the rule is verified (D2MOO, or a
known in-game item to compare against); otherwise show the base values with a dim "(base)" note:

* **Defense**: an item with `+% Enhanced Defense` uses the base's **max** defense (+1? D2MOO `ITEMS_GetDefense` / item creation:
  check whether ED items roll maxac or maxac + 1), then `floor(def * (100 + ED) / 100)`, then flat `+# Defense` (`ac`); `ac/lvl`
  (per character level) as a range over levels 1-99 like the stat lines do. Ranges: ED min..max gives a defense range.
* **Damage**: `floor(base * (100 + ED) / 100)` on min and max, plus `+# to Minimum / Maximum Damage` (`dmg-min`, `dmg-max`,
  `dmg%`, and the `dmg/lvl` kinds); ED% from `dmg%` mod ranges.
* **Ethereal**: not modelled in the tooltip (an item is either; skip, or one line "Ethereal: x1.5 defense / damage, -10 requirements").
* **Requirements**: `ease` (`Requirements -#%`) lowers Str / Dex; apply if present.
* **Durability**: `+# Maximum Durability` (`dur`), `Indestructible` (`indestruct`) replaces the line.

Mod codes are the property codes of `u.mods` (`m[0]`), e.g. `ac%`, `ac`, `dmg%`, `dmg-min`, `dmg-max`; confirm the codes in
properties.txt. Builder text and stat lines stay as they are: these become separate gray / white lines above them, like the game.

## 3. Tests, README

* `tests.js` / `test_engine.py`: a few known items, e.g. Shako base `Defense: 98-141`, Phase Blade `One-Hand Damage: 31-35`, Monarch
  `Required Strength: 156`, Harlequin Crest's defense range, a Grand Matron Bow, a 2H sword with both damage lines. Check the numbers
  against the game or a trusted item guide before writing them in.
* README: the tooltip paragraph in Tab 2 lists what the tooltip shows; add the base stats and the unique / set rule used.
* `tools/theme_contrast.py`, if a new tooltip colour class is added.

Then: `python build.py` -> `python test_engine.py` -> commit `data.json` + `data-lod.json` with the code, and set this Status.
