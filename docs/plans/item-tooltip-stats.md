# Plan: stat lines in the item tooltip

Status: done (2026-10-29). Beyond the plan: min / max damage halves are merged into one "Adds" line, description groups (all
attributes / all resistances) are merged, lines sorted by descpriority, invisible and unknown property codes left out (the build lists the
unknown ones on spawnable items: RotW's magdam-rand, roguesbow-affix1, skilltab-war), random class skills (Hellfire Torch) shown as
"+3 to [random class] Skill Levels", charges shown full. Written 2026-10-28.

## Goal

The item tooltip (`itemTipHtml` in `app.js`; hover an item name in tab 2's table or tab 1's headline) shows name, base, set,
type, tier, required level, quality level and max sockets. Add the item's **stat lines** the way the game lists them, e.g.
Harlequin Crest: `+2 to All Skills`, `+(1-148) to Life (Based on Character Level)`, `+(1-148) to Mana (Based on Character
Level)`, `Damage Reduced by 10%`, `50% Better Chance of Getting Magic Items`, `+2 to All Attributes`, with ranges where the
item rolls. The tooltip describes every copy of the item (what can roll), not one item's roll.

`data.json` has no unique / set item properties today: `build.py` exports only id, name, code, levels, rarity and flags for
`uniqueitems` and `setitems` (search `# ------------------------------------------------------ uniques / sets`).

## 1. Export the properties (`build.py`)

The affix code already turns properties into description keys: `parse_affix` (mod1..3 code / param / min / max ->
`multi_mod(c, par, mn, mx, label_for(c, par))`, with the descfunc 5/10 rescaling). Reuse it:

* `uniqueitems.txt`: `prop1..prop12`, `par1..par12`, `min1..min12`, `max1..max12`. Add a `mods` list per unique with the same
  `multi_mod` output as affixes (`[label, min, max, ...]`, incl. the sixth `slots` element for labels with several numbers).
* `setitems.txt`: the item's own `prop1..prop9` / `par` / `min` / `max` -> `mods`. The partial set bonuses `aprop1a..aprop5b`
  (green "(2 items)" lines on the item) -> `smods: [[count, mod], ...]` (`aprop1a/b` = 2 items, `aprop2a/b` = 3 items, ...).
  The full set bonuses (`sets.txt`, `PCode2a..PCode5b`, `FCode1..FCode8`) -> per set `bonus` (optional; the tooltip can list
  them dimmed).
* Keep the property loop in one helper (e.g. `parse_props(r, prefix, n)`) shared with `parse_affix`, so the rescaling and
  the special cases (`dmg%`, skill tabs, charges, chance-to-cast, per-level stats) stay identical.
* Rebuild both files: `python build.py` (writes `data.json` and `data-lod.json`). They grow by roughly the unique / set
  property text; check the size stays reasonable (gzip on GitHub Pages).

## 2. Render (`app.js`, `engine.js`)

* `Engine.describe(key, min, max, slots)` already formats a mod (`+10-20% Faster Cast Rate`); use it for each mod.
* In `itemTipHtml`: after Required Level / Quality level, one line per mod in magic blue (the game's colour for item stats:
  add a tooltip-local `--tip-stat` like the other tooltip colours in `.itip`, `#8080ff`), set bonuses in green with "(2 items)",
  "(3 items)" ...; keep max sockets gray at the end.
* Per-level stats (`... (Based on Character Level)`): show the range for character levels 1-99 or "per level", as the
  builder does for `sliderWhat` / `describeAt`.
* **Range format (decided 2026-10-28): parentheses around each varying number**, as item guides write them:
  `+(120-150)% Enhanced Defense`, `Adds (10-15)-(25-40) Fire Damage`, `+(1-148) to Life (Based on Character Level)`.
  Fixed values once, without parentheses: `+2 to All Skills`. Only the tooltip uses this; the item builder keeps `+10-20%`.
  Implement as an option of `Engine.describe` (e.g. a 5th argument `{ paren: true }`, used where the range `st(s)` is
  formatted) rather than a second formatter, so both stay in step.

## 3. Tests

* `tests.js` / `test_engine.py`: a few known items against their in-game text derived from the raw tables (as validation
  item 11 does for affixes): Harlequin Crest, Stone of Jordan, Tal Rasha's Horadric Crest (with its set bonuses),
  Annihilus, a PreCrafted Sunder charm, a staff-mod unique (+skill to a class tab), an item with charges.
* No `#` left in any unique / set description (like the affix check).
* Range format: a varying stat in parentheses, a fixed one without (`+(120-150)% Enhanced Defense` vs `+2 to All Skills`),
  per-level stats as the level 1-99 range in parentheses; the builder's text unchanged.
* `python3 -I tools/theme_contrast.py` if the tooltip colours change (the tooltip is dark in both themes: check the new
  colour against its background `rgba(10,10,12,.95)`, e.g. as a fixed pair).

## Not in scope

* Rune words, crafted items, gems and rune socket bonuses (runes' `gemstats` / `runes.txt`): a later step if wanted.
* Item images: Blizzard's art, not for a public site.
