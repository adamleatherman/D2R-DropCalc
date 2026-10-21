# D2R Drop Calculator (local, offline)

Static page + vanilla JS, Python standard library only. No framework, no CDN, no build step apart from parsing the game tables.

## Usage

```
python build.py [path-to-excel-folder]     # default C:\Users\thein\D2R-excel  -> writes data.json (re-run after each patch)
run.bat                                    # builds data.json if missing, starts http.server on :8000, opens the browser
python test_engine.py                      # validation (starts its own server + headless Edge/Chrome)
```

Files: `build.py` (tables -> `data.json`), `engine.js` (all math, no DOM), `app.js` + `index.html` (UI), `worker.js` (Web Worker for the affix search), `test.html` + `tests.js` + `test_engine.py` (validation). The game folder is only read.

Global selectors (saved in localStorage): game mode (LoD / RotW), difficulty, players in game, partied players nearby (including you), MF %, terror zone on/off + character level + herald tier (RotW, Hell, terror zone only), ladder/non-ladder, act.

* **Tab 1, item search** - autocomplete over bases, runes, unique and set items. Every monster/rank/area/difficulty that can drop it, with mlvl, P(base), P(magic), P(rare), P(set), P(unique), P(target), "1 in N kills", kills per run, per-run chance and "1 in N runs". Click headers to sort; filter by text, rank, difficulty, act. For a unique/set item P(target) is the chance of that exact item.
* **Tab 2, affix finder** - pick a base or "Any <base type>", magic or rare, add conditions (stat + minimum value; the stat list is built from the affixes that can actually roll on that base). Ranked list by P(base) x P(quality) x P(all conditions at that affix level). Magic is exact enumeration, rare is a seeded Monte Carlo (50k/200k/1M rolls per distinct affix pool, in a Web Worker). Shows the minimum affix level / monster level for each condition. Choosing a single area ranks by per-run chance.

## Formulas implemented

**Treasure classes** (`engine.js: dist`). Entry probability is Prob / (sum Prob + NoDrop'). Positive Picks k: P(leaf at least once) = 1-(1-s)^k, where s is the per-pick chance (nested TCs multiply). Negative Picks: guaranteed drops, entry i is rolled |Prob_i| times in order until |Picks| rolls are used. The Unique/Set/Rare/Magic factors of nested TCs combine with **max** (decompiled `TreasureClassDropper`, PureDiablo). Monster TC upgrade: highest TC of the same `group` with `level <= mlvl` (top-level TC only; bosses are not upgraded unless terrorized, as in the data guide). Names like `weap72`/`armo66`/`bow45`/`mele30` are generated: all spawnable items of that item type (including child types) whose qlvl is in `(N-3, N]`, weighted by their `rarity` column (blank = 0), and only those with qlvl <= mlvl. `ConditionCalc`/`DropConditionCalc` are not evaluated (no row in this data set uses them); `first/lastLadderSeason` are honoured with `CONFIG.currentSeason = 99` (a ladder-only window that has ended opens the item to non-ladder, so with the current tables the ladder selector changes nothing).

**NoDrop with players**: `NoDrop' = floor(Items / (1/(NoDrop/(NoDrop+Items))^N - 1))`, `N = nearbyParty + floor((players - nearbyParty)/2)`.

**Item quality** (`quality`): per base, checked Unique > Set > Rare > Magic > Superior > Normal > Low, each failure falls through.
`p = Ratio*128 - floor((mlvl - qlvl)*128/Divisor)`; for unique/set/rare with MF > 110: `effMF = floor(MF*dim/(MF+dim))` (dim 250/500/600), otherwise `effMF = MF`; `p = floor(p*100/(100+effMF))`; `p = max(p, Min)`; `p -= floor(p*TCfactor/1024)`; chance `= 128/p` (1 if p <= 128). MF is applied to unique/set/rare/magic only. itemratio row: Version 1, Uber (exceptional/elite) and Class Specific flags. Unique success with no eligible unique (spawnable, not disabled, lvl <= ilvl, ladder rules) becomes rare (magic if the type cannot be rare); set success with none becomes magic. Chance of one specific unique/set = quality chance x rarity / sum rarity of the eligible ones for that base. Item types flagged "Magic" (rings, amulets, jewels, charms) are always at least magic; "Normal" types (runes, gems, potions) are always normal.

**Monster level**: Normal = monstats `Level`; Nightmare/Hell regular monsters = the area's `MonLvlEx(N/H)`; act bosses = monstats `Level` per difficulty (Andariel 75, Mephisto 87, Diablo 94, Baal 99 in Hell); super uniques = the area level of their (hand-mapped) area (Normal uses the class monster's `Level`). Champions +2, uniques +3, unique minions +3 (`CONFIG`). Terror zone: `mlvl = max(base, clamp(clvl + boost_level, bound_incl_min, bound_incl_max))` per difficulty from `desecratedzones.json` (Hell: 70..96, +2), then the rank bonus is added and may exceed the max; the `TreasureClassDesecrated*` / super unique `TC Desecrated` columns replace the normal TC when present. Only levels listed in the zone file are flagged as terror-zone areas.

