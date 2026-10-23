/* D2R drop calculator - math engine (no DOM). Works in a page, a Web Worker, or any JS runtime.
 *
 * Engine.create(data)  -> engine instance (data = parsed data.json)
 * All tunable assumptions that come from community research live in Engine.CONFIG (see below).
 */
(function (root) {
  'use strict';

  // ======================================================================
  //  CONFIG - every assumption that is not read from the game's data files.
  //  Sources are documented in README.md ("Research results").
  // ======================================================================
  const CONFIG = {
    // --- item quality (data guide docs/itemratio-calc.html + PureDiablo Item Generation Tutorial) ---
    ratioLevel: 'base',            // 'base' = (mlvl - qlvl) uses the BASE item's qlvl (PureDiablo tutorial). 'unique' = the unique's own lvl.
    mfThreshold: 10,               // diminishing returns only apply when MF > 10 (data guide's "exceeds 110%" counts item_magicbonus's baseline 100)
    mfDim: { u: 250, s: 500, r: 600 },
    itemRatioVersion: 1,           // itemratio.txt rows with Version=1 (expansion)
    // --- players (PureDiablo "Players X Overview", 1.11 formula) ---
    // N = nearbyParty + floor((total - nearbyParty)/2)  (== PureDiablo's int(1 + others/2 + nearbyOthers/2) for all 1-8 cases)
    // --- magic items: share with both / prefix only / suffix only. VERIFIED, D2MOO D2Game/src/ITEMS/Items.cpp sub_6FC4D5E0 (magic affix roll):
    //     the prefix roll succeeds with 1/2 (ITEMS_RollMagicAffixesNew: SEED_RollLimitedRandomNumber(2) must be odd unless forced); when it
    //     fails, the suffix roll is forced (v5 = 1), otherwise it is again 1/2  =>  both 1/4, prefix only 1/4, suffix only 1/2.
    //     (Arreat Summit says the same.) A side without any eligible affix returns 0 and the other side is forced, see affixProb.
    magicSplit: { both: 0.25, prefixOnly: 0.25, suffixOnly: 0.5 },
    // --- rare items. VERIFIED, D2MOO D2Game/src/ITEMS/ItemsMagic.cpp D2GAME_RollRareItem_6FC53360 (expansion format >= 1; the 1.00-format path
    //     sub_6FC53760 uses a uniform 4-6 instead and is not what LoD/RotW run):
    //     * affix count = dword_6FD27E70[rand & 7] = {3,4,4,5,5,5,6,6}, i.e. NOT uniform 3..6 (3: 1/8, 4: 2/8, 5: 3/8, 6: 2/8);
    //     * jewels: rand(2) + 3 = 3 or 4 (the old uniform 3-4 was right);
    //     * each step: while neither side is full, prefix/suffix with rand & 1 (50/50); when a side is full (ITEMS_MAX_MODS = 3) the other is used;
    //       a roll that finds no eligible affix (ITEMS_RollMagicAffixesNew returns 0) marks that side full and does NOT use up one of the
    //       count steps (--nCounter), so the item still gets its full count when the other side has room;
    //     * every pick is a fresh weighted draw from the affixes whose `group` is not on the item yet (prefix AND suffix groups share the check,
    //       ITEMMODS_HasAffixWithGroup both ways) - equivalent to the rejection draw rareMC uses.
    rareAffixCounts: [3, 4, 4, 5, 5, 5, 6, 6], rareJewelCounts: [3, 4], rarePrefixChance: 0.5, rareMaxPerSide: 3,
    // --- affix weight. D2MOO ItemsMagic.cpp ComputeAffixFrequency: items.txt `magic lvl` > 0 (staves, wands, orbs, circlets) weight every
    //     affix by frequency * affix level instead of frequency. ASSUMPTION: D2R keeps this (only D2MOO / 1.10 confirms it). false = plain frequency.
    //     (D2MOO's MagicItemRollAffix draws rand(total + 1), so the LAST eligible row gets weight +1: ignored, relative effect 1/total.)
    affixWeightByLevel: true,
    // --- staff mods (itemtypes.txt `StaffMods`: class skill bonuses on wands/staves/orbs/sceptres/..., RotW also knife/grimoire 'war').
    //     VERIFIED, D2MOO D2Game/src/ITEMS/Items.cpp sub_6FC52410 (called at the end of every normal/low/superior/magic/rare/crafted item roll,
    //     never for unique/set) -> sub_6FC52650. ITEMS_GetStaffMods (D2Common Items.cpp) reads the item's FIRST type only.
    //     count: roll = rand % 100: > 90 three, > 70 two, > 30 one, else none      => P(0..3) = 31/40/20/9 %
    //     tier base (item level of the drop, NOT the affix level): > 36 -> 5 (expansion items only), > 24 -> 4, > 18 -> 3, > 11 -> 2, else 1
    //     per skill: tier = base + {+1 (roll > 80, 19%), 0 (> 30, 50%), -1 (> 10, 20%), -2 (else 11%)}, at least 1;
    //     skill = class first skill id + 5 * (tier - 1) + rand % 5 (30 consecutive skill ids; NOT skills.txt reqlevel, no level check at all);
    //     up to `tries` rolls for one that (a) has no itypea1 or the item is of that type and (b) is not one of the (up to 3) skills already
    //     picked; if all fail, the LAST rolled skill is posted anyway (it overwrites the value of an equal skill, and no skill is recorded as picked);
    //     value (not on low quality): roll % 100 >= 90 -> 3, >= 60 -> 2, else 1 => 60/30/10 %. (The imbue / cube path adds the item level to the
    //     rolls via ITEMDROPFLAG_STAFFMODUSEILVL; drops never do.)
    //     UNVERIFIED for D2R: the Warlock (class 7; D2MOO's 1.10 code treats class 7 as 'none') and any D2R balance change.
    staffMods: {
      count: [31, 40, 20, 9],                                  // percent for 0, 1, 2, 3 skills
      baseIlvl: [[36, 5], [24, 4], [18, 3], [11, 2]],          // item level > first -> tier base second; else 1
      tierShift: [[19, 1], [50, 0], [20, -1], [11, -2]],       // percent for base+1, base, base-1, base-2
      value: [[60, 1], [30, 2], [10, 3]],                      // percent for +1, +2, +3
      tries: 6, perTier: 5,
    },
    // --- automagic (automagic.txt rows of items.txt `auto prefix`). VERIFIED, D2MOO D2Game/src/ITEMS/ItemMode.cpp (item finalisation, ~line 6298):
    //     after the regular affixes of an inferior/normal/superior/magic/rare/crafted item (not unique/set) ITEMS_RollMagicAffixes(pItem, 0, 1, 0,
    //     1, 0, wAutoPrefix) picks one row of the item's auto group: spawnable NOT required (bRequireSpawnableAffix = 0), forced roll, the usual
    //     level / maxlevel / itype / etype / class / frequency checks, and on a RARE item only rows with rare = 1.
    // --- low / normal / superior items: sockets, ethereal, superior bonus (D2MOO D2Game/src/ITEMS/ItemMode.cpp sub_6FC4C5F0_End, ~line 6269) ---
    //     order: quality + its bonus (superior row / low-quality penalties), then ITEMS_MakeEthereal, then sockets (sub_6FC4D6B0, quality 2..3 only), then automagic.
    nonMagic: {
      // sockets (Items.cpp sub_6FC4D6B0): quality normal (2) and superior (3) only; low (1) returns at the first line; magic and rare get sockets only through
      // the socket affixes. The item needs hasinv (ITEMS_CheckIfSocketable) and may not be stackable (javelins, throwing weapons, quivers). Then
      // nMaxSockets = ITEMS_GetMaxSockets (type MaxSockets by item level 25 / 40, min the base's gemsockets, and inventory size) capped by the game
      // difficulty (Normal 3, Nightmare 4, Hell 6); chance `ITEMS_RollRandomNumber(seed) % 100 < 33` = 33% flat (no ALWAYSSOCKETS / NOSOCKETS flag is set by
      // monster drops); count = StartSeed % nMaxSockets + 1 = uniform 1..nMaxSockets.
      socketChance: 0.33, diffSocketCap: [3, 4, 6],
      // ethereal (Items.cpp ITEMS_MakeEthereal): 5% flat (`% 100 < 5`), independent of the sockets (ethereal is applied first, sockets never look at the flag).
      // Weapons and armor with ITEMS_HasDurability (!nodurability && durability != 0); not low quality, not set items; allowed on normal, superior, magic,
      // rare, unique (and crafted, not modelled).
      ethChance: 0.05, ethQualities: ['normal', 'sup', 'magic', 'rare', 'unique', 'crafted'],
      // D2R's tables mark every bow, crossbow and Amazon bow `nodurability` = 1, like the Phase Blade and the throwing potions: none of them is ever ethereal.
      // superior bonus (ItemsMagic.cpp sub_6FC54690, ITEMMODS_CanItemBeHighQuality in D2Common ItemMods.cpp): exactly ONE qualityitems.txt row, uniform among
      // the eligible rows; nodurability or throwable items only consider the first 4 rows (build.py exports each item's eligible rows as `sq` and the rows as
      // data.qi). A row carries up to 2 mods, each a uniform integer min..max. Low quality (sub_6FC55270): never sockets, never ethereal, staff mods always +1.
      lowStaffValue: 1,
    },
    // --- monster rank level offsets (data guide: "The unique monster bonus can go over [the TZ max]") ---
    champOffset: 2, uniqueOffset: 3, minionOffset: 3,
    // --- ladder: current ladder season used for first/lastLadderSeason gating (Season 15 began 2026-08-21 with patch 3.3; bump each season) ---
    currentSeason: 15,
    // --- terror zones ---
    // --- game mode: informational. Each data file is one mode ('rotw' = Reign of the Warlock = data.json, 'lod' = Lord of Destruction
    // = data-lod.json, see build.py); Engine.create sets this to the mode of the data it was given (meta.mode). Heralds exist when the
    // data has herald tiers (desecratedzones rotw section only).
    gameMode: 'rotw',
    // --- quest drop (setting `quest`): act bosses with a monstats TreasureClassQuest use it instead of their TC (D2MOO MonsterMode.cpp:
    //     first kill while the killer's quest is open; Andariel's normal TC already is Andarielq). ---
    // ASSUMPTION: D2MOO is 1.10 (no desecrated TCs); in a terror zone D2R may use the desecrated column as-is (Andariel's desecrated
    // columns are 'Andarielq ... Desecrated', which hints at that). true = the quest TC overrides the desecrated TC too (D2MOO order).
    questOverridesTz: true,
    // --- heralds (rotw Hell terror zones) ---
    // A herald drops from the monster's monstats TreasureClassHerald(H) TC (group 41: 'Act N (H) Herald A-C'), group-upgraded at
    // (mlvl + herald_treasure_class_level_boost). Group 41 also holds the 'Ancient Statue 1-5' TCs (level 92); heralds are restricted to the
    // Herald TCs (observed: heralds do not drop statue pieces), see upgradeTC.
    // Every herald TC lists 'Herald Item X' x2, '... - 1 Extra' x1 (one more item pick), '... - 2 Extra' x1 (two more) and Cpot x2. The tables
    // drop all of them, but the published odds of PreCrafted Flame Rift from heralds (1:342 tier 1-2, 1:228 tier 3-4, 1:171 tier 5) equal exactly
    // 1-(1-p)^n with n = 2, 3, 4 item picks and p = (2/407)(30/101). So the game gates the extras by tier (hard-coded, verified against those
    // published odds): tiers 1-2 only the base entries, tiers 3-4 add '1 Extra', tier 5 adds '2 Extra' (not both). null = no extra.
    heraldExtraByTier: [null, null, '1 Extra', '1 Extra', '2 Extra'],
    // --- Latent Sunder Charms: two paths ---
    // (a) TABLE path: the 'Sunder Charms' TC (PreCrafted <Sunder> uniques) included by every desecrated champ/unique/super/boss TC and by the
    //     'Herald Item' TCs. Pure data, scales with players through NoDrop. For heralds the tier gating above is the 3.2 "herald bonus".
    // (b) MF path: the PreCrafted Sunder uniques are also spawnable cm3 uniques with DropConditionCalc cond('Difficulty', hell), lvl 75,
    //     rarity 1, so a unique grand charm roll can pick one in Hell at ilvl >= 75 (dropConditionOK). Pure data.
    // --- herald quality adjustments (herald rows only). 3.2 "slightly reduced Unique, Set and Rare" for heralds; 3.3 "increased Rare and
    //     higher from Herald Tiers 3+". Sizes unknown -> all 1 (no-op). Multipliers on the quality probability (difference goes to/from magic).
    heraldQualityAdj: { t12: { unique: 1, set: 1, rare: 1 }, t3plus: { rarePlus: 1 } },
    // --- per-run estimate (rough!) ---
    run: {
      placeFactor: 0.56,           // share of successful spawn rolls that place a pack, beyond what the map layout explains (the per-level 'pl' = walls / void
                                   // of the preset rooms, tools/floor_share.py). NOT from the game code: calibrated on the one measured count found (Cow Level,
                                   // Hell: ~516 cows/run vs ~924 by the rules alone). The Cow Level is an open outdoor level with generated fill, so its pl is 1
                                   // (not modelled) and this factor is the whole 0.56 there.
      mazeSpecialCells: 0.5,       // fallback only (a maze level without geo.sim): extra maze cells per entrance / exit / waypoint preset in caves of 3+ cells (each replaces a dead end or adds a cell; 0.5 = half add)
      warpLossRooms: 1,            // rooms of spawn rolls lost per warp / waypoint (no spawns within WarpDist)
      champShare: 0.2,             // a champion-or-unique pack is a champion pack 20% of the time (monumod.txt constants row 0)
      champPackSize: 3,            // champions per champion pack: 1 + rand(3)+1 = 2-4 (PopulateRoom)
      uniqueMinions: [3, 6],       // minions with a unique (D2GAME_SpawnMinions_6FC6F440(..., 1, 3, 6))
    },
    maxMlvl: 110,
    // --- per-kill drop cap ---
    // The game's drop routine (decompiled TreasureClassDropper, https://gist.github.com/SeanSullivan86/e912b40bb85f9822b9ef507d91534c88)
    // stops a kill once it has produced maxItems = 6 items: `if (*itemCount >= maxItems) return;`. Drops happen in order (depth-first
    // through nested TCs, picks in sequence, negative-Picks entries in listed order). This is hard-coded in the game, not in the tables,
    // and ASSUMED to still be present in 3.3. null / 0 = off (uncapped, the old numbers). Every dropped unit counts toward the cap:
    // gold ('gld,mul=..'), potions, scrolls, keys, runes, ... Entries that are not items (quest flags, unknown names) drop nothing and
    // do not count. Computed exactly (no Monte Carlo): see dist() / capNode().
    dropCap: 6,
  };

  // small helpers ------------------------------------------------------
  const floor = Math.floor;
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function create(data) {
    const D = data;
    // Areas that are exact copies of an earlier one (same name and every field, e.g. the seven Tal Rasha's Tombs 66-72): listed once, under the lowest id.
    // kills/run stays per area (one tomb per run); DUP_OF[copy id] = kept id.
    const DUP_OF = {};
    { const seen = new Map(); for (const lid of Object.keys(D.levels).sort((a, b) => a - b)) { const k = JSON.stringify(D.levels[lid]); if (seen.has(k)) DUP_OF[lid] = seen.get(k); else seen.set(k, lid); } }
    const TC = D.tc;
    const items = D.items;
    const types = D.types;
    const DIFFS = ['Normal', 'Nightmare', 'Hell'];
    const mode = (D.meta && D.meta.mode) || 'rotw';
    CONFIG.gameMode = mode;

    // ---------------- indices ----------------
    const uniqByCode = {}, setByCode = {}, uniqById = {}, setById = {};
    for (const u of D.uniques) { uniqById[u.id] = u; (uniqByCode[u.code] = uniqByCode[u.code] || []).push(u); }
    for (const s of D.sets) { setById[s.id] = s; (setByCode[s.code] = setByCode[s.code] || []).push(s); }

    function ladderOK(fl, ll, ladder) {
      if (!fl) return true;
      if (ladder) return fl <= CONFIG.currentSeason;
      return !!ll && ll < CONFIG.currentSeason;      // a ladder-only window that has ended opens the item to non-ladder
    }

    // ---------------- generic "weap72" style treasure classes ----------------
    const genericCache = {};
    function genericInfo(name) {
      if (name in genericCache) return genericCache[name];
      let res = null;
      const m = /^([a-z0-9]+?)(\d+)$/i.exec(name);
      if (m && types[m[1]] && types[m[1]].tc) {
        const pre = m[1], bracket = parseInt(m[2], 10);
        const list = [];
        for (const code in items) {
          const it = items[code];
          if (!it.sp || it.anc.indexOf(pre) < 0) continue;
          const b = Math.max(3, Math.ceil(it.q / 3) * 3);
          if (b === bracket) list.push({ code, q: it.q, w: it.r });
        }
        res = list.length ? list : null;
      }
      genericCache[name] = res;
      return res;
    }

    // ---------------- context (players, MF, ladder, terror zone) ----------------
    function playersN(players, party) {
      // decompiled TreasureClassDropper (SeanSullivan86 gist): N = nearbyPartied + (total - nearbyPartied) / 2 (integer division)
      // PureDiablo's form int(1 + (others)/2 + (nearbyPartyOthers)/2) gives the same values for every case up to 8 players.
      const q = Math.max(1, Math.min(party, players));
      return q + floor((players - q) / 2);
    }
    function adjNoDrop(nd, itemsSum, N) {
      if (nd <= 0 || N <= 1 || itemsSum <= 0) return nd;
      const base = nd / (nd + itemsSum);
      const v = 1 / Math.pow(base, N) - 1;
      return floor(itemsSum / v);
    }

    const metaCache = new Map();
    function leafKey(kind, id, f) {
      const key = kind + ':' + id + '|' + f[0] + '|' + f[1] + '|' + f[2] + '|' + f[3];
      if (!metaCache.has(key)) metaCache.set(key, { kind, id, f: f.slice() });
      return key;
    }

    class Ctx {
      constructor(s) {
        this.s = Object.assign({ players: 1, party: 1, mf: 0, ladder: true, tz: false, clvl: 85, quest: false }, s);
        this.N = playersN(this.s.players, this.s.party);
        this.ladder = !!this.s.ladder;
        this.cache = new Map();
        this.sig = this.N + '|' + (this.ladder ? 1 : 0);
      }
    }
    const ctxCache = new Map();
    function getCtx(s) {
      const key = JSON.stringify([s.players || 1, s.party || 1, !!s.ladder]);
      let c = ctxCache.get(key);
      if (!c) { c = new Ctx(s); ctxCache.set(key, c); if (ctxCache.size > 6) ctxCache.delete(ctxCache.keys().next().value); }
      c.s = Object.assign({}, c.s, s);
      return c;
    }

    function heraldsAvailable(sel) { return D.tz.herald.length > 0 && !!sel.tz; }

    // ---------------- treasure class resolution ----------------
    // dist(name, ctx, mlvl, inheritedFactors) -> Map(leafKey -> probability that this roll yields the leaf at least once)
    function maxF(a, t) { return [Math.max(a[0], t.u), Math.max(a[1], t.s), Math.max(a[2], t.r), Math.max(a[3], t.m)]; }
    const ZERO = [0, 0, 0, 0];

    function distRaw(name, ctx, mlvl, inh) {
      const ck = name + '|' + mlvl + '|' + inh.join(',');
      const hit = ctx.cache.get(ck);
      if (hit) return hit;
      let out = new Map();
      const tc = TC[name];
      if (tc) {
        if (!ladderOK(tc.fl, tc.ll, ctx.ladder)) { ctx.cache.set(ck, out); return out; }
        const f = maxF(inh, tc);
        const ents = [];
        let sum = 0;
        for (const e of tc.e) {
          const nm = e[0].split(',')[0];
          const sub = TC[nm];
          if (sub && !ladderOK(sub.fl, sub.ll, ctx.ladder)) continue;
          ents.push([nm, e[1]]);
          if (e[1] > 0) sum += e[1];
        }
        if (tc.p > 0) {
          const nd = adjNoDrop(tc.nd, sum, ctx.N);
          const total = sum + nd;
          if (total > 0) {
            const acc = new Map();
            for (const [nm, pr] of ents) {
              if (pr <= 0) continue;
              const q = pr / total;
              const sub = distRaw(nm, ctx, mlvl, f);
              for (const [k, p] of sub) acc.set(k, (acc.get(k) || 0) + q * p);
            }
            for (const [k, s] of acc) out.set(k, tc.p === 1 ? s : 1 - Math.pow(1 - s, tc.p));
          }
        } else if (tc.p < 0) {
          // guaranteed drops: each entry i yields |Prob_i| rolls, up to |Picks| in total, in order
          let remaining = -tc.p;
          const miss = new Map();
          for (const [nm, pr] of ents) {
            if (remaining <= 0) break;
            const qty = Math.min(pr, remaining);
            if (qty <= 0) continue;
            remaining -= qty;
            const sub = distRaw(nm, ctx, mlvl, f);
            for (const [k, p] of sub) miss.set(k, (miss.get(k) || 1) * Math.pow(1 - p, qty));
          }
          for (const [k, m] of miss) out.set(k, 1 - m);
        }
      } else if (items[name]) {
        out.set(leafKey('i', name, inh), 1);
      } else if (uniqById[name]) {
        out.set(leafKey('u', name, ZERO), 1);   // explicit unique/set: the TC quality factors do not matter, so one leaf per id

      } else if (setById[name]) {
        out.set(leafKey('s', name, ZERO), 1);
      } else {
        const g = genericInfo(name);
        if (g) {
          let W = 0;
          for (const c of g) W += c.w;
          if (W > 0) for (const c of g) out.set(leafKey('i', c.code, inh), c.w / W);
        }
        // else: unknown entry (gold with modifier, quest flags, ...) -> contributes nothing
      }
      ctx.cache.set(ck, out);
      return out;
    }

    // ---------------- per-kill drop cap (exact) ----------------
    // Count of items dropped so far c in 0..cap. A TC acts on that count as a node {T, D}:
    //   T[c][c']   = P(roll ends with c' items | starts with c)                 (all matrices upper triangular, row-major (cap+1)^2)
    //   D.get(k)[c][c'] = P(ends with c' items AND leaf k was produced at least once | starts with c)
    // Sequence A then B:  T = TA TB,  D_k = DA_k TB + TA DB_k - DA_k DB_k     (the "k not produced" matrices T - D multiply)
    // Pick mixture:       T = q0 I + sum q_e T_e,  D_k = sum_{e containing k} q_e D_k_e
    // A leaf drops (c -> c+1) while c < cap and drops nothing at c == cap. P(leaf k) = row 0 of D_k summed.
    // Matrices stored in nodes are never mutated after creation (they are shared and cached).
    const kits = new Map();
    function capKit(cap) {
      let kit = kits.get(cap);
      if (kit) return kit;
      const n = cap + 1;
      const I = new Float64Array(n * n), S = new Float64Array(n * n), TL = new Float64Array(n * n);
      for (let c = 0; c <= cap; c++) { I[c * n + c] = 1; if (c < cap) { S[c * n + c + 1] = 1; TL[c * n + c + 1] = 1; } else TL[c * n + c] = 1; }
      kit = { n, I, S, TL, ident: { T: I, D: new Map(), id: true } };
      kits.set(cap, kit);
      return kit;
    }
    function mmul(A, B, n) {
      const R = new Float64Array(n * n);
      for (let i = 0; i < n; i++) for (let k = i; k < n; k++) {
        const a = A[i * n + k]; if (a === 0) continue;
        for (let j = k; j < n; j++) R[i * n + j] += a * B[k * n + j];
      }
      return R;
    }
    function seqNode(X, Y, kit) {
      if (X.id) return Y;
      if (Y.id) return X;
      const n = kit.n;
      const D = new Map();
      for (const [k, dx] of X.D) {
        const dy = Y.D.get(k);
        const a = mmul(dx, Y.T, n);
        if (dy) { const b = mmul(X.T, dy, n), c = mmul(dx, dy, n); for (let i = 0; i < a.length; i++) a[i] += b[i] - c[i]; }
        D.set(k, a);
      }
      for (const [k, dy] of Y.D) if (!X.D.has(k)) D.set(k, mmul(X.T, dy, n));
      return { T: mmul(X.T, Y.T, n), D };
    }
    function powNode(X, q, kit) {
      let res = kit.ident, base = X;
      while (q > 0) { if (q & 1) res = seqNode(res, base, kit); q >>= 1; if (q) base = seqNode(base, base, kit); }
      return res;
    }
    function leafMat(w, kit) {
      if (w === 1) return kit.S;
      const d = new Float64Array(kit.S.length);
      for (let i = 0; i < d.length; i++) d[i] = kit.S[i] * w;
      return d;
    }
    function mixNode(parts, q0, kit) {   // parts: [[q, node]], q0 = probability that the pick drops nothing
      const T = new Float64Array(kit.I.length), D = new Map();
      for (let i = 0; i < T.length; i++) T[i] = q0 * kit.I[i];
      for (const [q, nd] of parts) {
        for (let i = 0; i < T.length; i++) T[i] += q * nd.T[i];
        for (const [k, d] of nd.D) {
          let a = D.get(k);
          if (!a) { a = new Float64Array(T.length); D.set(k, a); }
          for (let i = 0; i < a.length; i++) a[i] += q * d[i];
        }
      }
      return { T, D };
    }
    /** upper bound on the number of items one roll of this TC can produce (the cap is irrelevant when this is <= cap) */
    function maxItems(name, ctx) {
      const memo = ctx.maxMemo || (ctx.maxMemo = new Map());
      let v = memo.get(name);
      if (v !== undefined) return v;
      const tc = TC[name];
      v = 0;
      if (tc) {
        if (ladderOK(tc.fl, tc.ll, ctx.ladder)) {
          const subs = [];
          for (const e of tc.e) {
            const nm = e[0].split(',')[0], sub = TC[nm];
            if (sub && !ladderOK(sub.fl, sub.ll, ctx.ladder)) continue;
            subs.push([nm, e[1]]);
          }
          if (tc.p > 0) { let m = 0; for (const [nm, pr] of subs) if (pr > 0) m = Math.max(m, maxItems(nm, ctx)); v = tc.p * m; }
          else if (tc.p < 0) { let rem = -tc.p; for (const [nm, pr] of subs) { const q = Math.min(pr, rem); if (q <= 0) continue; rem -= q; v += q * maxItems(nm, ctx); } }
        }
      } else if (items[name] || uniqById[name] || setById[name] || genericInfo(name)) v = 1;
      memo.set(name, v);
      return v;
    }
    function capNode(name, ctx, mlvl, inh, kit) {
      const ck = 'N' + kit.n + '|' + name + '|' + mlvl + '|' + inh.join(',');
      const hit = ctx.cache.get(ck);
      if (hit) return hit;
      let res = kit.ident;
      const tc = TC[name];
      if (tc) {
        if (ladderOK(tc.fl, tc.ll, ctx.ladder)) {
          const f = maxF(inh, tc);
          const ents = [];
          let sum = 0;
          for (const e of tc.e) {
            const nm = e[0].split(',')[0];
            const sub = TC[nm];
            if (sub && !ladderOK(sub.fl, sub.ll, ctx.ladder)) continue;
            ents.push([nm, e[1]]);
            if (e[1] > 0) sum += e[1];
          }
          if (tc.p > 0) {
            const nd = adjNoDrop(tc.nd, sum, ctx.N);
            const total = sum + nd;
            if (total > 0) {
              const parts = [];
              for (const [nm, pr] of ents) if (pr > 0) parts.push([pr / total, capNode(nm, ctx, mlvl, f, kit)]);
              res = powNode(mixNode(parts, nd / total, kit), tc.p, kit);
            }
          } else if (tc.p < 0) {
            let remaining = -tc.p;
            for (const [nm, pr] of ents) {
              if (remaining <= 0) break;
              const qty = Math.min(pr, remaining);
              if (qty <= 0) continue;
              remaining -= qty;
              res = seqNode(res, powNode(capNode(nm, ctx, mlvl, f, kit), qty, kit), kit);
            }
          }
        }
      } else if (items[name]) res = { T: kit.TL, D: new Map([[leafKey('i', name, inh), kit.S]]) };
      else if (uniqById[name]) res = { T: kit.TL, D: new Map([[leafKey('u', name, ZERO), kit.S]]) };
      else if (setById[name]) res = { T: kit.TL, D: new Map([[leafKey('s', name, ZERO), kit.S]]) };
      else {
        const g = genericInfo(name);
        if (g) {
          let W = 0;
          for (const c of g) W += c.w;
          if (W > 0) {
            const D = new Map();
            for (const c of g) D.set(leafKey('i', c.code, inh), leafMat(c.w / W, kit));
            res = { T: kit.TL, D };
          }
        }
        // else: not an item (quest flag, unknown name) -> drops nothing, does not count toward the cap
      }
      ctx.cache.set(ck, res);
      return res;
    }
    /** dist(name, ctx, mlvl, inheritedFactors) -> Map(leafKey -> P(this kill yields the leaf at least once)); honours CONFIG.dropCap */
    function dist(name, ctx, mlvl, inh) {
      const cap = CONFIG.dropCap;
      if (!(cap > 0) || maxItems(name, ctx) <= cap) return distRaw(name, ctx, mlvl, inh);
      const ck = 'C' + cap + '|' + name + '|' + mlvl + '|' + inh.join(',');
      const hit = ctx.cache.get(ck);
      if (hit) return hit;
      const kit = capKit(cap), nd = capNode(name, ctx, mlvl, inh, kit), n = kit.n;
      const out = new Map();
      for (const [k, d] of nd.D) { let p = 0; for (let j = 0; j < n; j++) p += d[j]; if (p > 0) out.set(k, Math.min(1, p)); }
      ctx.cache.set(ck, out);
      return out;
    }

    // monster-level TC upgrade ("group"/"level" columns)
    function upgradeTC(name, mlvl, isBoss, only) {
      const tc = TC[name];
      if (!tc || !tc.g || isBoss) return name;
      const list = D.groups[String(tc.g)];
      if (!list) return name;
      let best = name, bl = -1;
      for (const [lv, nm] of list) if (lv <= mlvl && lv >= bl && (!only || only.test(nm))) { best = nm; bl = lv; }
      return best;
    }
    // Herald TCs (group 41 also holds the Ancient Statue TCs, which heralds must not upgrade into)
    const HERALD_TC = / Herald [ABC]$/;
    /** `Act N (H) Herald X` limited to the entries a herald of this tier drops (CONFIG.heraldExtraByTier); cached as a derived TC. */
    function heraldTierTC(name, tier) {
      const tc = TC[name];
      if (!tc) return name;
      const ex = CONFIG.heraldExtraByTier[Math.max(1, Math.min(5, tier)) - 1] || null;
      const key = name + '|tier ' + (ex || 'base');
      if (!TC[key]) {
        const e = tc.e.filter((x) => { const m = / - (\d Extra)$/.exec(x[0]); return !m || m[1] === ex; });
        let n = 0; for (const x of e) n += x[1];
        TC[key] = Object.assign({}, tc, { e, p: -n, g: 0 });
      }
      return key;
    }

    // ---------------- item quality ----------------
    function ratioRow(it) {
      let best = null;
      for (const r of D.ratio) {
        if (r.ver !== CONFIG.itemRatioVersion) continue;
        if (r.uber === (it.tier > 0 ? 1 : 0) && r.cls === (it.cs ? 1 : 0)) best = r;
      }
      return best || D.ratio[D.ratio.length - 1];
    }

    function succ(arr, qlvl, mlvl, mf, dim, tcF, hasMin) {
      // arr = [ratio, divisor, min]; exact game integer math (D2MOO D2GAME_DropTC_6FC51360, C division truncates): divide level diff first, then <<7, MF divisor = 100 + effMF
      // (game: div = 50*(5D-500)/(D+150)+100 etc. with D = MF+100 > 110, which is 100 + trunc(MF*dim/(MF+dim)) for dim 250/500/600)
      const t = Math.trunc;
      let p = arr[0] - t((mlvl - qlvl) / arr[1]);
      if (mf !== null) {
        const eff = (dim && mf > CONFIG.mfThreshold) ? t((mf * dim) / (mf + dim)) : mf;
        p = t((12800 * p) / (100 + eff));
      } else p *= 128;
      if (hasMin && p < arr[2]) p = arr[2];
      p = p - t((p * tcF) / 1024);
      if (p <= 128) return 1;
      return 128 / p;
    }

    /** DropConditionCalc: only cond('Difficulty', normal|nightmare|hell) is evaluated (the only form in the tables); anything else excludes the row. */
    function dropConditionOK(dc, diff) {
      if (!dc) return true;
      const m = /^cond\('Difficulty',\s*(normal|nightmare|hell)\)$/i.exec(dc.trim().replace(/^"|"$/g, ''));
      return !!m && ['normal', 'nightmare', 'hell'].indexOf(m[1].toLowerCase()) === diff;
    }
    function eligibleUniques(code, ilvl, ladder, mlvl, diff) {
      const out = [];
      for (const u of uniqByCode[code] || []) {
        if (!u.sp || u.dis || u.lvl > ilvl || !dropConditionOK(u.dc, diff) || (items[code] && !items[code].sp)) continue;
        if (!ladderOK(u.fl, u.ll, ladder)) continue;
        out.push(u);
      }
      return out;
    }
    function eligibleSets(code, ilvl, ladder, diff) {
      const out = [];
      for (const s of setByCode[code] || []) {
        if (!s.sp || s.dis || s.lvl > ilvl || !dropConditionOK(s.dc, diff) || (items[code] && !items[code].sp)) continue;
        if (!ladderOK(s.fl, s.ll, ladder)) continue;
        out.push(s);
      }
      return out;
    }

    /** Quality probabilities for a base item. Returns
     *  {unique,set,rare,magic,hq,normal,low, uniques:[{u,p}], sets:[{s,p}]} (unique/set already include the pick among eligible items) */
    function quality(code, mlvl, mf, tcf, ladder, diff) {
      const it = items[code];
      const out = { unique: 0, set: 0, rare: 0, magic: 0, hq: 0, normal: 0, low: 0, uniques: [], sets: [] };
      if (!it || it.an) { out.normal = 1; return out; }
      if (it.nq) return out;   // quest-type items (keys, essences, organs, statue pieces, shards) have no quality: nothing is magic or better (build.py "nq" flag), so P(base) is the whole chance
      const row = ratioRow(it);
      const ilvl = Math.min(mlvl, 99);
      const eu = eligibleUniques(code, ilvl, ladder, mlvl, diff === undefined ? 2 : diff), es = eligibleSets(code, ilvl, ladder, diff === undefined ? 2 : diff);
      const q = it.q;
      const refQ = (u) => (CONFIG.ratioLevel === 'unique' && u ? u.lvl : q);
      let rem = 1;
      let pu = succ(row.u, refQ(eu[0]), mlvl, mf, CONFIG.mfDim.u, tcf[0], true);
      let ps = succ(row.s, refQ(es[0]), mlvl, mf, CONFIG.mfDim.s, tcf[1], true);
      let pr = it.cr ? succ(row.r, q, mlvl, mf, CONFIG.mfDim.r, tcf[2], true) : 0;
      let pm = succ(row.m, q, mlvl, mf, null, tcf[3], true);
      const U = rem * pu; rem -= U;
      const S = rem * ps; rem -= S;
      const R = rem * pr; rem -= R;
      let M = it.am ? rem : rem * pm; rem -= M;
      let rare = R, magic = M;
      let unique = U, set = S;
      if (U > 0 && eu.length === 0) { unique = 0; if (it.cr) rare += U; else magic += U; }
      if (S > 0 && es.length === 0) { set = 0; magic += S; }
      out.unique = unique; out.set = set; out.rare = rare; out.magic = magic;
      if (it.k !== 'm') {
        const ph = succ([row.h[0], row.h[1], 0], q, mlvl, null, null, 0, false);
        out.hq = rem * ph; rem -= out.hq;
      }
      const pn = succ([row.n[0], row.n[1], 0], q, mlvl, null, null, 0, false);
      out.normal = rem * pn; out.low = rem - out.normal;
      if (unique > 0) { let W = 0; for (const u of eu) W += u.r; for (const u of eu) out.uniques.push({ u, p: unique * u.r / W }); }
      if (set > 0) { let W = 0; for (const s of es) W += s.r; for (const s of es) out.sets.push({ s, p: set * s.r / W }); }
      return out;
    }

    // ---------------- monster levels / sources ----------------
    function tzBounds(d) { return D.tz.bounds[d]; }
    function tzLevel(base, clvl, d) {
      const b = tzBounds(d);
      const z = Math.min(b.max, Math.max(b.min, clvl + b.boost));
      return Math.max(base, z);
    }

    function pickTC(m, d, rank, tzOn) {
      const t = m.tc[d] || {};
      const key = { regular: ['dtc', 'tc'], minion: ['dtc', 'tc'], champion: ['dch', 'ch'], unique: ['dun', 'un'] }[rank] || ['dtc', 'tc'];
      let name = null;
      if (tzOn) name = t[key[0]] || null;
      if (!name) name = t[key[1]] || (rank === 'champion' || rank === 'unique' ? t.tc : null);
      return name || t.tc || null;
    }

    const prettyId = (s) => s.replace(/([a-z])(\d+)$/i, '$1 $2');

    // ---------------- per-run model: expected kills in one full clear of an area ----------------
    // Spawn rules from the D2MOO decompilation (LoD 1.10-1.14; not verified for D2R), see README "Per-run estimate".
    const ROLLS8 = Math.floor(Math.floor(40 / 3) * 40 / 3);   // 173 spawn rolls in an 8x8-tile room: one per 3x3 subtiles (PopulateRoom: (dx/3)*dy/3)
    /** spawn rolls and populated rooms of one area at difficulty d (before placement losses) */
    function areaRolls(A, d) {
      const R = CONFIG.run, g = A.geo;
      if (!g) return { rolls: 0, rooms: 0 };
      let rolls, rooms;
      if (g.t === 'maze') {
        // lvlmaze cells; a cell up to 12x12 tiles is one room (DrlgMaze.cpp bSingleRoom), bigger cells are split into 8x8 rooms.
        // geo.sim: the populated cells (Populate 1 presets) the replayed generator makes on average (tools/maze_cells.py: entrance / exit / waypoint
        // presets, staff tomb x3 rooms and the rest of DrlgMaze.cpp DRLGMAZE_GenerateLevel are in the count), used as is. Fallback when a maze level has
        // no simulated value (geo.cells = lvlmaze Rooms): entrance / exit / waypoint presets (at least two: the way in and the way on, e.g. Act 1 caves place prev + down / Den preset) replace a free
        // dead-end cell of the right orientation or add a cell (DRLGMAZE_ScanReplaceSpecialPreset): a cave of 1-2 cells has none free, so each adds one;
        // bigger ones add mazeSpecialCells per special on average.
        const specials = Math.max(2, A.nw + A.wp);
        const big = g.w > 24 || g.h > 24;   // 32x32+ cells are whole preset pieces (ice pools, Nihlathak halls): no extra special cells
        const cells = g.sim ? g.cells[d] : g.cells[d] + (g.fixed || big ? 0 : specials * (g.cells[d] <= 2 ? 1 : R.mazeSpecialCells));
        const single = g.w <= 12 && g.h <= 12;
        rolls = cells * (single ? Math.floor(Math.floor(5 * g.w / 3) * 5 * g.h / 3) : g.w * g.h * ROLLS8 / 64);
        rooms = cells * (single ? 1 : Math.ceil(g.w / 8) * Math.ceil(g.h / 8));
      } else {
        const w = g.w[d], h = g.h[d];
        if (!(w > 0 && h > 0)) return { rolls: 0, rooms: 0 };
        rolls = w * h * ROLLS8 / 64;
        rooms = Math.ceil(w / 8) * Math.ceil(h / 8);
      }
      // no spawns within WarpDist (2025 = 45 subtiles squared) of a warp / waypoint room: about one room of rolls each
      rolls = Math.max(0, rolls - R.warpLossRooms * (A.nw + A.wp) * ROLLS8);
      return { rolls, rooms };
    }
    /** Expected share of each monster type in an area's packs: the game picks min(NumMon, 13) list entries uniformly without replacement (the first one
     *  re-rolled up to 20 times for a rangedtype monster when levels rangedspawn is set), keeps the isSpawn ones, and picks each pack by Rarity among them
     *  (MONSTERREGION_InitializeAll, MONSTERCHOOSE_GetPresetMonsterId). Exact average over every possible pick (at most 120 here). -> Map id -> E[share] */
    function listShares(list, num, ranged) {
      const n = list.length, k = Math.min(num, 13, n), out = new Map();
      if (!k) return out;
      const mon = list.map((id) => D.monsters[id]);
      const isR = mon.map((m) => !!(m && m.rt));
      const nR = isR.filter(Boolean).length, q = 1 - nR / n;
      const pFirst = (i) => !ranged || !nR || q === 0 ? 1 / n : isR[i] ? (1 - Math.pow(q, 21)) / (1 - q) / n : Math.pow(q, 20) / n;
      const pick = [];
      const visit = (first, from, left, w) => {
        if (!left) {
          const sel = [first].concat(pick).filter((i) => mon[i] && mon[i].sp && mon[i].rar > 0);
          let tot = 0; for (const i of sel) tot += mon[i].rar;
          for (const i of sel) out.set(list[i], (out.get(list[i]) || 0) + w * mon[i].rar / tot);
          return;
        }
        for (let i = from; i < n; i++) { if (i === first) continue; pick.push(i); visit(first, i + 1, left - 1, w); pick.pop(); }
      };
      const nComb = (a, b) => { let r = 1; for (let i = 1; i <= b; i++) r = r * (a - b + i) / i; return r; };
      const c = nComb(n - 1, k - 1);
      for (let f = 0; f < n; f++) visit(f, 0, k - 1, pFirst(f) / c);
      return out;
    }
    /** Expected champion/unique packs among `packs` packs spread evenly over `rooms` rooms (MONSTERCHOOSE_GetBossSpawnType): while the count is below
     *  MonUMin a pack in room r of R is one with chance floor(100 r / R)%, and below MonUMax with 6% more. Exact step-by-step expectation.
     *  `start` = uniques already in the level when the random packs roll (preset unique / champion packs and super uniques are spawned with their room,
     *  before its random population; MonsterUnique.cpp ++dwUniqueCount): the count begins there, so fewer random packs qualify. Fractions interpolate. */
    function bossPacks(packs, rooms, umin, umax, start) {
      const n = Math.round(packs), top = Math.max(umin, umax);
      if (!n || !rooms || top <= 0) return 0;
      if (start > 0 && start !== Math.floor(start)) {
        const lo = Math.floor(start), f = start - lo;
        return (1 - f) * bossPacks(packs, rooms, umin, umax, lo) + f * bossPacks(packs, rooms, umin, umax, lo + 1);
      }
      const s0 = Math.min(start || 0, top);
      let p = new Float64Array(top + 1); p[s0] = 1;
      for (let e = 0; e < n; e++) {
        const r = Math.min(rooms, Math.floor((e + 0.5) * rooms / n) + 1), ramp = Math.floor(100 * r / rooms) / 100;
        const nx = new Float64Array(top + 1);
        for (let c = 0; c <= top; c++) {
          if (!p[c]) continue;
          let pb = c < umin ? ramp : 0;
          if (c < umax) pb += (1 - pb) * 0.06;
          if (c < top) nx[c + 1] += p[c] * pb; else pb = 0;
          nx[c] += p[c] * (1 - pb);
        }
        p = nx;
      }
      let ex = 0; for (let c = 0; c <= top; c++) ex += (c - s0) * p[c];
      return ex;
    }
    const avgRange = (a, b) => (b > a ? (a + b) / 2 : a);
    /** expected [minion1, minion2] counts of PartyMin..PartyMax party minions, alternating minion1 / minion2 (MonsterSpawn.cpp sub_6FC69C00) */
    function partyOf(m) {
      if (!m.mn || !m.mn.length || !D.monsters[m.mn[0]]) return [0, 0];
      const lo = m.pm[0], hi = Math.max(m.pm[0], m.pm[1]), two = m.mn.length > 1 && D.monsters[m.mn[1]];
      let a = 0, b = 0;
      for (let x = lo; x <= hi; x++) { const first = two ? Math.ceil(x / 2) : x; a += first; b += x - first; }
      return [a / (hi - lo + 1), b / (hi - lo + 1)];
    }
    const runCache = new Map();
    /** Expected kills per full clear of level lid at difficulty d by monster type and rank -> {kills: Map id -> {regular, champion, unique, minion},
     *  share: Map id -> E[pack share], packs, bosses, rolls, rooms}. Cached per CONFIG.run. */
    function areaRun(lid, d) {
      const R = CONFIG.run, key = lid + '|' + d + '|' + JSON.stringify(R);
      if (runCache.has(key)) return runCache.get(key);
      const A = D.levels[lid], list = d === 0 ? A.mon : A.nmon;
      const { rolls, rooms } = areaRolls(A, d);
      const packs = rolls * (Math.min(A.den[d], 10000) + 1) / 100000 * (A.pl ?? 1) * R.placeFactor;   // rand % 100000 <= MonDen per roll; pl = map layout
      const pk = A.pk ? A.pk[d] : 0, pb = A.pb || {};   // preset monsters (tools/preset_monsters.py): units counting as uniques, unique / champion packs
      const bosses = Math.min(packs, bossPacks(packs, rooms, A.umin[d], A.umax[d], pk));
      const share = listShares(list, A.num, A.rs);
      const kills = new Map();
      const add = (id, rank, x) => { if (!(x > 0) || !D.monsters[id]) return; const o = kills.get(id) || {}; o[rank] = (o[rank] || 0) + x; kills.set(id, o); };
      const regularPack = (id, nPacks) => {   // one regular pack of type id: MinGrp..MaxGrp (1 for Fallen / Scarab bases), sparsePopulate, party minions
        const m = D.monsters[id];
        const g = m.g1 ? 1 : m.g[1] >= m.g[0] && m.g[0] > 0 ? avgRange(m.g[0], m.g[1]) : 0;
        const members = nPacks * g * (m.spp > 0 ? (m.spp + 1) / 100 : 1);
        add(id, 'regular', members);
        const [p1, p2] = partyOf(m);
        add(m.mn && m.mn[0], 'regular', members * p1);
        add(m.mn && m.mn[1], 'regular', members * p2);
      };
      const swap = (id, x, keep) => {   // placespawn: replaced by its spawn monster unless rand % 100 <= chance (20 regular packs, 0 bosses)
        const m = D.monsters[id];
        return m.ps && D.monsters[m.ps] ? [[id, x * keep], [m.ps, x * (1 - keep)]] : [[id, x]];
      };
      for (const [id, sh] of share) for (const [t, x] of swap(id, (packs - bosses) * sh, 0.21)) regularPack(t, x);
      // champion / unique packs: Normal picks the type from umon uniformly, NM / Hell from the area's types by Rarity; 20% champion packs
      // (monumod constants row 0) of 1 + rand(3)+1 champions, else a unique with 3-6 minions (minion1, else its own type)
      const bossShare = d === 0 ? (() => { const o = new Map(); for (const id of A.umon) if (D.monsters[id]) o.set(id, (o.get(id) || 0) + 1 / A.umon.length); return o; })() : share;
      const bossPack = (nPacks, champ) => {   // nPacks boss packs, champ = share of them that are champion packs
        for (const [id, sh] of bossShare) for (const [t, x] of swap(id, nPacks * sh, d === 0 ? 1 : 0.01)) {
          const m = D.monsters[t];
          add(t, 'champion', x * champ * R.champPackSize);
          add(t, 'unique', x * (1 - champ));
          add(m.mn && m.mn.length && D.monsters[m.mn[0]] ? m.mn[0] : t, 'minion', x * (1 - champ) * avgRange(R.uniqueMinions[0], R.uniqueMinions[1]));
        }
      };
      bossPack(bosses, R.champShare);
      // preset monsters: placed by the map layout (no MonDen roll, no placement loss), spawned with their room before the random population. Fixed
      // monsters are regular (+ party minions); place_unique_pack is a unique pack without the champion roll, place_champion a champion pack, both
      // picked from the level like the random ones (MonsterRegion.cpp D2GAME_SpawnPresetMonster_6FC66560 cases 2 / 3). The unique count they raise
      // (pk, with the super uniques placed) is already in `bosses` above. Extraction: tools/preset_monsters.py.
      for (const e of A.pre || []) {
        const m = D.monsters[e.m]; if (!m) continue;
        const n = e.n[d], [p1, p2] = partyOf(m);
        add(e.m, 'regular', n);
        add(m.mn && m.mn[0], 'regular', n * p1);
        add(m.mn && m.mn[1], 'regular', n * p2);
      }
      bossPack(pb.u ? pb.u[d] : 0, 0);
      bossPack(pb.c ? pb.c[d] : 0, 1);
      const res = { kills, share, packs, bosses, rolls, rooms };
      runCache.set(key, res);
      return res;
    }

    /** All kill sources (monster x rank x area x difficulty) for a context.
     *  Each: {key, name, rank, diff, area, areaName, act, mlvl, tc, boss, perRun, tz} */
    function sources(ctx) {
      const s = ctx.s;
      const R = CONFIG.run;
      const out = [];
      const tzOn = !!s.tz;
      for (let d = 0; d < 3; d++) {
        // regular area monsters
        for (const lid in D.levels) {
          if (DUP_OF[lid]) continue;   // identical copy of an area already listed
          const A = D.levels[lid];
          if (A.ho && d < 2) continue;   // Pandemonium areas (Matron's Den ... Uber Tristram) are only opened in Hell: levels.txt rows of Normal / Nightmare are never played
          const list = d === 0 ? A.mon : A.nmon;
          if ((!list.length || !A.den[d]) && !(A.pre && A.pre.length)) continue;   // preset monsters need no spawn list
          const inTz = tzOn && D.tz.levels[lid] !== undefined;
          const run = areaRun(lid, d);
          const lvOf = (m) => { const base = d === 0 ? m.lv[0] : A.lvl[d]; return inTz ? tzLevel(base, s.clvl, d) : base; };
          const OFF = { regular: 0, champion: CONFIG.champOffset, unique: CONFIG.uniqueOffset, minion: CONFIG.minionOffset };
          const seen = {};
          // list monsters (every rank, also at 0 kills/run so their per-kill odds stay listed), then the minion types they bring
          const ids = A.den[d] && list.length ? list.filter((id) => D.monsters[id] && D.monsters[id].rar > 0) : [];   // no spawn list: only the preset monsters
          for (const id of run.kills.keys()) if (ids.indexOf(id) < 0) ids.push(id);
          for (const id of ids) {
            const m = D.monsters[id];
            if (!m || seen[id]) continue;
            seen[id] = 1;
            const inList = !!A.den[d] && list.indexOf(id) >= 0 && m.rar > 0;
            const k = run.kills.get(id) || {};
            const share = run.share.get(id) || 0;
            const lv0 = lvOf(m);
            const recs = ['regular', 'champion', 'unique', 'minion'].filter((rk) => (inList && rk !== 'minion') || k[rk] > 0).map((rk) => [rk, lv0 + OFF[rk], k[rk] || 0]);
            if (inList && d === 2 && inTz && heraldsAvailable(s) && !m.nh) {
              // herald TC from monstats TreasureClassHerald(H), group-upgraded at mlvl + tier boost
              const tier = Math.max(1, Math.min(5, s.tier || 1));
              const hb = (D.tz.herald[tier - 1] || { boost: 0 }).boost;
              const htc = (m.tc[d] || {}).hr;
              if (htc && TC[htc]) out.push({ key: id + '|herald|' + lid + '|' + d, mon: id, name: m.n, rank: 'herald', diff: d, area: +lid,
                areaName: A.name, act: A.act, mlvl: lv0 + CONFIG.uniqueOffset, tc: htc, boss: false, perRun: 0, tz: true, herald: true, tier, tcBoost: hb });
            }
            for (const [rank, mlvl, perRun] of recs) {
              const tcn = pickTC(m, d, rank, inTz);
              if (!tcn || !TC[tcn]) continue;
              out.push({ key: id + '|' + rank + '|' + lid + '|' + d, mon: id, name: m.n, rank, diff: d, area: +lid,
                areaName: A.name, act: A.act, mlvl, tc: tcn, boss: false, perRun, tz: inTz, share });
            }
          }
        }
        // minions of super uniques (D2GAME_SpawnSuperUnique_6FC6F690 -> D2GAME_SpawnMinions_6FC6F440(..., 1, MinGrp, MaxGrp)): MinGrp / MaxGrp +1 per
        // difficulty when both are non-zero, minion = the class's minion1 (else the class itself), count = MinGrp + rand(MaxGrp - MinGrp + 1); the few hard-coded
        // extras of that function (data su.xm: Radament, Siege Boss, Nihlathak, Baal Subject 2) are added. Same rows as the minions of random uniques (merged
        // into one when the area already has the monster type as a minion): +CONFIG.minionOffset on the area level, the monster's regular TC.
        const minRow = new Map();
        for (const r of out) if (r.diff === d && r.rank === 'minion') minRow.set(r.key, r);
        const suMinions = (su, lid, inTz) => {
          const A = D.levels[lid];
          let [lo, hi] = su.mg || [0, 0];
          if (lo && hi) { lo += d; hi += d; }
          const list = (hi > 0 ? [[su.mn, hi >= lo ? (lo + hi) / 2 : lo]] : []).concat(su.xm || []);
          for (const [id, n] of list) {
            const m = D.monsters[id];
            if (!m || !(n > 0)) continue;
            const tcn = pickTC(m, d, 'minion', inTz);
            if (!tcn || !TC[tcn]) continue;
            const key = id + '|minion|' + lid + '|' + d, ex = minRow.get(key);
            if (ex) { ex.perRun += n; ex.suMin = (ex.suMin || 0) + n; continue; }
            const base = d === 0 ? m.lv[0] : A.lvl[d];
            const row = { key, mon: id, name: m.n, rank: 'minion', diff: d, area: +lid, areaName: A.name, act: A.act,
              mlvl: (inTz ? tzLevel(base, s.clvl, d) : base) + CONFIG.minionOffset, tc: tcn, boss: false, perRun: n, tz: inTz, share: 0, suMin: n };   // suMin = the part that comes from super uniques
            out.push(row); minRow.set(key, row);
          }
        };
        // superuniques
        for (const su of D.su) {
          if (D.boss_area[su.cls]) continue;   // Radament / Summoner / Nihlathak / Griswold are also act-boss rows below: keep that one (their minions are added there)
          const lid = D.su_area[su.id];
          if (!lid || !D.levels[lid]) continue;
          const A = D.levels[lid];
          if (A.ho && d < 2) continue;
          const cls = D.monsters[su.cls];
          if (!cls) continue;
          const inTz = tzOn && D.tz.levels[String(lid)] !== undefined;
          const base = d === 0 ? cls.lv[0] : A.lvl[d];
          const mlvl = (inTz ? tzLevel(base, s.clvl, d) : base) + CONFIG.uniqueOffset;   // super uniques are unique-rank monsters (+3, may exceed the zone max); act bosses get no bonus
          let tcn = (inTz && su.dtc[d]) || su.tc[d];
          if (!tcn || !TC[tcn]) continue;
          out.push({ key: 'su|' + su.id + '|' + d, mon: su.cls, name: su.n, rank: 'super', diff: d, area: lid,
            areaName: A.name, act: A.act, mlvl, tc: tcn, boss: false, perRun: 1, tz: inTz });
          suMinions(su, lid, inTz);
        }
        // act bosses
        for (const id in D.boss_area) {
          const lid = D.boss_area[id];
          const m = D.monsters[id];
          const A = D.levels[lid];
          if (!m || !A) continue;
          if (A.ho && d < 2) continue;
          const inTz = tzOn && D.tz.levels[String(lid)] !== undefined;
          const base = m.lv[d];
          const mlvl = inTz ? tzLevel(base, s.clvl, d) : base;
          let tcn = pickTC(m, d, 'regular', inTz);
          const qtc = s.quest && m.qtc && m.qtc[d] && TC[m.qtc[d]] && (!inTz || CONFIG.questOverridesTz) ? m.qtc[d] : null;
          if (qtc) tcn = qtc;
          if (!tcn || !TC[tcn]) continue;
          out.push({ key: 'boss|' + id + '|' + d, mon: id, name: m.n, rank: 'boss', diff: d, area: lid,
            areaName: A.name, act: A.act, mlvl, tc: tcn, boss: true, perRun: 1, tz: inTz, quest: !!qtc });
          for (const su of D.su) if (su.cls === id && D.su_area[su.id] === lid) suMinions(su, lid, inTz);   // the super unique row of the same boss (Radament, Summoner, Nihlathak, Griswold)
        }
      }
      return out;
    }

    const GROUP_LABEL = { champion: 'Champion monsters', unique: 'Unique monsters', minion: 'Minions', herald: 'Heralds' };
    /** sources() with the champions, uniques, minions and heralds of one area merged: in one area / difficulty / rank every monster type ends on the
     *  same group-upgraded TC at the same mlvl (NM/Hell; Normal uses each type's own mlvl), so their per-kill odds are identical. Rows merge only when
     *  upgraded TC, mlvl and herald tier all match; kills/run add up. A rank that still splits in an area lists its member names after the label.
     *  Merged rows carry members (display names) and mon (the ids, space separated); regular monsters, super uniques and bosses pass through.
     *  Heralds: one row per tier ("Herald tier N"), all five when the context's tier is 0 (All tiers), else only that tier. Verified against the data:
     *  in every terror zone, at every tier and clvl, all herald types of the area end on one Herald TC (same mlvl, tier boost and quality adjustment). */
    function areaSources(ctx) {
      const out = [], groups = new Map(), split = new Map();
      const st = ctx.s.tier, tiers = st >= 1 && st <= 5 ? [st] : [1, 2, 3, 4, 5];
      const expand = (src) => src.herald ? tiers.map((tier) => Object.assign({}, src, { tier, tcBoost: (D.tz.herald[tier - 1] || { boost: 0 }).boost })) : [src];
      for (const src0 of sources(ctx)) for (const src of expand(src0)) {
        if (!GROUP_LABEL[src.rank]) { out.push(src); continue; }
        const top = upgradeTC(src.tc, src.mlvl + (src.tcBoost || 0), false, src.herald ? HERALD_TC : null);
        const where = [src.rank, src.area, src.diff, src.tz ? 1 : 0, src.tier || 0].join('|');
        const key = 'grp|' + where + '|' + src.mlvl + '|' + top;
        let g = groups.get(key);
        if (!g) {
          g = Object.assign({}, src, { key, members: [], mon: '', perRun: 0, share: 0 });
          groups.set(key, g); out.push(g);
          split.set(where, (split.get(where) || 0) + 1);
        }
        if (g.members.indexOf(src.name) < 0) g.members.push(src.name);
        g.mon += (g.mon ? ' ' : '') + src.mon;
        g.perRun += src.perRun; g.share += src.share || 0;
      }
      for (const g of groups.values()) {
        const where = [g.rank, g.area, g.diff, g.tz ? 1 : 0, g.tier || 0].join('|');
        g.name = (g.herald ? 'Herald tier ' + g.tier : GROUP_LABEL[g.rank]) + (split.get(where) > 1 ? ': ' + g.members.join(', ') : '');
      }
      return out;
    }

    function srcDist(ctx, src) {
      // bosses keep their own TC unless the zone is terrorized (data guide: group upgrade ignored for bosses unless desecrated)
      let topTC = upgradeTC(src.tc, src.mlvl + (src.tcBoost || 0), src.boss && !src.tz, src.herald ? HERALD_TC : null);
      if (src.herald) topTC = heraldTierTC(topTC, src.tier);
      return dist(topTC, ctx, src.mlvl, ZERO);
    }

    /** Apply CONFIG.heraldQualityAdj to a quality result (herald rows only; default no-op). */
    function adjQuality(q, src) {
      if (!src || !src.herald) return q;
      const A = CONFIG.heraldQualityAdj;
      let mu = 1, ms = 1, mr = 1;
      if (src.tier >= 3) { mu = ms = mr = A.t3plus.rarePlus; } else { mu = A.t12.unique; ms = A.t12.set; mr = A.t12.rare; }
      if (mu === 1 && ms === 1 && mr === 1) return q;
      const o = Object.assign({}, q);
      o.unique = q.unique * mu; o.set = q.set * ms; o.rare = q.rare * mr;
      o.magic = q.magic + (q.unique - o.unique) + (q.set - o.set) + (q.rare - o.rare);
      o.uniques = q.uniques.map((x) => ({ u: x.u, p: x.p * mu }));
      o.sets = q.sets.map((x) => ({ s: x.s, p: x.p * ms }));
      return o;
    }

    // ---------------- item chance for a source ----------------
    /** target: {kind:'base', code} | {kind:'unique', id} | {kind:'set', id}
     *  returns {base, magic, rare, set, unique, hit} probabilities per kill */
    function chanceFor(ctx, src, target, mf) {
      const dm = srcDist(ctx, src);
      const res = { base: 0, magic: 0, rare: 0, set: 0, unique: 0, hq: 0, normal: 0, low: 0, target: 0, explicit: 0, mf: 0 };
      const cfgSig = JSON.stringify([CONFIG.heraldQualityAdj]);
      const ilvl = Math.min(src.mlvl, 99);
      const memo = ctx.qmemo || (ctx.qmemo = new Map());
      for (const [k, p] of dm) {
        const meta = metaCache.get(k);
        if (meta.kind === 'u') {
          if (target.kind === 'unique' && target.id === meta.id) { res.target += p; res.explicit += p; }
          continue;
        }
        if (meta.kind === 's') {
          if (target.kind === 'set' && target.id === meta.id) res.target += p;
          continue;
        }
        let code = meta.id;
        let want = false;
        if (target.kind === 'base') want = code === target.code;
        else if (target.kind === 'unique') want = items[code] && uniqById[target.id].code === code;
        else if (target.kind === 'set') want = items[code] && setById[target.id].code === code;
        if (!want) continue;
        const qk = code + '|' + src.mlvl + '|' + mf + '|' + meta.f.join(',') + '|' + (ctx.ladder ? 1 : 0) + '|' + src.diff + '|' + (src.herald ? src.tier : 0) + '|' + cfgSig;
        let q = memo.get(qk);
        if (!q) { q = adjQuality(quality(code, src.mlvl, mf, meta.f, ctx.ladder, src.diff), src); memo.set(qk, q); }
        res.base += p;
        res.magic += p * q.magic; res.rare += p * q.rare; res.set += p * q.set; res.unique += p * q.unique;
        res.hq += p * q.hq; res.normal += p * q.normal; res.low += p * q.low;
        if (target.kind === 'unique') { for (const x of q.uniques) if (x.u.id === target.id) { res.target += p * x.p; if (sunderIds.has(x.u.id)) res.mf += p * x.p; } }
        if (target.kind === 'set') { for (const x of q.sets) if (x.s.id === target.id) res.target += p * x.p; }
      }
      if (target.kind === 'base') res.target = res.base;
      return res;
    }

    /** per-kill chance of the base target restricted to a base quality: '' / 'any' | 'white' (low+normal+superior) | 'normsup' | 'sup' */
    function baseQualityChance(c, mode) {
      return mode === 'white' ? c.low + c.normal + c.hq : mode === 'normsup' ? c.normal + c.hq : mode === 'sup' ? c.hq : c.base;
    }

    const sunderIds = new Set();
    for (const e of (TC['Sunder Charms'] || { e: [] }).e) sunderIds.add(e[0]);
    /** Path (a), TABLE: chance that one kill drops any Sunder charm through the 'Sunder Charms' TC (data only, includes player-count NoDrop). */
    function sunderChance(ctx, src, id) {
      const dm = srcDist(ctx, src);
      let p = 0;
      for (const [k, v] of dm) { const meta = metaCache.get(k); if (meta.kind === 'u' && (id ? meta.id === id : sunderIds.has(meta.id))) p += v; }
      return Math.min(1, p);
    }
    const isSunder = (id) => sunderIds.has(id);
    /** Both Sunder paths for one source. targetId = one Sunder unique (share of the pool) or null for "any Sunder".
     *  Returns {table, mf, total}. */
    function sunderPaths(ctx, src, targetId, mf) {
      const table = sunderChance(ctx, src, targetId);
      let mfp = 0;
      const dm = srcDist(ctx, src);
      for (const [k, p] of dm) {
        const meta = metaCache.get(k);
        if (meta.kind !== 'i' || meta.id !== 'cm3') continue;
        const q = adjQuality(quality('cm3', src.mlvl, mf, meta.f, ctx.ladder, src.diff), src);
        for (const x of q.uniques) if (sunderIds.has(x.u.id) && (!targetId || x.u.id === targetId)) mfp += p * x.p;
      }
      return { table, mf: mfp, total: 1 - (1 - table) * (1 - mfp) };
    }    /** Herald spawn chance in % at a zone completion % (logistic from the data guide: a/(1+e^(-m(x-x0))) + k). */
    function heraldSpawnPct(tier, x) {
      const t = D.tz.herald[tier - 1]; if (!t) return 0;
      return t.asym / (1 + Math.exp(-t.slope * (x - t.mid))) + t.shift;
    }

    /** Expected number of items per kill by quality class' (sum over all leaves; "P(at least once)" per leaf). */
    function qualityTotals(ctx, src, mf) {
      const dm = srcDist(ctx, src);
      const t = { items: 0, unique: 0, set: 0, rare: 0, magic: 0, hq: 0, normal: 0, low: 0, runes: 0, gold: 0, explicit: 0 };
      for (const [k, p] of dm) {
        const meta = metaCache.get(k);
        if (meta.kind !== 'i') { t.explicit += p; continue; }
        const code = meta.id;
        if (code === 'gld') { t.gold += p; continue; }
        const q = adjQuality(quality(code, src.mlvl, mf, meta.f, ctx.ladder, src.diff), src);
        t.items += p;
        t.unique += p * q.unique; t.set += p * q.set; t.rare += p * q.rare; t.magic += p * q.magic;
        t.hq += p * q.hq; t.normal += p * q.normal; t.low += p * q.low;
        if (/^r\d\d$/.test(code)) t.runes += p;
      }
      return t;
    }

    // ---------------- affixes ----------------
    const allAffixes = D.prefixes.map((a, i) => Object.assign({ i }, a)).concat(D.suffixes.map((a, i) => Object.assign({ i }, a)));
    const affByType = { p: {}, s: {} };
    for (const a of allAffixes) {
      for (const t of a.it) (affByType[a.k][t] = affByType[a.k][t] || []).push(a);
    }
    D.automagic.forEach((a, i) => { a.i = i; });   // identity of an automagic row (the item builder lists them by index)
    const autoByGroup = {};
    for (const a of D.automagic) (autoByGroup[a.g] = autoByGroup[a.g] || []).push(a);

    function itemClasses(it) {
      const cl = [];
      for (const t of it.anc) if (types[t] && types[t].cls) cl.push(types[t].cls);
      return cl;
    }
    function affixLevel(mlvl, it) {
      const q = it.q;
      const ilvl = Math.max(mlvl, q);
      let a;
      if (it.ml > 0) a = ilvl + it.ml;
      else if (ilvl < 99 - floor(q / 2)) a = ilvl - floor(q / 2);
      else a = 2 * ilvl - 99;
      return Math.min(a, 99);
    }
    function minIlvlForAlvl(it, alvl) {
      for (let il = it.q; il <= 120; il++) if (affixLevel(il, it) >= alvl) return il;
      return null;
    }
    /** most sockets the base can hold at an item level (ITEMS_GetMaxSockets, D2Common Items.cpp: the type's MaxSockets1/2/3 by level thresholds, capped by the
     *  base's gemsockets; ITEMMODS_PropertyFunc14 also caps at inventory width * height). ilvl undefined = unlimited level. */
    function maxSockets(code, ilvl) {
      const it = items[code], ty = types[it.t];
      if (!it.gs || !ty || !ty.ms) return 0;
      const m = ty.ms, il = ilvl === undefined || ilvl === null ? 999 : Math.max(1, ilvl);
      return Math.min(il <= m[1] ? m[0] : il <= m[3] ? m[2] : m[4], it.gs, it.sz);
    }
    const eligCache = new Map();
    /** affix a may sit on base `it` (ITEMMODS_CanItemHaveMagicAffix, D2Common ItemMods.cpp: any etype of the item's chain -> no, an itype of the chain -> yes;
     *  ITEMMODS_AffixPlayerClassisCompatible, D2Game ItemsMagic.cpp: a class-specific base only takes its own class's affixes) */
    function affixFits(a, it, cls) {
      for (const e of a.et) if (it.anc.indexOf(e) >= 0) return false;
      let ok = false;
      for (const t of a.it) if (it.anc.indexOf(t) >= 0) { ok = true; break; }
      if (!ok) return false;
      // class tagged affixes (e.g. +Sorceress skills) may appear on any base of a matching item type (amulets, staves, charms),
      // but a class-specific base (e.g. an Amazon bow) only takes affixes of its own class.
      if (a.cls && cls.length && cls.indexOf(a.cls) < 0) return false;
      return true;
    }
    /** eligible prefix/suffix lists for a base at a given affix level (rare=true: rare-flagged affixes only). The entries are the affix rows,
     *  with `f` replaced by the draw weight (frequency, or frequency * level on items with a magic level, CONFIG.affixWeightByLevel). */
    function eligible(code, alvl, rare, ilvl) {
      if (ilvl === undefined) ilvl = minIlvlForAlvl(items[code], alvl);
      const ms = maxSockets(code, ilvl);
      const key = code + '|' + alvl + '|' + (rare ? 1 : 0) + '|' + ms;
      let r = eligCache.get(key);
      if (r) return r;
      const it = items[code];
      const cls = itemClasses(it);
      const byLevel = CONFIG.affixWeightByLevel && it.ml > 0;
      const weighted = (a) => (byLevel ? Object.assign({}, a, { f: a.f * a.lvl }) : a);
      const res = { p: [], s: [] };
      for (const kind of ['p', 's']) {
        const seen = new Set();
        for (const t of it.anc) {
          for (const a of (affByType[kind][t] || [])) {
            const id = a.k + a.i;
            if (seen.has(id)) continue;
            seen.add(id);
            if (!a.sp) continue;
            if (rare && !a.rare) continue;
            if (a.lvl > alvl) continue;
            if (a.max && a.max < alvl) continue;
            if (!affixFits(a, it, cls)) continue;
            // socket affixes (Mechanist's, Artificer's, Jeweler's): ITEMMODS_PropertyFunc14 rolls min..max (0 -> the param), clamped to 1..max sockets of the base
            let w = weighted(a);
            if (a.mods.length && a.mods[0][0] === 'sock') {
              if (ms <= 0) continue;
              const m = a.mods[0], par = +m[1] || 0;
              const lo = Math.max(1, Math.min(m[2] || par, ms)), hi = Math.max(1, Math.min(m[3] || par, ms));
              w = Object.assign({}, w, { mods: [[m[0], m[1], lo, hi, m[4]]].concat(a.mods.slice(1)) });
            }
            res[kind].push(w);
          }
        }
      }
      // automagic (items with an "auto prefix" group): exactly one eligible row is attached. Spawnable is not required (D2MOO passes
      // bRequireSpawnableAffix = 0), but the type / class / level checks and, on rares, the rare flag apply.
      res.auto = [];
      if (it.ap) {
        for (const a of (autoByGroup[it.ap] || [])) {
          if (rare && !a.rare) continue;
          if (a.lvl > alvl) continue;
          if (a.max && a.max < alvl) continue;
          if (!affixFits(a, it, cls)) continue;
          res.auto.push(weighted(a));
        }
      }
      eligCache.set(key, res);
      return res;
    }

    // ---------------- staff mods (class skill bonuses of wands, staves, orbs, ...; see CONFIG.staffMods) ----------------
    /** tier base of the staff mod skills for an item level (the drop's level, not the affix level) */
    function staffBase(ilvl) {
      for (const [lv, b] of CONFIG.staffMods.baseIlvl) if (ilvl > lv) return b;
      return 1;
    }
    /** the class skills the base's type can roll as staff mods: [{idx (0..29 within the class), k (stat key), ok (itypea1 satisfied)}] or null */
    function staffSkills(code) {
      const it = items[code];
      const ty = types[it.t];
      const L = ty && ty.sm && D.staff && D.staff[ty.sm];
      if (!L) return null;
      return L.map((s, idx) => ({ idx, k: s.k, ok: !s.ia || it.anc.indexOf(s.ia) >= 0 }));
    }
    const staffCache = new Map();
    /** Exact distribution of the staff mod outcome as a bitmask of satisfied conditions: [{p, mask}] (bit i = conds[i] met by a staff skill
     *  with value >= min). Enumerates the game's draw sequence (sub_6FC52650) exactly, including skill repeats prevention and the
     *  all-tries-failed fallback, collapsing states that differ only in irrelevant skills' values. */
    function staffDist(code, base, conds, low) {
      const triv = [{ p: 1, mask: 0 }];
      const L = staffSkills(code);
      if (!L) return triv;
      const rel = new Map();   // skill idx -> [[cond index, min]]
      conds.forEach((c, i) => { for (const s of L) if (s.k === c.key) { if (!rel.has(s.idx)) rel.set(s.idx, []); rel.get(s.idx).push([i, c.min]); } });
      if (!rel.size) return triv;
      const ck = code + '|' + base + '|' + (low ? 'L' : '') + JSON.stringify(conds.map((c) => [c.key, c.min]));
      if (staffCache.has(ck)) return staffCache.get(ck);
      const SM = CONFIG.staffMods;
      const tiers = new Map();
      for (const [pc, sh] of SM.tierShift) { const t = Math.max(1, base + sh); tiers.set(t, (tiers.get(t) || 0) + pc / 100); }
      const stateKey = (st) => st.ids.join(',') + '|' + st.vals.map((v) => v[0] + ':' + v[1]).join(',');
      const post = (st, idx, p, out) => {   // the stat is set on the item: the value roll, overwriting an equal skill
        const vals = rel.has(idx) ? (low ? [[100, CONFIG.nonMagic.lowStaffValue]] : SM.value) : [[100, 0]];
        for (const [pv, v] of vals) {
          let nv = st.vals;
          if (rel.has(idx)) nv = st.vals.filter((x) => x[0] !== idx).concat([[idx, v]]).sort((x, y) => x[0] - y[0]);
          const ns = { ids: st.ids2 || st.ids, vals: nv, p: st.p * p * pv / 100 };
          const k = stateKey(ns);
          const cur = out.get(k);
          if (cur) cur.p += ns.p; else out.set(k, ns);
        }
      };
      const step = (states) => {
        const out = new Map();
        for (const st of states.values()) {
          for (const [t, pt] of tiers) {
            const g0 = SM.perTier * (t - 1);
            const A = [], R = [];
            for (let k = 0; k < SM.perTier; k++) { const s = L[g0 + k]; if (s.ok && st.ids.indexOf(g0 + k) < 0) A.push(g0 + k); else R.push(g0 + k); }
            const rr = Math.pow(R.length / SM.perTier, SM.tries);
            if (A.length) for (const a of A) post(Object.assign({}, st, { ids2: st.ids.concat([a]).sort((x, y) => x - y) }), a, pt * (1 - rr) / A.length, out);
            if (R.length) for (const x of R) post(Object.assign({}, st, { ids2: null }), x, pt * rr / R.length, out);
          }
        }
        return out;
      };
      const maskOf = (st) => { let m = 0; for (const [idx, v] of st.vals) for (const [i, mn] of rel.get(idx)) if (v >= mn) m |= 1 << i; return m; };
      let states = new Map([['|', { ids: [], vals: [], p: 1 }]]);
      const acc = new Map();
      const addStage = (w) => { for (const st of states.values()) { const m = maskOf(st); acc.set(m, (acc.get(m) || 0) + w * st.p); } };
      addStage(SM.count[0] / 100);
      for (let c = 1; c < SM.count.length; c++) { states = step(states); addStage(SM.count[c] / 100); }
      const res = Array.from(acc, ([mask, p]) => ({ p, mask }));
      staffCache.set(ck, res);
      return res;
    }

    // ---------------- low / normal / superior items: sockets, ethereal, superior bonus (see CONFIG.nonMagic) ----------------
    const SOCK_KEY = 'Socketed (#)', ETH_KEY = 'Ethereal';   // stat keys (the property descriptions of `sock` and `ethereal`)
    const QUALS = ['low', 'normal', 'sup', 'magic', 'rare'];   // the qualities the builder knows
    const QFIELD = { low: 'low', normal: 'normal', sup: 'hq', magic: 'magic', rare: 'rare' };   // quality() field of each
    const QLABEL = { low: 'low quality', normal: 'normal', sup: 'superior', magic: 'magic', rare: 'rare' };
    const isPlain = (q) => q === 'low' || q === 'normal' || q === 'sup';   // no prefixes / suffixes, only the base's own bonuses
    const supRowsOf = (code) => items[code].sq || [];
    /** can an item of this base be of the quality at all (structure, not odds) */
    function qualityPossible(code, q) {
      const it = items[code];
      if (!it || it.nq || it.an) return false;
      if (q === 'magic') return true;
      if (q === 'rare') return !!it.cr;
      if (it.am) return false;                       // rings, amulets, charms, jewels are never white
      if (q === 'sup') return it.k !== 'm' && supRowsOf(code).length > 0;
      return true;                                    // low / normal
    }
    /** weapons and armor with durability (ITEMS_HasDurability: not nodurability, durability > 0); bows and crossbows are nodurability, so never */
    function ethItem(code) {
      const it = items[code];
      if (it.k === 'm') return false;
      return !!it.hd;
    }
    /** P(ethereal) of a base at a final quality (low and set never; CONFIG.nonMagic.ethQualities) */
    function ethChance(code, q) {
      return ethItem(code) && CONFIG.nonMagic.ethQualities.indexOf(q) >= 0 ? CONFIG.nonMagic.ethChance : 0;
    }
    /** most sockets a normal / superior drop of this base can get: ITEMS_GetMaxSockets (maxSockets) capped by the game difficulty; 0 = never socketed.
     *  diff: 0 Normal / 1 Nightmare / 2 Hell (undefined or -1 = Hell, the most permissive). */
    function plainSocketMax(code, ilvl, diff) {
      const it = items[code];
      if (it.st) return 0;   // stackable: javelins, throwing weapons, quivers
      const d = diff === undefined || diff === null || diff < 0 ? 2 : diff;
      return Math.min(maxSockets(code, ilvl === undefined || ilvl === null ? 99 : ilvl), CONFIG.nonMagic.diffSocketCap[d]);
    }
    /** P(k sockets), k = 0..max, of a normal or superior drop of this base (other qualities: no sockets from this rule) */
    function plainSocketDist(code, q, ilvl, diff) {
      const N = q === 'normal' || q === 'sup' ? plainSocketMax(code, ilvl, diff) : 0;
      const out = [1];
      if (N > 0) { const c = CONFIG.nonMagic.socketChance; out[0] = 1 - c; for (let k = 1; k <= N; k++) out.push(c / N); }
      return out;
    }
    const orConv = (A, B) => {   // distribution of a bitmask that is the OR of two independent ones: [{p, mask}] x [{p, mask}]
      const m = new Map();
      for (const a of A) for (const b of B) { const k = a.mask | b.mask; m.set(k, (m.get(k) || 0) + a.p * b.p); }
      return Array.from(m, ([mask, p]) => ({ p, mask }));
    };
    /** Distribution of which conditions the NON-affix sources meet, as [{p, mask}] (bit i = conds[i] met): the socket roll (normal / superior), the ethereal
     *  roll, the superior bonus row. All independent. sig identifies the inputs for caching ('' when no condition concerns these sources). */
    function extrasDist(code, q, ilvl, diff, conds) {
      const it = items[code], nc = conds.length;
      let dist = [{ p: 1, mask: 0 }], sig = '';
      const bits = (pred) => { let m = 0; for (let i = 0; i < nc; i++) if (!conds[i].le && pred(conds[i])) m |= 1 << i; return m; };
      const sockBits = bits((c) => c.key === SOCK_KEY), ethBits = bits((c) => c.key === ETH_KEY);
      if (sockBits && (q === 'normal' || q === 'sup')) {
        const sd = plainSocketDist(code, q, ilvl, diff), m = new Map();
        sd.forEach((p, k) => { let mask = 0; for (let i = 0; i < nc; i++) if ((sockBits >> i) & 1 && conds[i].min <= k) mask |= 1 << i; m.set(mask, (m.get(mask) || 0) + p); });
        dist = orConv(dist, Array.from(m, ([mask, p]) => ({ p, mask })));
        sig += 's' + (sd.length - 1);
      }
      const pe = ethChance(code, q);
      if (ethBits && pe > 0) { dist = orConv(dist, [{ p: pe, mask: ethBits }, { p: 1 - pe, mask: 0 }]); sig += 'e' + pe; }
      if (q === 'sup' && supRowsOf(code).length) {
        const rows = supRowsOf(code), parts = [];
        const rowBits = rows.map((r) => conds.map((c) => (c.le ? 0 : condProb({ mods: D.qi[r] }, c))));
        if (rowBits.some((b) => b.some((x) => x > 0))) {
          const m = new Map();
          rows.forEach((r, ri) => {
            let states = [{ p: 1 / rows.length, mask: 0 }];
            rowBits[ri].forEach((pb, i) => { if (pb > 0) states = orConv(states, pb >= 1 ? [{ p: 1, mask: 1 << i }] : [{ p: pb, mask: 1 << i }, { p: 1 - pb, mask: 0 }]); });
            for (const st of states) m.set(st.mask, (m.get(st.mask) || 0) + st.p);
          });
          dist = orConv(dist, Array.from(m, ([mask, p]) => ({ p, mask })));
          sig += 'u' + rows.join('');
        }
      }
      return { dist, sig };
    }

    function condProb(a, c) {
      // probability that affix a rolls the condition stat >= min
      let best = 0;
      for (const m of a.mods) {
        if (m[4] !== c.key) continue;
        const mn = m[2], mx = m[3];
        let p;
        if (c.le) {   // lower is better (negative stats such as "Requirements -20%"): value <= c.min
          if (c.min >= mx) p = 1;
          else if (c.min < mn) p = 0;
          else p = (c.min - mn + 1) / (mx - mn + 1);
        } else if (c.min <= mn) p = 1;
        else if (c.min > mx) p = 0;
        else p = (mx - c.min + 1) / (mx - mn + 1);
        if (p > best) best = p;
      }
      return best;
    }

    /** P(item of given quality has all conditions) for the given base at alvl. A condition can be met by an affix, the automagic row or a
     *  staff mod skill (opts.ilvl = the drop's item level; staff mods depend on it, not on alvl).
     *  magic: exact enumeration. rare: seeded Monte Carlo (Rao-Blackwellised over the rolled values). */
    const affCache = new Map();
    function affixProb(code, alvl, quality_, conds, opts) {
      const rolls = (opts && opts.rolls) || 200000;
      const seed = (opts && opts.seed) || 12345;
      const ilvl = opts && opts.ilvl !== undefined ? opts.ilvl : minIlvlForAlvl(items[code], alvl);
      const el = eligible(code, alvl, quality_ === 'rare', ilvl);
      if (!el.sig) el.sig = el.p.map((a) => a.i + ':' + a.f + (a.mods[0] && a.mods[0][0] === 'sock' ? 's' + a.mods[0][3] : '')).join(',') + '/' + el.s.map((a) => a.i + ':' + a.f + (a.mods[0] && a.mods[0][0] === 'sock' ? 's' + a.mods[0][3] : '')).join(',') + '/' + el.auto.map((a) => a.g + a.n + ':' + a.f).join(',');
      const sbase = staffBase(ilvl === null ? 99 : ilvl);
      const sd0 = staffDist(code, sbase, conds, quality_ === 'low');
      const ex = extrasDist(code, quality_, ilvl === null ? 99 : ilvl, opts && opts.diff, conds);   // sockets of white items, ethereal, superior bonus
      const sd = ex.dist.length === 1 && ex.dist[0].mask === 0 ? sd0 : orConv(sd0, ex.dist);
      const sk = (sd0.length === 1 && sd0[0].mask === 0 ? '' : code + sbase) + '|' + ex.sig;
      // identical affix pools (different alvl) share one result
      const ck = [items[code].t === 'jewl' ? 'J' : '', items[code].cs ? code : '', quality_, rolls, seed, JSON.stringify(conds), el.sig, sk].join('|');
      if (affCache.has(ck)) return affCache.get(ck);
      let res;
      // auto affix
      const nc = conds.length;
      const cp = (a) => conds.map((c) => condProb(a, c));
      let autoList = [];
      if (el.auto.length) {
        let W = 0; for (const a of el.auto) W += a.f;
        autoList = el.auto.map((a) => ({ w: a.f / W, c: cp(a) }));
      } else autoList = [{ w: 1, c: new Array(nc).fill(0) }];
      if (isPlain(quality_)) {
        // low / normal / superior: no prefixes or suffixes; the conditions are met by the staff mods, the extras (sockets, ethereal, superior bonus) and the automagic row
        let total = 0;
        for (const st of sd) {
          for (const au of autoList) {
            let q = 1;
            for (let i = 0; i < nc && q > 0; i++) if (!((st.mask >> i) & 1)) q *= au.c[i];
            total += st.p * au.w * q;
          }
        }
        res = total;
      } else if (quality_ === 'magic') {
        const split = CONFIG.magicSplit;
        let both = split.both, po = split.prefixOnly, so = split.suffixOnly;
        if (!el.p.length && !el.s.length) { res = 0; affCache.set(ck, res); return res; }
        if (!el.p.length) { so = 1; both = 0; po = 0; }
        else if (!el.s.length) { po = 1; both = 0; so = 0; }
        // a group on both sides (RotW 307) cannot be drawn twice: the suffix is drawn from the pool without the prefix's group
        const pg = new Set(el.p.map((a) => a.g)), shared = new Set();
        for (const a of el.s) if (pg.has(a.g)) shared.add(a.g);
        const pre = prepSide(el.p, cp, nc, shared);
        const suf = prepSide(el.s, cp, nc, shared);
        const sufG = new Map();
        for (const b of suf) if (b.g) sufG.set(b.g, (sufG.get(b.g) || 0) + b.w);
        const none = { w: 1, c: new Array(nc).fill(0), g: 0 };
        const forms = [[both, pre, suf, true], [po, pre, [none], false], [so, [none], suf, false]];
        let total = 0;
        for (const st of sd) {
          for (const [fw, L1, L2, excl] of forms) {
            if (fw <= 0) continue;
            let s = 0;
            for (const a of L1) {
              const ex = excl && a.g ? (sufG.get(a.g) || 0) : 0;
              const nf = ex >= 1 ? 0 : 1 / (1 - ex);
              for (const b of (ex >= 1 ? [none] : L2)) {
                if (ex > 0 && b.g === a.g) continue;
                const pr = a.w * (ex >= 1 ? 1 : b.w * nf);
                for (const au of autoList) {
                  let q = 1;
                  for (let i = 0; i < nc; i++) {
                    if ((st.mask >> i) & 1) continue;
                    q *= 1 - (1 - a.c[i]) * (1 - b.c[i]) * (1 - au.c[i]);
                    if (q === 0) break;
                  }
                  s += pr * au.w * q;
                }
              }
            }
            total += st.p * fw * s;
          }
        }
        res = total;
      } else {
        res = rareMC(code, el, conds, autoList, rolls, seed, sd);
      }
      affCache.set(ck, res);
      return res;
    }

    function prepSide(list, cp, nc, shared) {
      // collapse affixes with no relevance to the conditions (and in no group shared with the other side) into one "irrelevant" entry
      let W = 0; for (const a of list) W += a.f;
      const out = [];
      let irr = 0;
      for (const a of list) {
        const c = cp(a);
        const g = shared.has(a.g) ? a.g : 0;
        if (g || c.some((x) => x > 0)) out.push({ w: a.f / W, c, g });
        else irr += a.f / W;
      }
      if (irr > 0) out.push({ w: irr, c: new Array(nc).fill(0), g: 0 });
      return out;
    }

    /** Rare item: the game's loop (CONFIG.rareAffixCounts ...) simulated with a seeded RNG; the expected value over the rolled affix
     *  values and over the automagic row / staff mods is taken analytically. */
    function rareMC(code, el, conds, autoList, rolls, seed, sd, hits) {
      const it = items[code];
      const rng = mulberry32(seed);
      const nc = conds.length;
      function side(list) {
        const cum = new Float64Array(list.length);
        let t = 0;
        for (let i = 0; i < list.length; i++) { t += list[i].f; cum[i] = t; }
        const cps = list.map((a) => conds.map((c) => condProb(a, c)));
        return { list, cum, total: t, cps, groups: list.map((a) => a.g) };
      }
      const P = side(el.p), S = side(el.s);
      if (!P.list.length && !S.list.length) return 0;
      const counts = (it.t === 'jewl') ? CONFIG.rareJewelCounts : CONFIG.rareAffixCounts;
      const miss = new Float64Array(nc);   // running product of (1 - p) per condition
      const used = [];                     // groups already on the item (prefix and suffix share the check)
      /** weighted draw among the affixes whose group is not used yet; -1 = none left */
      function draw(Sd) {
        if (!Sd.list.length) return -1;
        for (let tries = 0; tries < 40; tries++) {
          const r = rng() * Sd.total;
          let lo = 0, hi = Sd.cum.length - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (Sd.cum[mid] > r) hi = mid; else lo = mid + 1; }
          if (used.indexOf(Sd.groups[lo]) < 0) return lo;
        }
        let tot = 0;
        for (let i = 0; i < Sd.list.length; i++) if (used.indexOf(Sd.groups[i]) < 0) tot += Sd.list[i].f;
        if (tot <= 0) return -1;
        let r = rng() * tot;
        for (let i = 0; i < Sd.list.length; i++) if (used.indexOf(Sd.groups[i]) < 0 && (r -= Sd.list[i].f) < 0) return i;
        return -1;
      }
      let acc = 0;
      for (let n = 0; n < rolls; n++) {
        const count = counts[floor(rng() * counts.length)];
        used.length = 0;
        for (let i = 0; i < nc; i++) miss[i] = 1;
        let np = 0, ns = 0, pFull = false, sFull = false, k = 0;
        while (k < count && !(pFull && sFull)) {
          const suffix = !sFull && (pFull || !(rng() < CONFIG.rarePrefixChance));
          const Sd = suffix ? S : P;
          const idx = draw(Sd);
          if (idx < 0) { if (suffix) sFull = true; else pFull = true; continue; }   // nothing eligible: the side is closed, the step is not used up
          used.push(Sd.groups[idx]);
          if (hits) (suffix ? hits.s : hits.p)[idx]++;   // per-affix appearance counting (builder table)
          const cps = Sd.cps[idx];
          for (let i = 0; i < nc; i++) miss[i] *= 1 - cps[i];
          if (suffix) { if (++ns >= CONFIG.rareMaxPerSide) sFull = true; } else if (++np >= CONFIG.rareMaxPerSide) pFull = true;
          k++;
        }
        let q = 0;
        for (const au of autoList) {
          for (const st of sd) {
            let z = st.p;
            for (let i = 0; i < nc; i++) if (!((st.mask >> i) & 1)) z *= 1 - miss[i] * (1 - au.c[i]);
            q += au.w * z;
          }
        }
        acc += q;
      }
      return acc / rolls;
    }

    /** For each condition: lowest affix level (and monster level) at which some eligible affix, the automagic row or a staff mod skill on the
     *  base can reach it */
    function minLevels(code, quality_, conds) {
      const it = items[code];
      const L = staffSkills(code);
      const maxVal = quality_ === 'low' ? CONFIG.nonMagic.lowStaffValue : Math.max.apply(null, CONFIG.staffMods.value.map((v) => v[1]));
      const out = [];
      for (const c of conds) {
        let found = null, foundIl = null;
        for (let al = 1; al <= 99; al++) {
          const el = eligible(code, al, quality_ === 'rare');
          const lists = isPlain(quality_) ? [el.auto] : [el.p, el.s, el.auto];
          let ok = false;
          for (const Ls of lists) for (const a of Ls) if (condProb(a, c) > 0) { ok = true; break; }
          if (ok) { found = al; foundIl = minIlvlForAlvl(it, al); break; }
        }
        if (L && c.min <= maxVal) {
          // staff mod: the lowest item level at which some tier of a matching skill can be rolled
          const tiers = L.filter((s) => s.k === c.key).map((s) => Math.floor(s.idx / CONFIG.staffMods.perTier) + 1);
          for (let il = it.q; tiers.length && il <= 120 && (foundIl === null || il < foundIl); il++) {
            const b = staffBase(il);
            if (CONFIG.staffMods.tierShift.some(([, sh]) => tiers.indexOf(Math.max(1, b + sh)) >= 0)) { found = affixLevel(il, it); foundIl = il; break; }
          }
        }
        out.push({ key: c.key, alvl: found, mlvl: found === null ? null : foundIl });
      }
      return out;
    }

    /** Description template ("+#% Faster Cast Rate") with its value placeholder filled by a value or a range ("+10-20% Faster Cast Rate").
     *  Templates with several placeholders (damage ranges, poison, skill procs, charges) take `v` instead: one [lowest, highest] per '#' in text order
     *  (the sixth element of a data mod, merged over rows by mergeSlots); without it the template is returned unchanged. */
    function describe(tpl, mn, mx, v) {
      const at = tpl.indexOf('#');
      if (at >= 0 && tpl.indexOf('#', at + 1) >= 0) {
        if (!v || v.length !== tpl.split('#').length - 1) return tpl;
        const st = (s) => (s[0] === s[1] ? String(s[0]) : s[0] + '-' + s[1]);
        let k = 0, rest = tpl;
        let head = '';
        if (tpl.indexOf('Adds #-# ') === 0) {   // same fixed min and max damage: the game's single form "+# fire damage" (strMod*Damage) instead of "Adds #-# ..." (strMod*DamageRange)
          const a = v[0], b = v[1];
          head = a[0] === a[1] && b[0] === b[1] && a[0] === b[0] ? '+' + a[0] + ' ' : 'Adds ' + a[0] + '-' + b[1] + ' ';
          rest = tpl.slice(9); k = 2;
        }
        return head + rest.replace(/#/g, () => st(v[k++]));
      }
      if (at < 0) return tpl;
      const val = mn === mx ? String(mn) : (mn < 0 || mx < 0 ? mn + ' to ' + mx : mn + '-' + mx);
      const signed = at > 0 && tpl[at - 1] === '+';
      return tpl.slice(0, signed && val[0] === '-' ? at - 1 : at) + val + tpl.slice(at + 1);
    }

    /** slot ranges of two mods of one label merged (new array, the data is not touched) */
    function mergeSlots(a, b) {
      if (!b) return a;
      if (!a) return b.map((s) => s.slice());
      return a.map((s, i) => [Math.min(s[0], b[i][0]), Math.max(s[1], b[i][1])]);
    }
    /** which '#' of a multi-number label the builder slider filters on: the maximum of "Adds #-# <element> damage", else the first number
     *  (chance of "#% Chance to cast level # ...", level of "Level # ... (#/# Charges)") */
    const sliderSlot = (key) => (key.indexOf('Adds #-# ') === 0 ? 1 : 0);
    /** what the slider of a multi-number label measures (shown next to its range), '' for single-number labels */
    function sliderWhat(key) {
      if (key.split('#').length < 3) return '';
      if (key.indexOf('Adds #-# ') === 0) return key.indexOf('poison') >= 0 ? 'maximum total poison damage' : 'maximum damage';
      return key.indexOf('Charges)') >= 0 ? 'skill level (at item level 99)' : 'chance to cast, %';
    }
    let slotMapC = null;
    /** label -> slot ranges merged over every affix and superior bonus row of the data */
    function slotMap() {
      if (!slotMapC) {
        slotMapC = new Map();
        for (const a of allAffixes.concat(D.automagic)) for (const m of a.mods) if (m[5]) slotMapC.set(m[4], mergeSlots(slotMapC.get(m[4]), m[5]));
        for (const r of D.qi) for (const m of r) if (m[5]) slotMapC.set(m[4], mergeSlots(slotMapC.get(m[4]), m[5]));
      }
      return slotMapC;
    }
    /** Description of a label with the slider number set to `thr` (a "minimum" threshold): the other numbers of a multi-number label show their
     *  range (v, else over all data) */
    function describeAt(key, thr, v) {
      if (key.split('#').length < 3) return describe(key, thr, thr);
      v = v || slotMap().get(key);
      if (!v) return key;
      const w = v.map((s) => s.slice());
      w[sliderSlot(key)] = [thr, thr];
      return describe(key, thr, thr, w);
    }

    /** stats available (label list) for a set of bases at max alvl and given quality */
    function statList(codes, quality_) {
      const set = new Map();
      for (const code of codes) {
        const el = eligible(code, 99, quality_ === 'rare');
        for (const L of (isPlain(quality_) ? [el.auto] : [el.p, el.s, el.auto])) for (const a of L) for (const m of a.mods) {
          const cur = set.get(m[4]) || { key: m[4], min: m[2], max: m[3], v: null };
          if (m[3] > cur.max) cur.max = m[3];
          if (m[2] < cur.min) cur.min = m[2];
          cur.v = mergeSlots(cur.v, m[5]);
          cur.text = describe(m[4], cur.min, cur.max, cur.v);
          set.set(m[4], cur);
        }
        // staff mod skills of the base's type (+1..+3 each)
        const L = staffSkills(code);
        if (L) {
          const vs = CONFIG.staffMods.value.map((v) => v[1]);
          for (const s of L) {
            if (!s.ok) continue;
            const cur = set.get(s.k) || { key: s.k, min: Math.min.apply(null, vs), max: Math.max.apply(null, vs) };
            cur.min = Math.min(cur.min, Math.min.apply(null, vs)); cur.max = Math.max(cur.max, Math.max.apply(null, vs));
            cur.text = describe(s.k, cur.min, cur.max);
            set.set(s.k, cur);
          }
        }
      }
      return Array.from(set.values()).sort((a, b) => a.key.localeCompare(b.key));
    }

    /** Ranked list of kill sources for "base(s) + quality + affix conditions".
     *  o = {codes, quality:'magic'|'rare', conds:[{key,min}], mf, diff(-1 all), act(0 all), area(0 all), rolls}  */
    function affixSearch(ctx, o, progress) {
      const codes = new Set(o.codes);
      const qn = o.quality, qf = QFIELD[qn];
      let srcs = areaSources(ctx).filter((s) => (o.diff < 0 || s.diff === o.diff) && (!o.act || s.act === o.act) && (!o.area || s.area === o.area) && (!o.srcKey || s.key === o.srcKey));
      const recs = [];
      const need = new Map();
      for (const src of srcs) {
        const dm = srcDist(ctx, src);
        const parts = new Map();
        let pbase = 0, pq = 0;
        for (const [k, p] of dm) {
          const meta = metaCache.get(k);
          if (meta.kind !== 'i' || !codes.has(meta.id)) continue;
          const code = meta.id;
          const q = adjQuality(quality(code, src.mlvl, o.mf, meta.f, ctx.ladder, src.diff), src);
          const w = p * q[qf];
          pbase += p;
          if (w <= 0) continue;
          pq += w;
          const alvl = affixLevel(src.mlvl, items[code]);
          const pk = code + '|' + alvl + '|' + staffBase(src.mlvl) + '|' + maxSockets(code, src.mlvl) + '|' + (qn === 'normal' || qn === 'sup' ? plainSocketMax(code, src.mlvl, src.diff) : 0);   // staff mods depend on the drop's item level, not the affix level; sockets of white items on the difficulty
          parts.set(pk, (parts.get(pk) || 0) + w);
          need.set(pk, [code, alvl, src.mlvl, src.diff]);
        }
        if (pq > 0) recs.push({ src, parts, pbase, pq });
      }
      const probs = new Map();
      let done = 0;
      for (const [pk, [code, alvl, ilvl, diff]] of need) {
        probs.set(pk, o.prune && !planCombo(code, ilvl, qn, o.conds, { diff }).ok ? 0 : affixProb(code, alvl, qn, o.conds, { rolls: o.rolls, ilvl, diff }));   // prune: structurally impossible pools are exactly 0
        done++;
        if (progress && (done % 3 === 0 || done === need.size)) progress(done, need.size);
      }
      const rows = [];
      for (const r of recs) {
        let tot = 0, bestW = -1, alvl = 0;
        for (const [pk, w] of r.parts) {
          tot += w * probs.get(pk);
          if (w > bestW) { bestW = w; alvl = need.get(pk)[1]; }
        }
        if (tot <= 0) continue;
        const row = { src: r.src, pBase: r.pbase, pQual: r.pq, pAff: tot / r.pq, pTotal: tot, perRun: tot * r.src.perRun, alvl };
        if (o.byBase) {   // contribution of each base code to pTotal
          row.byBase = {};
          for (const [pk, w] of r.parts) { const c = need.get(pk)[0]; row.byBase[c] = (row.byBase[c] || 0) + w * probs.get(pk); }
        }
        rows.push(row);
      }
      return { rows, minLv: o.codes.length ? o.codes.map((c) => minLevels(c, qn, o.conds)) : [], pools: need.size };
    }

    // ---------------- item builder (UI tab 2): types, affix catalogue, appearance odds, feasibility / levels of a combination ----------------
    // Nothing here changes a rule: it re-uses eligible(), condProb(), staffDist(), affixLevel(), the magic split and the rare loop (rareMC) and
    // answers builder questions from them. A condition is {key, min[, le]}: stat key >= min (le: <= min, for stats where lower is better).
    const tierOf = (idx) => Math.floor(idx / CONFIG.staffMods.perTier) + 1;
    /** staff mod tiers a drop of item level il can roll */
    function staffTiersAt(il) {
      const b = staffBase(il), s = new Set();
      for (const [, sh] of CONFIG.staffMods.tierShift) s.add(Math.max(1, b + sh));
      return s;
    }
    const staffMaxVal = () => Math.max.apply(null, CONFIG.staffMods.value.map((v) => v[1]));
    const ilOf = (code, ilvl) => Math.max(ilvl, items[code].q, 1);   // a base never drops below its own level in the builder
    const affId = (a) => a.k + a.i;   // 'p12' / 's7' / 'a3' (automagic row); staff mod skills are 'k' + stat key

    let btCache = null;
    /** item types the builder offers: [{code, name, cls, codes (rare/magic-capable spawnable bases), broad}]. broad = an abstract type no base is
     *  directly of ("Any Armor", "Melee Weapon", ...); the concrete ones (Boots, Sword, Circlet, ...) come first. */
    function builderTypes() {
      if (btCache) return btCache;
      const direct = new Set();
      for (const c in items) { direct.add(items[c].t); if (items[c].t2) direct.add(items[c].t2); }
      const out = [];
      for (const [code, list] of baseTypes()) {
        const codes = list.filter((c) => items[c].cr || items[c].am);
        if (codes.length) out.push({ code, name: types[code].n, cls: types[code].cls || '', codes, broad: !direct.has(code) });
      }
      out.sort((a, b) => (a.broad - b.broad) || a.name.localeCompare(b.name));
      return (btCache = out);
    }
    /** bases of a type, optionally one tier only (tier 0 normal / 1 exceptional / 2 elite; jewelry, charms and jewels have no tiers and always stay) */
    function builderBases(typeCode, tier) {
      const ty = builderTypes().find((t) => t.code === typeCode);
      if (!ty) return [];
      return ty.codes.filter((c) => !(tier >= 0) || items[c].k === 'm' || items[c].tier === tier);
    }

    /** [first, last] item level (base level .. 99) where pred holds, or null */
    function ilRange(code, pred) {
      let lo = null, hi = null;
      for (let il = Math.max(1, items[code].q); il <= 99; il++) if (pred(il)) { if (lo === null) lo = il; hi = il; }
      return lo === null ? null : [lo, hi];
    }
    const grpNames = new Map();
    /** readable name of an affix group (the stat of its first affix, "Faster Cast Rate"); the group is what makes affixes mutually exclusive */
    function groupName(g) {
      if (!g) return '';
      if (!grpNames.size) {
        for (const a of allAffixes.concat(D.automagic)) if (a.g && !grpNames.has(a.g) && a.mods.length) grpNames.set(a.g, a.mods[0][4].replace(/[+-]?#%?/g, '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim());
      }
      return grpNames.get(g) || ('group ' + g);
    }
    /** Every affix row that can ever roll on one of the bases: Map id -> {id, side prefix|suffix|auto|staff, name, mods:[{key,min,max}], lvl, lr, cls, rare, g,
     *  groupName, maxLvl, tier (staff), per: Map code -> [first, last] item level]}. ilvl (optional) clamps socket ranges to the sockets the bases hold. */
    function builderCatalog(codes, ilvl) {
      const rows = new Map();
      const put = (id, mk, code, rng) => {
        if (!rng) return;
        let r = rows.get(id);
        if (!r) { r = mk(); r.id = id; r.per = new Map(); rows.set(id, r); }
        r.per.set(code, rng);
      };
      const socketHi = codes.reduce((m, c) => Math.max(m, maxSockets(c, ilvl === undefined ? 99 : ilOf(c, ilvl))), 0);
      for (const code of codes) {
        const it = items[code], cls = itemClasses(it);
        const mk = (side, a) => () => ({
          side, name: a.dn || a.n, lvl: a.lvl, lr: a.lr, cls: a.cls || '', rare: !!a.rare, g: a.g, groupName: groupName(a.g), maxLvl: a.max || 0,
          quals: side === 'auto' ? ['low', 'normal', 'sup', 'magic'].concat(a.rare ? ['rare'] : []) : a.rare ? ['magic', 'rare'] : ['magic'],
          mods: a.mods.map((m) => m[0] === 'sock' ? { key: m[4], min: Math.max(1, Math.min(m[2] || +m[1] || 0, socketHi)), max: Math.max(1, Math.min(m[3] || +m[1] || 0, socketHi)) } : { key: m[4], min: m[2], max: m[3], v: m[5] }),
        });
        const okAt = (a, il) => { const al = affixLevel(il, it); return a.lvl <= al && (!a.max || a.max >= al) && (!(a.mods.length && a.mods[0][0] === 'sock') || maxSockets(code, il) > 0); };
        for (const kind of ['p', 's']) {
          const seen = new Set();
          for (const t of it.anc) for (const a of (affByType[kind][t] || [])) {
            if (seen.has(affId(a))) continue;
            seen.add(affId(a));
            if (!a.sp || !affixFits(a, it, cls)) continue;
            put(affId(a), mk(kind === 'p' ? 'prefix' : 'suffix', a), code, ilRange(code, (il) => okAt(a, il)));
          }
        }
        if (it.ap) for (const a of (autoByGroup[it.ap] || [])) if (affixFits(a, it, cls)) put(affId(a), mk('auto', a), code, ilRange(code, (il) => okAt(a, il)));
        const L = staffSkills(code);
        if (L) {
          const vs = CONFIG.staffMods.value.map((v) => v[1]);
          for (const s of L) {
            if (!s.ok) continue;
            put('k' + s.k, () => ({ side: 'staff', name: 'Staff skill', lvl: null, lr: null, cls: '', rare: true, quals: QUALS, g: 0, groupName: '', maxLvl: 0, tier: tierOf(s.idx), mods: [{ key: s.k, min: Math.min.apply(null, vs), max: Math.max.apply(null, vs) }] }),
              code, ilRange(code, (il) => staffTiersAt(il).has(tierOf(s.idx))));
          }
        }
        // sockets of white items, ethereal, superior bonus rows (CONFIG.nonMagic): no affix level, no slot, no group
        const extra = (id, side, name, quals, mods, rng) => put(id, () => ({ side, name, lvl: null, lr: null, cls: '', rare: true, quals, g: 0, groupName: '', maxLvl: 0, tier: 0, mods }), code, rng);
        if (qualityPossible(code, 'normal') && plainSocketMax(code, 99, 2) > 0) extra('xsock', 'socket', 'Sockets (normal / superior)', ['normal', 'sup'], [{ key: SOCK_KEY, min: 1, max: Math.max(1, socketHi) }], ilRange(code, (il) => plainSocketMax(code, il, 2) > 0));
        if (ethItem(code)) extra('xeth', 'ethereal', 'Ethereal', CONFIG.nonMagic.ethQualities.filter((q) => QUALS.indexOf(q) >= 0), [{ key: ETH_KEY, min: 1, max: 1 }], ilRange(code, () => true));
        if (qualityPossible(code, 'sup')) for (const r of supRowsOf(code)) extra('xsup' + r, 'superior', 'Superior bonus', ['sup'], D.qi[r].map((m) => ({ key: m[4], min: m[2], max: m[3], v: m[5] })), ilRange(code, () => true));
      }
      return rows;
    }
    /** stats a type can roll over all tiers: [{key, min, max, text, le (lower is better: every value <= 0), staff}] sorted by text */
    function builderStats(codes) {
      const m = new Map();
      for (const r of builderCatalog(codes).values()) for (const x of r.mods) {
        const cur = m.get(x.key) || { key: x.key, min: x.min, max: x.max, staff: r.side === 'staff', v: null };
        cur.min = Math.min(cur.min, x.min); cur.max = Math.max(cur.max, x.max); cur.v = mergeSlots(cur.v, x.v);
        m.set(x.key, cur);
      }
      for (const s of m.values()) { s.le = s.max <= 0 && s.min < 0 && s.key.split('#').length === 2; s.flag = s.key === ETH_KEY; s.text = describe(s.key, s.min, s.max, s.v); s.what = sliderWhat(s.key); }
      return Array.from(m.values()).sort((a, b) => a.text.localeCompare(b.text));
    }

    /** P(each affix row appears) on one base of a given item level and quality: Map id -> p. Magic: exact (the magic split + group exclusion,
     *  same model as affixProb); rare: the rare loop Monte Carlo (rareMC) counting picks; automagic rows and staff mod skills as in affixProb. */
    function affixAppearance(code, ilvl, quality_, rolls, seed, diff) {
      const it = items[code], rare = quality_ === 'rare';
      const el = eligible(code, affixLevel(ilvl, it), rare, ilvl);
      const out = new Map();
      if (el.auto.length) { let W = 0; for (const a of el.auto) W += a.f; for (const a of el.auto) out.set(affId(a), a.f / W); }
      const L = staffSkills(code);
      if (L) {
        const sb = staffBase(ilvl);
        for (const s of L) {
          if (!s.ok) continue;
          let p = 0; for (const st of staffDist(code, sb, [{ key: s.k, min: 1 }])) if (st.mask & 1) p += st.p;
          if (p > 0) out.set('k' + s.k, p);
        }
      }
      // sockets of white items, ethereal, superior bonus rows
      if (qualityPossible(code, quality_)) {
        const sock = 1 - plainSocketDist(code, quality_, ilvl, diff)[0];
        if (sock > 0) out.set('xsock', sock);
        const pe = ethChance(code, quality_);
        if (pe > 0) out.set('xeth', pe);
        if (quality_ === 'sup') for (const r of supRowsOf(code)) out.set('xsup' + r, 1 / supRowsOf(code).length);
      }
      if (isPlain(quality_) || (!el.p.length && !el.s.length)) return out;
      if (rare) {
        const hits = { p: new Float64Array(el.p.length), s: new Float64Array(el.s.length) }, n = rolls || 50000;
        rareMC(code, el, [], [{ w: 1, c: [] }], n, seed || 12345, [{ p: 1, mask: 0 }], hits);
        el.p.forEach((a, i) => out.set(affId(a), hits.p[i] / n));
        el.s.forEach((a, i) => out.set(affId(a), hits.s[i] / n));
        return out;
      }
      const split = CONFIG.magicSplit;
      let both = split.both, po = split.prefixOnly, so = split.suffixOnly;
      if (!el.p.length) { so = 1; both = 0; po = 0; } else if (!el.s.length) { po = 1; both = 0; so = 0; }
      let Wp = 0, Ws = 0; for (const a of el.p) Wp += a.f; for (const a of el.s) Ws += a.f;
      const pg = new Set(el.p.map((a) => a.g)), shared = new Set();
      for (const a of el.s) if (pg.has(a.g)) shared.add(a.g);
      const gm = (g) => (shared.has(g) && g ? g : 0);   // only groups present on both sides exclude each other
      const sufG = new Map(), preG = new Map();
      let pre0 = 0;
      for (const b of el.s) if (gm(b.g)) sufG.set(b.g, (sufG.get(b.g) || 0) + b.f / Ws);
      for (const a of el.p) { if (gm(a.g)) preG.set(a.g, (preG.get(a.g) || 0) + a.f / Wp); else pre0 += a.f / Wp; }
      for (const a of el.p) out.set(affId(a), (both + po) * a.f / Wp);
      for (const b of el.s) {
        const wb = b.f / Ws, gb = gm(b.g);
        let acc = pre0 * wb;
        for (const [g, wa] of preG) { const ex = sufG.get(g) || 0; if (ex < 1 && gb !== g) acc += wa * wb / (1 - ex); }
        out.set(affId(b), so * wb + both * acc);
      }
      return out;
    }

    /** How often each base of `codes` drops from the chosen sources: Map code -> share (sums to 1; empty when no source drops any of them). The sources are
     *  the engine's own (srcDist at the context's difficulty / players / terror zone / mode); o = {diff (-1 or undefined: all), act, area, srcKey (one monster
     *  in one area; its key from sources()), tz (terror zone sources only)}. Several sources are weighted by their kills per run (the per-run model). */
    function baseDropWeights(ctx, codes, o) {
      o = o || {};
      const set = new Set(codes), mass = new Map();
      let tot = 0, n = 0;
      for (const src of areaSources(ctx)) {
        if (o.srcKey ? src.key !== o.srcKey : ((o.diff >= 0 && src.diff !== o.diff) || (o.act && src.act !== o.act) || (o.area && src.area !== o.area) || (o.tz && !src.tz))) continue;
        const f = o.srcKey ? 1 : src.perRun;
        if (!(f > 0)) continue;
        let hit = false;
        for (const [k, p] of srcDist(ctx, src)) {
          const meta = metaCache.get(k);
          if (meta.kind !== 'i' || !set.has(meta.id)) continue;
          mass.set(meta.id, (mass.get(meta.id) || 0) + p * f); tot += p * f; hit = true;
        }
        if (hit) n++;
      }
      const out = new Map();
      if (tot > 0) for (const [c, m] of mass) out.set(c, m / tot);
      out.nSources = n;
      return out;
    }

    /** The builder's affix table for a set of bases at an item level: catalogue rows with availability at that level and appearance odds for magic (exact)
     *  and rare (Monte Carlo, o.rolls per base). Odds are the mean over the bases (a base that cannot roll the affix counting 0), every base counted equally,
     *  or with o.weights (Map / object code -> weight, e.g. baseDropWeights) the weighted mean sum(w * p) / sum(w). Each row also carries the per-base odds
     *  (pb.m / pb.r, in the order of `codes`) for the hover. */
    function builderAffixTable(codes, ilvl, o) {
      o = o || {};
      const cat = builderCatalog(codes, ilvl);
      const quals = (o.qualities || ['magic', 'rare']).filter((q) => q !== 'rare' || o.rare !== false);
      const per = {};
      for (const q of QUALS) per[q] = new Map();
      for (const code of codes) {
        const il = ilOf(code, ilvl);
        for (const q of quals) per[q].set(code, affixAppearance(code, il, q, o.rolls, o.seed, o.diff));
      }
      const wget = (c) => (o.weights ? (o.weights instanceof Map ? o.weights.get(c) : o.weights[c]) || 0 : 1);
      const ws = codes.map(wget), W = ws.reduce((a, b) => a + b, 0);
      const mean = (q, id) => { if (!(W > 0)) return 0; let t = 0; codes.forEach((c, i) => { const m = per[q].get(c); if (m && ws[i]) t += ws[i] * (m.get(id) || 0); }); return t / W; };
      const rows = [];
      for (const r of cat.values()) {
        let lo = null, hi = null, nOn = 0;
        for (const [code, [a, b]] of r.per) {
          lo = lo === null ? a : Math.min(lo, a); hi = hi === null ? b : Math.max(hi, b);
          const il = ilOf(code, ilvl);
          if (il >= a && il <= b) nOn++;
        }
        const pbOf = (q) => codes.map((c) => { const m = per[q].get(c); return m ? m.get(r.id) || 0 : 0; });
        rows.push({ id: r.id, side: r.side, name: r.name, mods: r.mods, desc: r.mods.map((m) => describe(m.key, m.min, m.max, m.v)).join(' / '), lvl: r.lvl, lr: r.lr, cls: r.cls, rare: r.rare,
          g: r.g, groupName: r.groupName, maxLvl: r.maxLvl, tier: r.tier || 0, minIl: lo, maxIl: hi, nBases: r.per.size, nOn, avail: nOn > 0,
          magic: mean('magic', r.id), rareP: r.rare ? mean('rare', r.id) : 0, quals: r.quals,
          ap: Object.fromEntries(quals.map((q) => [q, r.quals.indexOf(q) >= 0 ? mean(q, r.id) : 0])),
          pb: { m: pbOf('magic'), r: r.rare && per.rare.size ? pbOf('rare') : null, q: Object.fromEntries(quals.map((q) => [q, r.quals.indexOf(q) >= 0 ? pbOf(q) : null])) } });
      }
      return rows;
    }

    /** Candidate sources for the conditions on a base at item level il: one entry per distinct (side, group, level requirement, covered conditions). */
    function comboSources(code, il, quality_, conds, diff) {
      const it = items[code], nc = conds.length;
      const el = eligible(code, affixLevel(il, it), quality_ === 'rare', il);
      const out = new Map();
      const add = (side, a) => {
        let mask = 0; for (let i = 0; i < nc; i++) if (condProb(a, conds[i]) > 0) mask |= 1 << i;
        if (!mask) return;
        const g = side === 'a' ? 0 : a.g, key = side + '|' + g + '|' + (a.lr || 0) + '|' + mask;
        if (!out.has(key)) out.set(key, { side, g, lr: a.lr || 0, mask });
      };
      if (!isPlain(quality_)) { for (const a of el.p) add('p', a); for (const a of el.s) add('s', a); }
      for (const a of el.auto) add('a', a);
      // sockets of white items, ethereal, superior bonus rows: no slot, no group, but an item has at most one of each (uniq)
      const addX = (uniq, mask) => { if (mask) out.set('x|' + uniq + '|' + mask, { side: 'x', uniq, g: 0, lr: 0, mask }); };
      const bitsOf = (pred) => { let m = 0; for (let i = 0; i < nc; i++) if (!conds[i].le && pred(conds[i])) m |= 1 << i; return m; };
      if (quality_ === 'normal' || quality_ === 'sup') { const N = plainSocketMax(code, il, diff); addX('sock', bitsOf((c) => c.key === SOCK_KEY && c.min <= N)); }
      if (ethChance(code, quality_) > 0) addX('eth', bitsOf((c) => c.key === ETH_KEY));
      if (quality_ === 'sup') for (const r of supRowsOf(code)) addX('sup', bitsOf((c) => condProb({ mods: D.qi[r] }, c) > 0));
      const L = staffSkills(code);
      if (L) {
        const tiers = staffTiersAt(il), mv = quality_ === 'low' ? CONFIG.nonMagic.lowStaffValue : staffMaxVal();
        conds.forEach((c, i) => {
          if (c.le || c.min > mv) return;
          for (const s of L) if (s.ok && s.k === c.key && tiers.has(tierOf(s.idx))) out.set('k' + s.idx, { side: 'k', g: 0, lr: 0, mask: 1 << i });
        });
      }
      return Array.from(out.values());
    }
    /** Can base `code` at item level il carry all conditions as a `quality_` item, and what is the lowest character level the affixes then require?
     *  Structure only (positive probability): slots (magic 1 prefix + 1 suffix, rare 3 + 3 within the count, automagic and staff skills use none),
     *  affix groups (no two of one group), rare-only affixes on rares, item level windows. relax = {groups, slots} drops those checks (explanations). */
    function planCombo(code, il, quality_, conds, relax) {
      relax = relax || {};
      const nc = conds.length;
      if (!qualityPossible(code, quality_)) return { ok: false };
      if (!nc) return { ok: true, lr: 0, np: 0, ns: 0 };
      const srcs = comboSources(code, il, quality_, conds, relax.diff);
      const full = (1 << nc) - 1, rare = quality_ === 'rare';
      const lim = relax.slots ? { p: 99, s: 99, tot: 99 } : rare ? { p: CONFIG.rareMaxPerSide, s: CONFIG.rareMaxPerSide, tot: Math.max.apply(null, items[code].t === 'jewl' ? CONFIG.rareJewelCounts : CONFIG.rareAffixCounts) } : { p: 1, s: 1, tot: 2 };
      const kmax = CONFIG.staffMods.count.length - 1;
      const byBit = conds.map((c, i) => srcs.filter((s) => (s.mask >> i) & 1));
      let best = null;
      const groups = [], usedX = [];
      const dfs = (cov, np, ns, na, nk, lr) => {
        const score = relax.slots ? np + ns : lr;
        if (best && score >= best.score) return;
        if (cov === full) { best = { score, np, ns, lr }; return; }
        let bit = 0; while ((cov >> bit) & 1) bit++;
        for (const s of byBit[bit]) {
          let dp = 0, ds = 0, da = 0, dk = 0;
          if (s.side === 'p') { if (np >= lim.p || np + ns >= lim.tot) continue; dp = 1; }
          else if (s.side === 's') { if (ns >= lim.s || np + ns >= lim.tot) continue; ds = 1; }
          else if (s.side === 'a') { if (na >= 1) continue; da = 1; }
          else if (s.side === 'x') { if (!relax.groups && usedX.indexOf(s.uniq) >= 0) continue; }   // one socket roll, one ethereal roll, one superior bonus row
          else { if (nk >= kmax) continue; dk = 1; }
          if (s.g && !relax.groups && groups.indexOf(s.g) >= 0) continue;
          if (s.g) groups.push(s.g);
          if (s.side === 'x') usedX.push(s.uniq);
          dfs(cov | s.mask, np + dp, ns + ds, na + da, nk + dk, Math.max(lr, s.lr));
          if (s.g) groups.pop();
          if (s.side === 'x') usedX.pop();
        }
      };
      dfs(0, 0, 0, 0, 0, 0);
      return best ? { ok: true, lr: best.lr, np: best.np, ns: best.ns } : { ok: false };
    }
    /** one base: item levels (base level .. 99) at which the combination is possible: first / last, and the lowest character level it requires
     *  (max of the base's own requirement and the affixes') with the first item level reaching it */
    function comboForBase(code, conds, quality_, relax) {
      const it = items[code], cache = new Map();
      let minIl = null, maxIl = null, req = null, reqIl = null, np = null, ns = null;
      for (let il = Math.max(1, it.q); il <= 99; il++) {
        const ck = affixLevel(il, it) + '|' + staffBase(il) + '|' + maxSockets(code, il) + '|' + plainSocketMax(code, il, relax && relax.diff);
        let p = cache.get(ck);
        if (!p) { p = planCombo(code, il, quality_, conds, relax); cache.set(ck, p); }
        if (!p.ok) continue;
        if (minIl === null) { minIl = il; np = p.np; ns = p.ns; }
        maxIl = il;
        const r = Math.max(it.lv || 0, p.lr);
        if (req === null || r < req) { req = r; reqIl = il; }
      }
      return { code, ok: minIl !== null, minIl, maxIl, reqLv: req, reqIl, np, ns };
    }
    const anyOk = (codes, conds, q, relax) => codes.some((c) => comboForBase(c, conds, q, relax).ok);
    /** why no base can carry the combination as a `quality_` item: list of sentences (relax.diff = difficulty for the sockets of white items) */
    function explainCombo(codes, conds, quality_, diff) {
      const txt = (c) => describeAt(c.key, c.min);
      const ql = QLABEL[quality_] || quality_, plain = isPlain(quality_), dd = { diff };
      if (!codes.some((c) => qualityPossible(c, quality_))) return ['A ' + ql + ' item is not possible for this type' + (plain ? ' (rings, amulets, charms and jewels are always magic or better' + (quality_ === 'sup' ? '; only weapons and armor can be superior' : '') + ').' : '.')];
      const dead = conds.filter((c) => !anyOk(codes, [c], quality_, Object.assign({ groups: true, slots: true }, dd)));
      if (dead.length) return dead.map((c) => txt(c) + ' cannot be rolled on a ' + ql + ' item of this type' + (quality_ === 'rare' && anyOk(codes, [c], 'magic', Object.assign({ groups: true, slots: true }, dd)) ? ' (only magic-only affixes give it)' : '') + '.');
      if (!anyOk(codes, conds, quality_, Object.assign({ groups: true, slots: true }, dd))) return ['No single item level makes all of these stats available together (affix levels, or the item level window of staff skills).'];
      if (!anyOk(codes, conds, quality_, Object.assign({ slots: true }, dd))) {
        const out = [];
        for (let i = 0; i < conds.length; i++) for (let j = i + 1; j < conds.length; j++) if (!anyOk(codes, [conds[i], conds[j]], quality_, Object.assign({ slots: true }, dd))) out.push(txt(conds[i]) + ' and ' + txt(conds[j]) + (plain ? ' only come from sources of which an item has just one (one superior bonus row, one automagic row, one socket roll).' : ' are only available from affixes of the same group, which cannot appear together.'));
        return out.length ? out : [plain ? 'Two or more of these stats only come from sources of which an item has just one (superior bonus row, automagic row).' : 'Two or more of these stats are only available from affixes of the same group, which cannot appear together.'];
      }
      if (plain) return ['These stats cannot be combined on one ' + ql + ' item.'];
      let best = null;
      for (const c of codes) { const r = comboForBase(c, conds, quality_, Object.assign({ slots: true }, dd)); if (r.ok && (!best || r.np + r.ns < best.np + best.ns)) best = r; }
      return ['Needs at least ' + best.np + ' prefix' + (best.np === 1 ? '' : 'es') + ' and ' + best.ns + ' suffix' + (best.ns === 1 ? '' : 'es') + (quality_ === 'magic' ? ', a magic item has 1 prefix and 1 suffix.' : ', a rare item has at most ' + CONFIG.rareMaxPerSide + ' of each and ' + Math.max.apply(null, CONFIG.rareAffixCounts) + ' affixes in all.')];
    }
    /** The builder's answer for a combination on a set of bases: per quality {ok, why[], per[] (comboForBase of each base), minIl/minIlCode (lowest item level),
     *  maxIl (latest item level any base still allows), reqLv/reqCode (lowest character level the finished item needs)}.
     *  o = {diff (0..2, default Hell: the sockets of white items depend on the game difficulty), qualities (default all five)} */
    function comboAnalysis(codes, conds, o) {
      o = o || {};
      const out = {}, dd = { diff: o.diff };
      for (const q of o.qualities || QUALS) {
        const per = codes.map((c) => comboForBase(c, conds, q, dd));
        const ok = per.filter((x) => x.ok);
        const r = { ok: ok.length > 0, per, why: ok.length ? [] : explainCombo(codes, conds, q, o.diff) };
        if (ok.length) {
          const lo = ok.reduce((a, b) => (b.minIl < a.minIl ? b : a)), rq = ok.reduce((a, b) => (b.reqLv < a.reqLv ? b : a));
          r.minIl = lo.minIl; r.minIlCode = lo.code; r.maxIl = Math.max.apply(null, ok.map((x) => x.maxIl));
          r.reqLv = rq.reqLv; r.reqCode = rq.code; r.reqIl = rq.reqIl;
        }
        out[q] = r;
      }
      return out;
    }

    /** Can the combination be carried by any of the qualities on any base at some item level? Early exit (comboForBase without the full sweep). */
    function feasibleAny(codes, conds, qualities, diff) {
      const dd = { diff };
      for (const q of qualities) for (const code of codes) {
        const it = items[code], cache = new Map();
        for (let il = Math.max(1, it.q); il <= 99; il++) {
          const ck = affixLevel(il, it) + '|' + staffBase(il) + '|' + maxSockets(code, il) + '|' + plainSocketMax(code, il, diff);
          let p = cache.get(ck);
          if (!p) { p = planCombo(code, il, q, conds, dd); cache.set(ck, p); }
          if (p.ok) return true;
        }
      }
      return false;
    }
    /** The slider range of conds[i] that is still achievable while every other condition holds: {min, max}. A condition is met by one affix row, so the best
     *  threshold is a row value of the stat (max for ge, min for le); feasibility only gets harder with a better threshold, so binary search over the row values.
     *  Falls back to the catalogue range (builderStats) for flags and when the other conditions already conflict. o = {qualities (default all), diff}. */
    function statRange(codes, conds, i, o) {
      o = o || {};
      const c = conds[i], qs = o.qualities || QUALS;
      const st = builderStats(codes).find((x) => x.key === c.key);
      if (!st) return { min: c.min, max: c.min };
      const full = { min: st.min, max: st.max };
      if (st.flag) return full;
      const vals = new Set();
      for (const r of builderCatalog(codes).values()) for (const x of r.mods) if (x.key === c.key) vals.add(c.le ? x.min : x.max);
      const cand = Array.from(vals).sort((a, b) => (c.le ? a - b : b - a));   // best first
      const ok = (v) => feasibleAny(codes, conds.map((x, j) => j === i ? Object.assign({}, x, { min: v }) : x), qs, o.diff);
      if (!cand.length || !ok(cand[cand.length - 1])) return full;
      let lo = 0, hi = cand.length - 1;   // cand[hi] feasible; find the first feasible
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ok(cand[mid])) hi = mid; else lo = mid + 1; }
      return c.le ? { min: cand[lo], max: st.max } : { min: st.min, max: cand[lo] };
    }

    /** Fast fit test for the affix table: can the combination exist on some base, at some item level, as one of `qualities`? Same rules as planCombo (slots,
     *  groups, one automagic / socket / ethereal / superior row, staff skill count, item level windows) but run over the builder catalogue instead of the full
     *  eligible lists, so it costs microseconds per base. It never says "no" for a combination feasibleAny accepts (item level windows are hulls); the app uses it to
     *  mark table rows that no longer fit. fitIndex(codes) is built once per set of bases; fitsCombo(index, conds, qualities, diff) answers for one combination. */
    function fitIndex(codes) {
      const cat = Array.from(builderCatalog(codes).values()), by = new Map(), keys = new Map();
      for (const r of cat) { r.cm = r.mods.map((m) => [0, 0, m.min, m.max, m.key]); for (const m of r.mods) { if (!keys.has(m.key)) keys.set(m.key, new Set()); keys.get(m.key).add(r); } }
      for (const code of codes) {
        const byId = new Map();
        for (const r of cat) { const rng = r.per.get(code); if (rng) byId.set(r.id, { id: r.id, side: r.side, g: r.g || 0, quals: r.quals, lo: rng[0], hi: rng[1] }); }
        by.set(code, byId);
      }
      return { codes, by, keys };
    }
    function fitsCombo(index, conds, qualities, diff) {
      const nc = conds.length, kmax = CONFIG.staffMods.count.length - 1;
      if (!nc) return true;
      const full = (1 << nc) - 1;
      const hit = new Map();   // catalogue row -> bitmask of the conditions it meets (once for all bases)
      conds.forEach((c, i) => { for (const r of index.keys.get(c.key) || []) if (condProb({ mods: r.cm }, c) > 0) hit.set(r.id, (hit.get(r.id) || 0) | (1 << i)); });
      if (Array.from(hit.values()).reduce((a, m) => a | m, 0) !== full) return false;   // a condition no affix of the type can meet
      for (const code of index.codes) {
        const byId = index.by.get(code);
        const cand = [];
        for (const [id, mask] of hit) {
          const e = byId.get(id); if (!e) continue;
          if (e.side === 'socket' && conds.some((c, i) => ((mask >> i) & 1) && c.key === SOCK_KEY && !c.le && c.min > plainSocketMax(code, 99, diff))) continue;
          cand.push([e, mask]);
        }
        if (cand.reduce((a, x) => a | x[1], 0) !== full) continue;
        for (const q of qualities) {
          if (!qualityPossible(code, q)) continue;
          const lim = isPlain(q) || q === 'magic' ? { p: 1, s: 1, tot: 2 } : { p: CONFIG.rareMaxPerSide, s: CONFIG.rareMaxPerSide, tot: Math.max.apply(null, items[code].t === 'jewl' ? CONFIG.rareJewelCounts : CONFIG.rareAffixCounts) };
          const byBit = conds.map(() => []);
          for (const [e, mask] of cand) {
            if (e.quals.indexOf(q) < 0) continue;
            if ((e.side === 'prefix' || e.side === 'suffix') && isPlain(q)) continue;
            conds.forEach((c, i) => { if ((mask >> i) & 1) byBit[i].push([e, mask]); });
          }
          const groups = [], used = new Set();
          const dfs = (cov, np, ns, na, nk, lo, hi) => {
            if (cov === full) return true;
            let bit = 0; while ((cov >> bit) & 1) bit++;
            for (const [e, mask] of byBit[bit]) {
              const nlo = Math.max(lo, e.lo), nhi = Math.min(hi, e.hi); if (nlo > nhi) continue;
              let dp = 0, ds = 0, da = 0, dk = 0;
              if (e.side === 'prefix') { if (np >= lim.p || np + ns >= lim.tot) continue; dp = 1; }
              else if (e.side === 'suffix') { if (ns >= lim.s || np + ns >= lim.tot) continue; ds = 1; }
              else if (e.side === 'auto') { if (na >= 1) continue; da = 1; }
              else if (e.side === 'staff') { if (nk >= kmax) continue; dk = 1; }
              else if (used.has(e.side)) continue;   // socket / ethereal / superior: one of each
              if (e.g && groups.indexOf(e.g) >= 0) continue;
              if (e.g) groups.push(e.g);
              if (dp + ds + da + dk === 0) used.add(e.side);
              const ok = dfs(cov | mask, np + dp, ns + ds, na + da, nk + dk, nlo, nhi);
              if (e.g) groups.pop();
              if (dp + ds + da + dk === 0) used.delete(e.side);
              if (ok) return true;
            }
            return false;
          };
          if (dfs(0, 0, 0, 0, 0, 1, 99)) return true;
        }
      }
      return false;
    }

    // ---------------- search index ----------------
    function searchIndex() {
      const out = [];
      const explicitI = new Set();
      for (const n in TC) for (const e of TC[n].e) if (items[e[0].split(',')[0]]) explicitI.add(e[0].split(',')[0]);   // e.g. ua1-ua5 statue pieces (spawnable=0 but named in TCs)
      for (const code in items) {
        const it = items[code];
        if (!(it.sp || explicitI.has(code)) || code === 'gld') continue;
        if (it.q <= 0 && it.k !== 'm') continue;
        out.push({ kind: 'base', code, label: it.n + ' (' + code + ', qlvl ' + it.q + (it.tier === 1 ? ', exceptional' : it.tier === 2 ? ', elite' : '') + ')', name: it.n });   // the code is part of the label, so it is searchable too
      }
      const explicitU = new Set();
      for (const n in TC) for (const e of TC[n].e) if (uniqById[e[0]]) explicitU.add(e[0]);   // e.g. Sunder charms (spawnable=0 but dropped explicitly)
      for (const u of D.uniques) if ((u.sp || explicitU.has(u.id)) && !u.dis && dropConditionOK(u.dc, 2)) { const label = u.n + ' - unique ' + (items[u.code] ? items[u.code].n : u.code) + ' (lvl ' + u.lvl + ')'; out.push({ kind: 'unique', id: u.id, code: u.code, label, search: label + ' ' + u.id, name: u.n }); }
      for (const s of D.sets) if (s.sp && !s.dis) { const label = s.n + ' - set ' + (items[s.code] ? items[s.code].n : s.code) + ' (' + s.sn + ', lvl ' + s.lvl + ')'; out.push({ kind: 'set', id: s.id, code: s.code, label, search: label + ' ' + s.id + ' ' + s.set, name: s.n }); }
      return out;
    }

    function baseTypes() {
      // types that have at least one spawnable base and can be magic/rare
      const m = new Map();
      for (const code in items) {
        const it = items[code];
        if (!it.sp || it.an || it.q <= 0 && it.k !== 'm') continue;
        for (const a of it.anc) {
          if (!types[a]) continue;
          if (!m.has(a)) m.set(a, []);
          m.get(a).push(code);
        }
      }
      return m;
    }

    // trials needed to have found the target with cumulative probability q, given per-trial chance p (null = never)
    function trialsFor(p, q) {
      if (!(p > 0)) return null;
      if (p >= 1) return 1;
      return Math.max(1, Math.ceil(Math.log1p(-q) / Math.log1p(-p)));
    }

    return {
      CONFIG, data: D, DIFFS, items, types, getCtx, playersN, adjNoDrop, dist, upgradeTC, areaSources, DUP_OF, areaRun, areaRolls, listShares, bossPacks,
      mode, heraldsAvailable, sunderChance, sunderPaths, isSunder, adjQuality, heraldSpawnPct, quality, qualityTotals, sources, srcDist, chanceFor, baseQualityChance, affixLevel, minIlvlForAlvl, eligible, maxSockets, affixProb, minLevels, staffDist, staffBase,
      statList, describe, describeAt, sliderWhat, affixSearch, searchIndex, baseTypes, metaCache, uniqById, setById, uniqByCode, setByCode, prettyId, tzLevel,
      eligibleUniques, eligibleSets, condProb, trialsFor,
      builderTypes, builderBases, builderCatalog, builderStats, builderAffixTable, baseDropWeights, affixAppearance, planCombo, comboForBase, comboAnalysis, feasibleAny, fitIndex, fitsCombo, statRange, explainCombo, groupName,
      qualityPossible, ethItem, ethChance, plainSocketMax, plainSocketDist, extrasDist, QUALS, QLABEL, SOCK_KEY, ETH_KEY,
    };
  }

  const api = { create, CONFIG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Engine = api;
})(typeof self !== 'undefined' ? self : this);
