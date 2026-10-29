# Plan: popular item presets in the item builder

Status: phase 1 done (2026-10-29): 67 presets in `CONFIG.itemPresets` (engine.js), a Popular items list in the builder, a test that
every preset loads in both modes. Differences from the table below: picks are stats only (under "Stats (any affix that gives them)", no
affix families, which keeps the presets independent of family ids); rare amulets are 2/10 (amulets roll at most 10% FCR, 20 needs a craft);
the 7 MF charm has a 5@ variant but no 20 life one (MF and life are both suffixes); tri-res boots are fire / cold / lightning >= 30; Spirit
and Infinity bases load as normal quality (switch to superior by hand); the chosen preset is not stored in the URL (the link already holds
the full builder state). Phase 2 not started. Written 2026-10-28.

## Goal

A **"Popular items"** list in the item builder (tab 3), like tab 2's Popular farms: picking one fills the base type, quality,
affix picks and thresholds of a well-known high-trade-value item, so the builder shows its odds per item level and the
best places to farm it. Values are community staples that hardly change between seasons; the list says "known staples",
not prices.

**"Points"** (community term): the number of *useful* affixes on an item (for class items: total +levels to the main skill).
Almost every affix is useless, so a rare's value is how many of a short list of useful affixes it has: a "5-point ring" has 5
of {FCR, strength, dexterity, life, mana, resistances, life steal, AR, ...}.

## Phase 1: presets with fixed picks (works with today's builder)