**Affix level and eligibility**: `ilvl = max(mlvl, qlvl)`; `alvl = ilvl + magic_lvl` if the base has one, else `ilvl - floor(qlvl/2)` (or `2*ilvl - 99` for very high ilvl), capped at 99. Affix rows used: version >= 1, frequency > 0, spawnable = 1 (rare = 1 for rares), `level <= alvl`, `maxlevel` blank or >= alvl, the base's type or any parent type (Equiv1/Equiv2) in `itype`, none in `etype`. Class-tagged affixes can appear on any matching type, but a class-specific base only takes its own class. Weighted by `frequency`, never two with the same `group`. Roll = uniform in min..max. `automagic.txt` rows are applied for bases with an `auto prefix` group (one eligible row by frequency, level-gated). Conditions are checked per stat label (`properties.txt` tooltip + parameter); two conditions can be met by two different affixes, contributions of two affixes to the same stat are not added.

**Per-run estimate (rough)**: packs = SizeX*SizeY * `areaFill`(0.4) * MonDen/100000; each pack is one monster type chosen by `Rarity` share among the area's monster list (mon for Normal, nmon for NM/Hell), size = average of MinGrp/MaxGrp. Unique/champion packs = average of MonUMin/MonUMax, 20% champion packs (3 champions each), 80% unique packs (1 unique + PartyMin/PartyMax minions, default 2). Bosses and super uniques = 1 kill per run. These constants live in `CONFIG.run`; treat the per-run columns as order-of-magnitude.

## Research results (all in `Engine.CONFIG`)

