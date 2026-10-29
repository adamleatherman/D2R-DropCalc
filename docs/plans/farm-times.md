# Plan: time per run, chance per hour

Status: done (written and implemented 2026-10-28; merged as `41a1cdc`). The default per-game overhead ended up 0.25 min
(15 s), not the 0.5 below. Tune the per-farm numbers in `CONFIG.farms[].time` (`engine.js`).

## Goal

Rank farms by **chance per hour**, not only per run: a 1-minute Pindleskin run with poor odds can beat a 10-minute Chaos
clear. Each popular farm gets an estimated time per game from a few player settings; tab 2 shows chance per hour and hours
for 50%. All times are **rough community-experience estimates**, not measurements: the UI says so and every farm's minutes
can be overridden.

## Settings (global "Your game" bar, saved like MF / players)

| Setting | Values | Effect |
|---|---|---|
| Play style | **Boss killer** (single-target, e.g. Blizzard Sorc) / **Density farmer** (AoE, e.g. Lightning Fury Javazon, Hammerdin) | fight time: density factor per farm |
| Teleport | **Yes, fast** (max-FCR breakpoint, e.g. Sorc) / **Yes, slow frames** (Enigma on a non-caster) / **No** | travel time x1.0 / x1.35 / x3.0 |
| Map | **Saved** (offline, same map per character) / **Random** (online, new map every game) | random adds navigation time per farm |
| Sunder charm | yes / no (one that breaks your main element's immunity) | yes removes the farm's immunity penalty |
| Per-game overhead | minutes, default 0.5 | creating + loading a game |

Per-farm "minutes" override (optional, remembered in the browser) replaces the computed time.

## Model

Per farm (data on `CONFIG.farms`, see the table below):

```
travel = base x travelShare x tp  +  (random map ? base x nav x tp : 0)  +  extra x (teleport ? 1 : 2)
fight  = base x (1 - travelShare) x (density farmer ? density : 1) x (sunder ? 1 : immunity)
time per game = travel + fight + overhead
chance per hour = 1 - (1 - chance per run)^(60 / time per game)
```

* `base`: minutes per run for the reference (boss killer, fast teleport, saved map, no sunder), midpoint of the ranges.
* `travelShare`: part of the reference run spent moving (teleporting, finding stairs).
* `nav`: extra navigation on a random map, as a fraction of `base` (scaled by teleport speed).
* `density`: fight-time factor for a density farmer (below 1 = faster: dense areas; above 1 = slower: single bosses).
* `immunity`: fight-time factor from immune monsters for a typical main element; a sunder charm removes it. Simplification:
  one factor for both play styles (in reality it depends on the element: cold-immune areas hurt a Blizzard Sorc,
  lightning-immune ones, e.g. Chaos' Storm Casters, a Javazon).
* `extra`: fixed travel per game outside the area: the Cow Level's Wirt's Leg trip (Stony Field -> Tristram -> Wirt's body;
  the cube recipe uses up the leg and a Tome of Town Portal, so every cow game needs a new leg). Walking doubles it.

| Farm | base | travelShare | nav | density | immunity | extra |
|---|---|---|---|---|---|---|
| Pindleskin | 0.75 | 0.50 | 0.00 | 1.20 | 1.15 | 0 |
| Andariel | 1.25 | 0.60 | 0.30 | 1.25 | 1.00 | 0 |
| Countess | 1.75 | 0.70 | 0.40 | 1.00 | 1.05 | 0 |
| Summoner: boss only | 1.00 | 0.70 | 0.40 | 1.00 | 1.00 | 0 |
| Summoner: + Arcane ghosts | 4.00 | 0.30 | 0.10 | 0.70 | 1.10 | 0 |
| Travincal council | 1.00 | 0.40 | 0.05 | 1.00 | 1.10 | 0 |
| Mephisto: boss only | 1.00 | 0.70 | 0.40 | 1.35 | 1.00 | 0 |
| Mephisto: + Bremm / + full council | 1.75 | 0.60 | 0.40 | 1.25 | 1.05 | 0 |
| Shenk + Eldritch | 1.25 | 0.50 | 0.10 | 1.20 | 1.10 | 0 |
| Nihlathak | 1.75 | 0.60 | 0.30 | 1.25 | 1.10 | 0 |
| Ancient Tunnels | 3.00 | 0.30 | 0.20 | 0.70 | 1.05 | 0 |
| The Pit (both levels) | 4.00 | 0.30 | 0.15 | 0.70 | 1.10 | 0 |
| Chaos: seal pop | 4.00 | 0.40 | 0.05 | 0.85 | 1.25 | 0 |
| Chaos: full clear | 8.00 | 0.25 | 0.05 | 0.80 | 1.25 | 0 |
| Baal (WSK 2 -> 3 -> Throne, waves, Baal) | 5.00 | 0.25 | 0.20 | 0.85 | 1.20 | 0 |
| Cow Level (+ Wirt's Leg) | 7.50 | 0.20 | 0.10 | 0.50 | 1.00 | 1.75 |

Resulting minutes per game (incl. 0.5 overhead), for checking the implementation (the app's default overhead is 0.25 min = 15 s
since 2026-10-28; the check table keeps 0.5):

| Farm | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| Pindleskin | 1.3 | 1.3 | 1.4 | 1.5 | 1.5 | 2.1 |
| Andariel | 1.8 | 2.1 | 2.2 | 2.6 | 2.6 | 4.5 |
| Countess | 2.3 | 3.0 | 3.0 | 3.6 | 3.6 | 6.8 |
| Summoner: boss only | 1.5 | 1.9 | 1.9 | 2.3 | 2.3 | 4.1 |
| Summoner: + Arcane ghosts | 4.8 | 5.2 | 4.3 | 4.8 | 4.6 | 7.5 |
| Travincal council | 1.6 | 1.6 | 1.6 | 1.8 | 1.7 | 2.5 |
| Mephisto: boss only | 1.5 | 1.9 | 2.0 | 2.4 | 2.4 | 4.2 |
| Mephisto: + Bremm / full council | 2.3 | 3.0 | 3.2 | 3.8 | 3.7 | 6.7 |
| Shenk + Eldritch | 1.8 | 1.9 | 2.1 | 2.3 | 2.3 | 3.6 |
| Nihlathak | 2.3 | 2.8 | 3.0 | 3.6 | 3.5 | 6.2 |
| Ancient Tunnels | 3.6 | 4.2 | 3.5 | 4.1 | 4.0 | 6.5 |
| The Pit (both levels) | 4.8 | 5.4 | 4.5 | 5.1 | 4.9 | 8.1 |
| Chaos: seal pop | 5.1 | 5.3 | 4.8 | 5.5 | 5.0 | 8.4 |
| Chaos: full clear | 10.0 | 10.4 | 8.9 | 9.7 | 8.5 | 13.7 |
| Baal | 6.2 | 7.2 | 6.6 | 7.4 | 6.7 | 11.1 |
| Cow Level (+ Wirt's Leg) | 9.8 | 10.5 | 7.5 | 8.3 | 8.3 | 13.8 |

A: boss killer, fast teleport, saved map. B: boss killer, fast teleport, random map. C: density farmer, fast teleport,
random map. D: density farmer, slow teleport (Enigma), random map. E: D with a sunder charm. F: density farmer, no teleport,
random map.

## Implementation

* `engine.js`: the per-farm parameters on `CONFIG.farms` (`time: { base, travel, nav, density, immunity, extra }`) and
  `CONFIG.farmTime` (teleport factors 1 / 1.35 / 3, walking doubles `extra`, default overhead 0.5); a pure function
  `Engine.farmMinutes(farm, opts)` with `opts = { style, teleport, map, sunder, overhead }` returning minutes per game.
* `index.html` / `app.js`: the settings in the "Your game" bar (saved with the others, `KEYS`); tab 2 gets columns
  **min/game** (editable per farm, overrides remembered in localStorage), **chance per hour**, **hours for 50%**; the info
  line says the minutes are rough estimates. Per hour = `1 - (1 - runP)^(60 / minutes)`; hours for 50% from
  `E.trialsFor(runP, 0.5) x minutes / 60`.
* "Other area..." (no farm): no time unless the user types minutes for it.
* Tab 1: when the named-runs follow-up (`docs/plans/tal-rashas-tombs.md`, Follow-up) adds farm rows, give them the same
  per-hour column so "where to farm X per hour" is one sort.
* README: the model, the settings, that the parameters are estimates, and where to change them (`CONFIG.farms[].time`).

## Tests

* `farmMinutes` reproduces the table above (A-F, 0.05 tolerance).
* Ordering: no teleport >= slow >= fast; random map >= saved; sunder <= no sunder; an override wins.
* Per-hour odds: `1 - (1 - p)^(60 / m)` for a few (p, m); a farm with no time shows "-" for per hour.

## Not in scope

* Measured times; per-character profiles; party play (more players change kill speed and odds both).
