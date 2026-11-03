# Plan: "points" conditions for rares in the item builder (rings first)

Status: planned (2026-11-03), not started. Written on a machine without `excel/`; the engine work and its tests need the
machine with the game tables (`python test_engine.py`). Replaces the "10 FCR ring" preset of `docs/plans/popular-items.md`
(phase 2 there), which is too common to be worth farming: on the community scale below it is a 1-point ring.

## Goal

Rare rings (later amulets, circlets, boots, gloves) are valued by **how many useful affixes they have and how well each one
rolled**, not by one stat. The builder should answer "what are the odds of a rare ring with 10 FCR and at least 4.5
points", per item level and per farm, exactly like it answers today's "all of these" picks.

## The community point scale (research, 2026-11-03)

d2jsp convention (credited to KFO), restated in War The Wise's ladder ring guide on diablo2.io:

* Each useful affix scores **1 point at >= 66% of its perfect roll, 1/2 point at 33-66%**, 0 below. Useless affixes (stamina,
  light radius, gold find, mana after kill, charges, ...) score 0. A rare ring has at most 3 prefixes + 3 suffixes: 6 is the top.
* Grades: **<= 3.5 Charsi** (sold to the vendor), **4 usable / borderline sellable, 4.5 good, 5 great, 5.5 elite, 6 top of ladder**.

Perfect values checked against our `data.json` (rare, spawnable ring affixes, RotW 3.3.93847); thresholds = ceil(66% / 33%):