Each preset = `{ name, group, type (builder type or base code), quality, picks: [{ stat, min }] }` in `CONFIG.itemPresets`
(engine.js), loaded by a dropdown in the builder (grouped by `group`, like the farm list's act groups). Thresholds are the
community "good" minimum; the user can edit everything after loading.

| Group | Preset | Quality | Picks (minimums) |
|---|---|---|---|
| Charms | 3/20/20 small charm | magic | +3 max damage, +20 attack rating, +20 life |
| Charms | 5@/20 small charm | magic | all resistances +5, +20 life |
| Charms | 11 single res / 20 life small charm (x4: fire, cold, lightning, poison) | magic | one resistance +11, +20 life |
| Charms | 17 mana / 20 life small charm | magic | +17 mana, +20 life |
| Charms | 7 MF small charm (+ 5@ or 20 life variants) | magic | 7% magic find |
| Charms | Skiller grand charm with life, per meta tab: Warcries, Combat (Pal), Lightning, Cold, Fire (Sor), Elemental (Dru), Javelin & Spear, Traps, Poison & Bone, Summoning (Nec) | magic | +1 to the tab, +40 life (GG: 45) |
| Charms | Skiller grand charm with FHR (same tabs) | magic | +1 to the tab, 12% faster hit recovery |
| Jewels | 15/40 jewel | magic | 15% IAS, 40% enhanced damage |
| Jewels | 15 IAS / 15 all res jewel | magic | 15% IAS, all resistances +15 |
| Jewels | 15 IAS / max damage jewel | magic | 15% IAS, +max damage (best roll) |
| Class items | 6-point Tornado pelt | magic | +3 Tornado (staff mod), +3 Elemental Skills (Druid) |
| Class items | 5-6 point Bone Spear wand + 20 FCR | magic | +3 Bone Spear, +2/+3 Poison and Bone, 20% FCR |
| Class items | 6-point Blizzard / Hydra orb + FCR | magic | +3 Blizzard (or Hydra), +3 Cold (Fire) Skills, FCR |
| Class items | 6-point Battle Orders helm | magic | +3 Battle Orders, +3 Warcries |
| Class items | 3/3/3 Lightning Sentry claw | magic | +3 Lightning Sentry, +3 Death Sentry, +3 Traps |
| Class items | +3 Javelin / 20 IAS gloves | magic | +3 Javelin and Spear Skills, 20% IAS |
| Jewelry and gear | 2/20 amulet | rare | +2 to class skills, 10-20% FCR |
| Jewelry and gear | 2/20/2 circlet | rare | +2 to class skills, 20% FCR, 2 sockets |
| Jewelry and gear | 30 FRW tri-res boots | rare | 30% FRW, three resistances (each >= 30 where they roll) |
| Jewelry and gear | 10 FCR ring (base for the point presets of phase 2) | rare | 10% FCR |
| Runeword bases | Jmod (Jeweler's Monarch of Deflecting) | magic | 4 sockets, 20% faster block rate, 20% increased block |
| Runeword bases | Enigma / Chains of Honor base: 3 sockets body armor (Archon Plate, Dusk Shroud, Mage Plate) | superior | 3 sockets (+15% ED for superior) |
| Runeword bases | Spirit base: 4 socket Monarch / Crystal Sword | normal or superior | 4 sockets |
| Runeword bases | Infinity / Insight base: ethereal 4 socket Thresher / Giant Thresher / Cryptic Axe | normal or superior | ethereal, 4 sockets |
| Runeword bases | Grief base: 5 socket Phase Blade | superior | 5 sockets (+ED) |

Implementation notes:
* Each pick names the builder's stat key (the description text the builder uses as key, e.g. `+# to Life`, `+# to Tornado (Druid
  Only)`, `Socketed (#)`, `Ethereal`). Resolve them against the builder's stat list when loading; a missing key is a test failure,
  not a silent skip.
* Variants (per skill tab, per resistance) are generated from one row, not written out by hand.
* Loading a preset = the same path as the user picking type, quality and stats by hand (so links / `?q2=` keep working).
* Store the last preset in the URL like the other builder state, so a preset can be shared.

## Phase 2: "at least N of these" (points-based rares)

The real value of rares is *how many* useful affixes they have. Add a condition group to the builder: **at least N of a
list of conditions** (each with its minimum), next to the existing "all of these" picks.

* Engine: the rare odds are computed exactly (`rareExact`), by summing over which affix groups the item draws. Extend the
  state to count how many listed conditions are met (a counter capped at N), so "at least N" stays exact. Magic is the
  same with at most 2 affixes. Sockets / ethereal / superior rows (extrasDist) already combine as a bitmask; count them too.
* Presets that use it:
  * **4 / 5 / 6-point caster ring**: rare ring, 10% FCR required, at least 3 / 4 / 5 of {strength >= 10, dexterity >= 10,
    life >= 30, mana >= 60, all res or a single res >= 20, magic find}.
  * **Melee ring**: life steal + mana steal + at least 3 of {AR >= 100, strength, dexterity, life, resistances}.
  * **Caster amulet**: +2 class skills, at least 2 of {FCR 10-20, strength, life, resistances, mana}.
  * **Circlet**: +2 class skills + 20 FCR, at least 2 of {2 sockets, life, strength, resistances, FRW}.
  * **Boots**: 30 FRW, at least 3 of {single res >= 30 (each), FHR 10, strength, dexterity, MF}.
  * **Gloves**: +2/+3 Javelin and Spear or Martial Arts skills, 20 IAS, at least 2 of {strength, dexterity, life steal,
    resistances}.
* UI: the "N of" group shows its count control and its conditions in one box; the odds table and the farm search use it
  like any other condition.

## Tests

* Every preset loads: its type exists, every stat key resolves, and at least one quality is feasible (`comboAnalysis`).
* Phase 2: "at least N of" equals the sum over the exact subsets for small cases (brute force over the conditions with the
  existing exact search), N = 0 equals no condition, N = all equals the "all of" picks.
* Headless Chrome: picking each group's first preset fills the builder and shows odds and farm rows.

## Not in scope

* Uniques and sets with good rolls (perfect Annihilus, Torch, Griffon's): needs the unique / set stat export of
  `docs/plans/item-tooltip-stats.md`.
* Crafted items (blood gloves, caster amulets, ...) and runewords: not modelled.
* Base implicit stats (e.g. Paladin shields' resistances) and prices.

## Sources

Community valuation guidance: Loot Goblin's item valuation guide (d2r-lootgoblin.com/Guides/ItemValuation: skills + FCR +
resistances for casters, AR / leech / stats for melee, skillers with life or FHR, IAS + ED jewels, 30 FRW multi-res boots,
+2 Amazon / 20 IAS gloves), itemd2r.com's "items worth keeping" article, almarsguides.com "Loot Worth Keeping"; the rest are
long-standing community staples.