| Question | Result | Source |
|---|---|---|
| Player count N | `N = nearbyParty + floor((players-nearbyParty)/2)` (decompiled game code). PureDiablo's `int(1 + others/2 + nearbyOthers/2)` gives identical values for every 1-8 player/party combination (checked in `test_engine.py`); `/players X` simulates unpartied players, so /players 1 = 2, 3 = 4 ... | https://www.purediablo.com/?p=6422 (Players X Overview), https://gist.github.com/SeanSullivan86/e912b40bb85f9822b9ef507d91534c88 (decompiled TreasureClassDropper) |
| Rare affix count | 3 to 6, each count 1/4; each affix prefix or suffix with probability 1/2, at most 3 prefixes and 3 suffixes, one per group. (Some sources say 2-6 or an ilvl-dependent table; the ilvl table is Project Diablo 2's mod, not vanilla/D2R.) Jewels are capped at 4 (given in the task, not independently verified). | https://www.purediablo.com/diablo-2/item-generation ; https://forums.d2jsp.org/topic.php?t=79824035&f=161 |
| Magic prefix/suffix split | both 25%, prefix only 25%, suffix only 50% | Arreat Summit as quoted in the PureDiablo Item Generation page |
| Level used in the quality ratio | the **base item's qlvl** from armor/weapons/misc (the unique's/set's own level only decides whether it is in the candidate list: `lvl <= ilvl`). The data guide's itemratio page lists UniqueItems#lvl/SetItems#lvl as alternatives; switch with `CONFIG.ratioLevel = 'unique'`. | PureDiablo Item Generation page |
| Quality factors across nested TCs | maximum of parent and child | same page + decompiled gist |
| Generic TC brackets | `weapN`/`armoN` = items with qlvl in (N-3, N], weight = `rarity` (3 normal, 1 class items/wands/staves...) | PureDiablo Item Generation page |
| Unique/set with nothing eligible | unique -> rare, set -> magic | PureDiablo Item Generation page |

## Game modes

`D2R-excel\base\` is the **Lord of Destruction** mode (not classic) and the root folder is **Reign of the Warlock**. Of the 91 tables, 89 are byte-identical; only these differ, and `build.py` stores just the LoD overrides (`spl` flags) in `data.json`:

* `armor.txt`: the 15 Warlock grimoires (`wa1`..`waf`, type `grim`) are spawnable only in RotW. In RotW they join the generated `armoN` pools and dilute the other armor bases (a mid-level base such as `xhl` has about 4% better per-kill odds in LoD, checked against an independent bracket-weight calculation).
* `automagic.txt`: the 8 grimoire auto-mods (group 306) exist only in RotW.

`CONFIG.gameMode` (`'lod'` | `'rotw'`, default `'rotw'`; UI selector "Game mode") picks armoN pool membership, the automagic set, the search index, the Tab 2 base list and the `desecratedzones.json` section (`expansion` for LoD, `rotw` for RotW; the Normal/Nightmare/Hell bounds are identical). Grimoires and their affixes never appear in LoD. `Engine.setMode()` clears the affected caches.

## Heralds (RotW, Hell, terror zone on)

Data-driven (`desecratedzones.json` -> `rotw.hell.defaults.herald_tiers`): five tiers with `herald_treasure_class_level_boost` 0/3/6/9/12 (data guide: "boost to the treasure class level of a Herald... not a boost to the item level dropped"), minion counts, unique mod counts, HP/damage boosts and the logistic spawn-chance constants.

Assumed (labeled in the UI with an "assumed TC" badge and tooltip):

* **Which TC a herald drops from.** `monstats.txt` has `TreasureClassHerald`, `(N)`, `(H)` columns but they are empty for every monster in 3.3 and no TC name contains "Herald", so the game must use a hard-coded fallback. The engine assumes the monster's `TreasureClassDesecratedUnique(H)` TC (group 37, `Act N (H) Unique A-C Desecrated`, Picks -2 = Sunder charms + items), group-upgraded at `mlvl + tier boost`. Herald mlvl follows the existing terror-zone unique rule (+3). One herald row is created per area monster type with `CannotHerald` not set.
* **The tier boost only matters while `mlvl + boost` is below 85**, the top level of group 37. At low character levels it does (clvl 60: tier 1 resolves to `Act 2 (H) Unique C Desecrated`, tier 5 to `Act 5 (H) Unique C Desecrated`), but with a high character level the unique mlvl is already above 85 and every tier resolves to the same TC. Community reports that higher tiers drop more suggest a hard-coded extra we cannot see in the data.
* **Latent Sunder Charms: three separate paths** (shown as separate columns in Tab 1 when you search a Sunder unique). Source: the official Blizzard patch notes for 3.2 and 3.3 (as provided by the user; not re-fetched). Sunder type weights equal the `Sunder Charms` TC weights 30/30/20/12/6/3, so a given Sunder's share of any path is weight/101.
  * **(a) Table path** - the `Sunder Charms` TC (Picks 1, NoDrop 23899, ladder season 2/2) that every desecrated champion/unique/super/boss/herald TC includes via Picks -2. Pure data, scales with players through NoDrop. Tier 1, 1 player: 0.4208% per herald kill (1 in 238); the older community figure 0.3677% (1 in 272) is not matched (see Validation).
  * **(b) Herald bonus path** - hard-coded, nothing in the tables. 3.2: "starts at Tier 1", "no longer modified by player count", "Tier 3 and 4 have twice the increased chance... Tier 5 three times". So `P = base x [1,1,2,2,3][tier-1]`, no player scaling (`CONFIG.heraldSunderTierMult`, known). **The base is unknown** (`CONFIG.heraldSunderBonusBase = null`): the UI shows "unknown base" and the total stays blank until you type a base % into the herald settings.
  * **(c) MF path** - 3.2: Sunders "can drop from any monster, Terrorized and non-Terrorized, using Magic Find"; 3.3: minimum drop level 69 -> 75, reduced MF drop rate (herald rate unaffected), Hell only. The Sunder uniques are `spawnable` blank (0), `lvl` 69, `lvl req` 75 in `uniqueitems.txt`, so the "75" is not visible in the data and is implemented as a hard-coded rule: a unique grand charm (`cm3`) roll can pick one of the six Sunders (weight = rarity x `CONFIG.sunderMfPenalty`) when difficulty is Hell and mlvl >= `CONFIG.sunderMfMinLevel` (75). **Before this change the engine never let `cm3` roll a Sunder** (spawnable=0 excluded them; only the explicit TC leaves counted, i.e. path (a)). **Now** with the default penalty 1 Sunders are 6 of 7 eligible grand charm uniques at mlvl 87 (the other is Gheed's Fortune) - Hell Mephisto gives Cold Rupture about 1 in 7400 per kill at 0% MF. The 3.3 reduction is of unknown size, so this is an **upper bound**.
* **Herald quality**: 3.2 "slightly reduced the chance for Heralds to drop Unique, Set, and Rare"; 3.3 "increased the chance of dropping Rare quality and higher from Herald Tiers 3+". Sizes unknown, so `CONFIG.heraldQualityAdj` = `{t12: {unique, set, rare}, t3plus: {rarePlus}}` defaults to 1 (no-op) and applies to herald rows only. The UI marks the herald quality columns as unadjusted.
* Also in the notes but not modelled: "something desirable (charm or amulet) instead" when the bonus roll fails, Worldstone Shard and Ancient Statue changes.

**Still unknown** (the plan is offline mod experiments to measure them): the real herald TC, the herald Sunder bonus base, the "something desirable" fallback, the size of the 3.3 MF penalty, and the sizes of the herald quality changes.
* Not modelled: when a herald spawns (zone completion logistic), so there is no per-run herald odds.

Sources: https://diablo2.io/post4136083.html (datamine thread), https://www.icy-veins.com/d2/reign-of-the-warlock-endgame-changes-for-diablo-ii-resurrected, https://news.blizzard.com/en-us/article/24266710/diablo-ii-resurrected-ptr-3-2-now-live, and the data guide pages `desecratedzones` and `monstats` (`TreasureClassHerald`).
## Validation (`python test_engine.py`: 172 checks, 0 failures)

1. Independent Python re-implementation reading the raw `.txt` tables: the engine's expected unique/set/rare/magic items per kill match to 1e-9 for Hell Andariel, Mephisto, Countess, Duriel and Baal at 0 and 300 MF with 1 and 3 players, and the chance of specific items matches.
2. Published figures: effective MF for 200% MF = 111 (PureDiablo example), Hell Baal unique `p` for a qlvl-85 base at 200% MF = 938 (page says 939; one rounding step, base not stated); "Players X" NoDrop worked example 60/22/11/5 reproduced exactly; Hell Countess: 5 item rolls with NoDrop 19 and 3 rune rolls with NoDrop 5 vs Prob 15 give P(no rune) = 1/64 as the wiki states. Item roll NoDrop share is 19/68 not 19/67 because D2R 3.3 added a `pk1` entry.
3. Mismatch, explained: the only published Hell Countess Ist figure I could find (1 in 287, 1.10-era forum post) differs from the current tables (1 in 236; 1 in 238 from the rune table alone). The engine equals hand arithmetic from the current tables.
4. Not reproduced: a PureDiablo forum thread says /players 3 gives about +9.5% drop chance on Mephisto; the engine gives +19% more items per kill for N=2. The thread was not retrievable (403), so its assumptions are unknown.
5. Engine outputs to compare with Silospen's drop calculator (dropcalc.silospen.com, which could not be scraped from here): Hell Mephisto, 1 player: Harlequin Crest 1 in 4463 at 0% MF, 1 in 1891 at 300% MF; Tal Rasha's Horadric Crest 1 in 425 / 1 in 165; Hell Andariel: Harlequin Crest 1 in 4402 / 1 in 1867; Hell Countess: Mal 1 in 157, Ist 1 in 236 (1 player).

No authoritative per-kill unique/set tables for Hell Mephisto/Andariel were retrievable offline, so the "match" for those is against the independent re-implementation, not against a website.

## Assumptions and limitations

* Super unique and boss locations are not in the tables; `SU_AREA`/`BOSS_AREA` in `build.py` are hand-written from memory (several superuniques may be placed in the wrong area; edit and re-run build.py). Their mlvl depends on that area.
* `quest` treasure classes (`TreasureClassQuest`, first-kill drops) are ignored: bosses use `TreasureClass`. Andariel/Mephisto use the `q` classes in this data (`Andarielq (H)`).
* Unique minions use the normal TC at mlvl+3; heralds, Reign of the Warlock extras (`rotw` herald tiers, always-unique mods) and the +25% terror zone XP are ignored. `CONFIG.tzMode` can select the rotw bounds (identical numbers in this file).
* `QuestFlag`, `ConditionCalc`, `DropConditionCalc` ignored; ladder season gating is generic but has no effect with the current rows.
* Item names are the table `name` columns (no localized strings in the data); monsters are shown by their `NameStr` key.
* Rare Monte Carlo has sampling noise for very small probabilities (about 1/sqrt(hits)); raise the roll count. Magic is exact. The same affix cannot be satisfied by summing two affixes, and "chance to cast" style stats are matched on label only.
* Per-run counts are a rough model (see above), and ignore waypoints/route length, wandering monsters, shrines, and that a real clear never kills everything.
* Warlock (Reign of the Warlock) skill-tab affixes use generic names.