| Affix (builder stat key) | Side (group) | Perfect (tier, alvl) | 1 point | 1/2 point |
|---|---|---|---|---|
| `+#% Faster Cast Rate` | suffix (9) | 10 (Apprentice, 5; one tier only) | 10 | - |
| `+# to Strength` | suffix (31) | 20 (Titan 16-20, 74) | 14 | 7 |
| `+# to Dexterity` | suffix (17) | 15 (Precision 10-15, 56) | 10 | 5 |
| `+# to Life` | suffix (26) | 40 (Mammoth 31-40, 68) | 27 | 14 |
| `Replenish Life +#` | suffix (19) | 9 (Regrowth 6-9, 55) | 6 | 3 |
| `+# to Minimum Damage` | suffix (15) | 9 (Excellence 6-9, 59) | 6 | 3 |
| `+# to Mana` | prefix (115) | 90 (Great Wyrm's 61-90, 37) | 60 | 30 |
| `+# to Attack Rating` | prefix (110) | 120 (Platinum 101-120, 22) | 80 | 40 |
| `All Resistances +#` | prefix (116) | 11 (Rainbow 8-11, 56) | 8 | 4 |
| `Fire / Cold / Lightning / Poison Resist +#%` (each its own group) | prefix (117-120) | 30 (21-30, 18) | 20 | 10 |

Melee list adds `#% Life stolen per hit` (suffix 27, perfect 8, Lamprey alvl 77: 6 / 3) and `#% Mana stolen per hit` (suffix
28, perfect 6, Vampire alvl 86: 4 / 2). Magic find: suffix 22 (up to 15) or prefix 114 (up to 10); not in the default lists.
Re-check the table against `data-lod.json` when implementing (LoD may differ in tiers).

Consequences the calculator will show by itself: FCR, strength, dexterity, life, replenish and min damage are **all suffixes**
(a ring holds FCR + two of them at most), so 5+ points needs good prefixes (mana, AR, resistances); perfect strength / life
need alvl 74 / 68, so the item level matters.

The scale is community opinion, not game data (a weighted variant on the Blizzard forum ranks FCR > str > dex > life > mana >
AR > replenish > all res > single res > min damage; players note that equal totals can differ a lot in value). The builder
reports odds of "points >= N", never a price.

## Design

### Conditions

Keep the `conds` array (it already travels through the worker, the cache keys, `cardOdds`, `ilvlCurve`, the farm search and the
URL). Add two kinds of entries:

* **Point stat**: `{ key, min: <full threshold>, half: <half threshold or 0>, pt: 1 }`. Optional `req: 1` = must be at full
  (FCR on a caster ring: required and counted).
* **Need**: exactly one `{ key: '#pts', min: <half points needed> }` when any point stat is present (4.5 points = 9).

`condProb` returns 0 for `#pts` (no affix has that key). Functions that ignore point stats today must not mistake them for
plain minimums: grep every `conds.` use in engine.js / app.js / worker.js when implementing.

### Engine (exact, no sampling)

The exact rare code (`rareExact`, `rareSteps`) and the magic enumeration already track **which conditions are met** as a bit
set per side and join the sides with `fin(ua | ub)` (engine.js, `rareExact` join loop). Points fit that shape:

1. **Two bits per point stat** (full, half). They are nested, so do not treat them as independent per affix (the current
   per-condition miss product `m *= 1 - c` assumes independence; for the same stat from the same affix that is wrong).
   For a point stat with affixes k that give it: P(full) = 1 - prod(1 - pf_k), P(at least half) = 1 - prod(1 - ph_k),
   outcomes {none, half only, full (both bits)} with those masses. Plain conditions keep the current product.
2. **Acceptance** replaces "every A bit set": `accept(U)` = every plain / `req` bit in U and `sum over point stats of
   (full ? 2 : half ? 1 : 0) >= need`. Apply it where `fin(U)` is evaluated (rareExact join, rareSteps end, magic path).
   The rest (automagic row, staff mods, extras) can still meet plain conditions as today; point stats are met by affixes
   only (no ring / amulet / circlet / boot has an automagic row; note it as a limit in the README).
3. **Bit budget**: rareExact falls back to rareSteps above 30 A-conditions. Caster ring list = 10 point stats + resist split
   = 13 stats x 2 bits = 26 + FCR; melee adds 2 more stats. Measure; if it falls back, either merge "any single resistance"
   into one 3-outcome stat per group or raise the cap.
4. **Cache keys** already include `JSON.stringify(conds)`; nothing to add.
5. **Feasibility** (`planCombo` / `comboForBase` / `comboAnalysis`): plain conditions as today; then the most points
   reachable with the remaining prefix / suffix slots and groups (small DFS over the point stats' sources, scoring full
   values) must be >= need. "Not possible" explanations name the shortfall ("at most 4 points with FCR on a ring").
6. **Magic**: at most 1 prefix + 1 suffix, so a magic item can reach 2 points; allowed, nothing special.

### Builder UI (tab 3)

* A **Points** block in the item card, under the picks: "at least [N] points" (3 to 6 by 0.5) and the list of point stats
  with their full / half thresholds (prefilled from `CONFIG.pointScales.ring`, editable, a stat can be removed).
* The odds lines show the points block as one line (`perCond` entry for the block as a whole), like a pick.
* URL: `&pn=<half points>` and `&ps=<stat key>:<full>:<half>[:r]` repeated; old links unaffected.

### Presets (replace "10 FCR ring")

* `Caster ring: 10 FCR + 4 points`, `... + 4.5 points`, `... + 5 points` (rare ring, FCR `req`, caster list).
* `Melee ring: life steal + 4 points`, `... + 5 points` (rare ring, life steal `req` at its half threshold or more, melee
  list: str, dex, life, AR, life steal, mana steal, resistances, min damage).
* Later (separate scales, same engine): rare amulets (+2 class skills required, points over FCR / str / life / res / mana),
  circlets (+2 class skills + 20 FCR required, points over sockets / life / str / res / FRW), boots (30 FRW required, points
  over resistances / FHR / str / dex / MF).

## Tests (need `excel/`)

* **Monte Carlo against the Python reference**: extend `rare_mc` in test_engine.py to score points per sampled ring and
  compare P(points >= N) with the engine for N = 3 .. 6 on a ring at ilvl 85 (and one LoD case), within the sampling bound
  the other rare_mc checks use.
* **Identities**: no point stats = today's numbers (every existing check unchanged); need = all full = the same stats as plain
  picks; need 0 = the required picks alone; P(>= N) non-increasing in N; FCR `req` with need 2 (only FCR's own point) = plain
  10 FCR.
* **Nesting**: one stat with full 14 / half 7 and need 1 (half point) equals a plain `+# to Strength >= 7` pick.
* Feasibility: 6 points with FCR + three suffix stats is reported impossible on a ring (four suffixes).
* Every preset loads (existing preset test) and its odds are > 0 in both modes.
* README: a "Points" paragraph under the builder with the scale, the thresholds, the source and the limits above.

## Sources

* diablo2.io, "Rare Ring Guide: Ladder" (diablo2.io/forums/rare-ring-guide-ladder-t883855.html): the 66% / 33% rule, perfect
  values, grades, worked example (10 FCR / 120 AR / 15 str / 20 life / 18 cold / 27 lightning = 5 points).
* d2jsp, "What Exactly Is A 5 Point Ring?" (forum 148, t=91996996) and "Can Someone Explain Ring Point System" (forum 206,
  t=99079435): origin of the scale and its criticism.
* Blizzard forum, "PC this FCR ring" (us.forums.blizzard.com/en/d2r/t/pc-this-fcr-ring/119036): weighted table, caveats.
* Loot Goblin item valuation guide (d2r-lootgoblin.com/Guides/ItemValuation): score tiers, slot profiles.
