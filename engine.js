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
    // --- magic items: share with both / prefix only / suffix only (Arreat Summit, via PureDiablo tutorial) ---
    magicSplit: { both: 0.25, prefixOnly: 0.25, suffixOnly: 0.5 },
    // --- rare items: number of affixes uniform in [min,max]; each affix prefix/suffix 50/50; <=3 of each ---
    rareAffixMin: 3, rareAffixMax: 6, rareJewelMax: 4, rarePrefixChance: 0.5, rareMaxPerSide: 3,
    // --- monster rank level offsets (data guide: "The unique monster bonus can go over [the TZ max]") ---
    champOffset: 2, uniqueOffset: 3, minionOffset: 3,
    // --- ladder: current ladder season used for first/lastLadderSeason gating ---
    currentSeason: 99,
    // --- terror zones ---
    // --- game mode: 'rotw' = Reign of the Warlock (root excel folder), 'lod' = Lord of Destruction (excel\base).
    // The two folders differ only in the Warlock grimoire bases (spawnable in rotw) and their automagic mods.
    // The mode also picks the desecratedzones.json section (expansion vs rotw) and enables heralds (rotw + Hell + TZ only).
    gameMode: 'rotw',
    // --- quest drop (setting `quest`): act bosses with a monstats TreasureClassQuest use it instead of their TC (D2MOO MonsterMode.cpp:
    //     first kill while the killer's quest is open; Andariel's normal TC already is Andarielq). ---
    // ASSUMPTION: D2MOO is 1.10 (no desecrated TCs); in a terror zone D2R may use the desecrated column as-is (Andariel's desecrated
    // columns are 'Andarielq ... Desecrated', which hints at that). true = the quest TC overrides the desecrated TC too (D2MOO order).
    questOverridesTz: true,
    // --- heralds (rotw Hell terror zones) ---
    // ASSUMPTION: monstats TreasureClassHerald* are empty in 3.3, so a herald is assumed to use the monster's
    // TreasureClassDesecratedUnique(H) TC, group-upgraded at (mlvl + herald_treasure_class_level_boost).
    // --- Latent Sunder Charms: three separate paths (official Blizzard patch notes 3.2 / 3.3) ---
    // (a) TABLE path: the 'Sunder Charms' TC that every desecrated champ/unique/super/boss/herald TC includes (Picks -2). Pure data.
    // (b) HERALD BONUS path (hard-coded in the game, nothing in the tables): 3.2 "starts at Tier 1", "no longer modified by
    //     player count", "Tier 3 and 4 have twice the increased chance, Tier 5 three times". Multipliers by tier are known:
    heraldSunderTierMult: [1, 1, 2, 2, 3],
    //     ...but the base chance is UNKNOWN (null = shown as "unknown base"; the UI lets you type one in).
    heraldSunderBonusBase: null,
    // (c) MF path: 3.2 "can drop from any monster ... using Magic Find"; 3.3 "minimum drop level 69 -> 75", "reduced the drop rate
    //     when using Magic Find", "now only drop in Hell". The Sunder uniques are spawnable=0 (lvl 69, lvl req 75) in the tables, so this is a
    //     hard-coded rule: a unique grand charm (cm3) roll may pick one of the six Sunders (weight = rarity x penalty).
    sunderMfMinLevel: 75,
    sunderMfHellOnly: true,
    sunderMfPenalty: 1,            // 3.3 reduced the MF drop rate, size unknown (1 = unreduced)
    // --- herald quality adjustments (herald rows only). 3.2 "slightly reduced Unique, Set and Rare" for heralds; 3.3 "increased Rare and
    //     higher from Herald Tiers 3+". Sizes unknown -> all 1 (no-op). Multipliers on the quality probability (difference goes to/from magic).
    heraldQualityAdj: { t12: { unique: 1, set: 1, rare: 1 }, t3plus: { rarePlus: 1 } },
    // --- per-run estimate (rough!) ---
    run: {
      areaFill: 0.4,               // fraction of the SizeX*SizeY bounding box that is actually walkable/populated
      champShare: 0.2,             // a champion-or-unique pack is a champion pack 20% of the time
      champPackSize: 3,            // champions per champion pack (2-4)
      minionDefault: 2,            // minions with a unique when the monster has no PartyMin/PartyMax
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
    const TC = D.tc;
    const items = D.items;
    const types = D.types;
    const DIFFS = ['Normal', 'Nightmare', 'Hell'];
    const spOf = (it) => (CONFIG.gameMode === 'lod' && it.spl !== undefined) ? it.spl : it.sp;
    const tzModeName = () => (CONFIG.gameMode === 'rotw' ? 'rotw' : 'expansion');

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
          if (!spOf(it) || it.anc.indexOf(pre) < 0) continue;
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

    /** Switch game mode ('lod' | 'rotw'); clears every cache that depends on item/affix spawnability. */
    function setMode(m) {
      if (m === CONFIG.gameMode) return;
      CONFIG.gameMode = m;
      for (const k in genericCache) delete genericCache[k];
      ctxCache.clear(); eligCache.clear(); affCache.clear();
    }
    function heraldsAvailable(sel) { return CONFIG.gameMode === 'rotw' && !!sel.tz; }

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
        out.set(leafKey('u', name, inh), 1);
      } else if (setById[name]) {
        out.set(leafKey('s', name, inh), 1);
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
      else if (uniqById[name]) res = { T: kit.TL, D: new Map([[leafKey('u', name, inh), kit.S]]) };
      else if (setById[name]) res = { T: kit.TL, D: new Map([[leafKey('s', name, inh), kit.S]]) };
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
    function upgradeTC(name, mlvl, isBoss) {
      const tc = TC[name];
      if (!tc || !tc.g || isBoss) return name;
      const list = D.groups[String(tc.g)];
      if (!list) return name;
      let best = name, bl = -1;
      for (const [lv, nm] of list) if (lv <= mlvl && lv >= bl) { best = nm; bl = lv; }
      return best;
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

    function eligibleUniques(code, ilvl, ladder, mlvl, diff) {
      const out = [];
      // path (c): Sunder charms join the unique grand charm pool (hard-coded rule, see CONFIG)
      if (code === 'cm3' && mlvl >= CONFIG.sunderMfMinLevel && (!CONFIG.sunderMfHellOnly || diff === 2) && CONFIG.sunderMfPenalty > 0 && items[code] && spOf(items[code])) {
        for (const id of sunderIds) {
          const u = uniqById[id];
          if (!u || u.dis || u.lvl > ilvl || !ladderOK(u.fl, u.ll, ladder)) continue;
          const w = Object.create(u); w.r = u.r * CONFIG.sunderMfPenalty; w.mf = true; out.push(w);
        }
      }
      for (const u of uniqByCode[code] || []) {
        if (!u.sp || u.dis || u.lvl > ilvl || u.dc || (items[code] && !spOf(items[code]))) continue;
        if (!ladderOK(u.fl, u.ll, ladder)) continue;
        out.push(u);
      }
      return out;
    }
    function eligibleSets(code, ilvl, ladder) {
      const out = [];
      for (const s of setByCode[code] || []) {
        if (!s.sp || s.dis || s.lvl > ilvl || s.dc || (items[code] && !spOf(items[code]))) continue;
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
      const row = ratioRow(it);
      const ilvl = Math.min(mlvl, 99);
      const eu = eligibleUniques(code, ilvl, ladder, mlvl, diff === undefined ? 2 : diff), es = eligibleSets(code, ilvl, ladder);
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
    function tzBounds(d) { const b = D.tz.bounds[tzModeName()] || D.tz.bounds.expansion; return b[d]; }
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

    const BOSS_NAMES = { baalcrab: 'Baal', nihlathakboss: 'Nihlathak', bloodraven: 'Blood Raven', summoner: 'The Summoner', griswold: 'Griswold', izual: 'Izual', radament: 'Radament', andariel: 'Andariel', duriel: 'Duriel', mephisto: 'Mephisto', diablo: 'Diablo' };
    const prettyId = (s) => s.replace(/([a-z])(\d+)$/i, '$1 $2');

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
          const A = D.levels[lid];
          const list = d === 0 ? A.mon : A.nmon;
          if (!list.length || !A.den[d]) continue;
          const inTz = tzOn && D.tz.levels[lid] !== undefined;
          const types_ = list.map((id) => D.monsters[id]).filter(Boolean);
          let rarSum = 0;
          const rarOf = {};   // a monster listed twice has double weight
          for (const id of list) { const m = D.monsters[id]; if (m && m.rar > 0) { rarSum += m.rar; rarOf[id] = (rarOf[id] || 0) + m.rar; } }
          if (rarSum <= 0) continue;
          const packs = A.sx[d] * A.sy[d] * R.areaFill * A.den[d] / 100000;
          const U = (A.umin[d] + A.umax[d]) / 2;
          const seen = {};
          for (const id of list) {
            const m = D.monsters[id];
            if (!m || m.rar <= 0 || seen[id]) continue;
            seen[id] = 1;
            const share = rarOf[id] / rarSum;
            const base = d === 0 ? m.lv[0] : A.lvl[d];
            const lv0 = inTz ? tzLevel(base, s.clvl, d) : base;
            const avgGrp = (m.g[0] + m.g[1]) / 2;
            const minions = m.pm[1] > 0 ? (m.pm[0] + m.pm[1]) / 2 : R.minionDefault;
            const recs = [
              ['regular', lv0, packs * share * avgGrp],
              ['champion', lv0 + CONFIG.champOffset, U * R.champShare * share * R.champPackSize],
              ['unique', lv0 + CONFIG.uniqueOffset, U * (1 - R.champShare) * share],
              ['minion', lv0 + CONFIG.minionOffset, U * (1 - R.champShare) * share * minions],
            ];
            if (d === 2 && inTz && heraldsAvailable(s) && !m.nh) {
              // ASSUMED herald TC (see CONFIG): the monster's desecrated unique TC, group-upgraded at mlvl + tier boost.
              const tier = Math.max(1, Math.min(5, s.tier || 1));
              const hb = (D.tz.herald[tier - 1] || { boost: 0 }).boost;
              const htc = pickTC(m, d, 'unique', true);
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
        // superuniques
        for (const su of D.su) {
          if (D.boss_area[su.cls]) continue;   // Radament / Summoner / Nihlathak / Griswold are also act-boss rows below: keep that one
          const lid = D.su_area[su.id];
          if (!lid || !D.levels[lid]) continue;
          const A = D.levels[lid];
          const cls = D.monsters[su.cls];
          if (!cls) continue;
          const inTz = tzOn && D.tz.levels[String(lid)] !== undefined;
          const base = d === 0 ? cls.lv[0] : A.lvl[d];
          const mlvl = (inTz ? tzLevel(base, s.clvl, d) : base) + CONFIG.uniqueOffset;   // super uniques are unique-rank monsters (+3, may exceed the zone max); act bosses get no bonus
          let tcn = (inTz && su.dtc[d]) || su.tc[d];
          if (!tcn || !TC[tcn]) continue;
          out.push({ key: 'su|' + su.id + '|' + d, mon: su.cls, name: su.n, rank: 'super', diff: d, area: lid,
            areaName: A.name, act: A.act, mlvl, tc: tcn, boss: false, perRun: 1, tz: inTz });
        }
        // act bosses
        for (const id in D.boss_area) {
          const lid = D.boss_area[id];
          const m = D.monsters[id];
          const A = D.levels[lid];
          if (!m || !A) continue;
          const inTz = tzOn && D.tz.levels[String(lid)] !== undefined;
          const base = m.lv[d];
          const mlvl = inTz ? tzLevel(base, s.clvl, d) : base;
          let tcn = pickTC(m, d, 'regular', inTz);
          const qtc = s.quest && m.qtc && m.qtc[d] && TC[m.qtc[d]] && (!inTz || CONFIG.questOverridesTz) ? m.qtc[d] : null;
          if (qtc) tcn = qtc;
          if (!tcn || !TC[tcn]) continue;
          out.push({ key: 'boss|' + id + '|' + d, mon: id, name: BOSS_NAMES[id] || m.n, rank: 'boss', diff: d, area: lid,
            areaName: A.name, act: A.act, mlvl, tc: tcn, boss: true, perRun: 1, tz: inTz, quest: !!qtc });
        }
      }
      return out;
    }

    function srcDist(ctx, src) {
      // bosses keep their own TC unless the zone is terrorized (data guide: group upgrade ignored for bosses unless desecrated)
      const topTC = upgradeTC(src.tc, src.mlvl + (src.tcBoost || 0), src.boss && !src.tz);
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
      const cfgSig = JSON.stringify([CONFIG.sunderMfPenalty, CONFIG.sunderMfMinLevel, CONFIG.sunderMfHellOnly, CONFIG.heraldQualityAdj]);
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
        if (target.kind === 'unique') { for (const x of q.uniques) if (x.u.id === target.id) { res.target += p * x.p; if (x.u.mf) res.mf += p * x.p; } }
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
    function sunderChance(ctx, src) {
      const dm = srcDist(ctx, src);
      let p = 0;
      for (const [k, v] of dm) { const meta = metaCache.get(k); if (meta.kind === 'u' && sunderIds.has(meta.id)) p += v; }
      return Math.min(1, p);
    }
    let sunderW = 0;
    for (const e of (TC['Sunder Charms'] || { e: [] }).e) sunderW += e[1];
    const isSunder = (id) => sunderIds.has(id);
    /** All three Sunder paths for one source. targetId = one Sunder unique (share of the pool) or null for "any Sunder".
     *  Returns {table, bonus (null = unknown base / n.a. = 0 for non-heralds), mf, total (null while a needed part is unknown)}. */
    function sunderPaths(ctx, src, targetId, mf) {
      const share = targetId ? ((TC['Sunder Charms'].e.find((e) => e[0] === targetId) || [0, 0])[1] / sunderW) : 1;
      const table = sunderChance(ctx, src) * share;
      let bonus = 0;
      if (src.herald) {
        const base = CONFIG.heraldSunderBonusBase;
        bonus = base === null || base === undefined ? null : Math.min(1, base * (CONFIG.heraldSunderTierMult[src.tier - 1] || 1)) * share;   // no player-count scaling (3.2)
      }
      let mfp = 0;
      const dm = srcDist(ctx, src);
      for (const [k, p] of dm) {
        const meta = metaCache.get(k);
        if (meta.kind !== 'i' || meta.id !== 'cm3') continue;
        const q = adjQuality(quality('cm3', src.mlvl, mf, meta.f, ctx.ladder, src.diff), src);
        for (const x of q.uniques) if (x.u.mf && (!targetId || x.u.id === targetId)) mfp += p * x.p;
      }
      const total = bonus === null ? null : 1 - (1 - table) * (1 - bonus) * (1 - mfp);
      return { table, bonus, mf: mfp, total };
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
    const eligCache = new Map();
    /** eligible prefix/suffix lists for a base at a given affix level (rare=true: rare-flagged affixes only) */
    function eligible(code, alvl, rare) {
      const key = code + '|' + alvl + '|' + (rare ? 1 : 0);
      let r = eligCache.get(key);
      if (r) return r;
      const it = items[code];
      const cls = itemClasses(it);
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
            // class tagged affixes (e.g. +Sorceress skills) may appear on any base of a matching item type (amulets, staves, charms),\n            // but a class-specific base (e.g. an Amazon bow) only takes affixes of its own class.\n            if (a.cls && cls.length && cls.indexOf(a.cls) < 0) continue;
            let bad = false;
            for (const e of a.et) if (it.anc.indexOf(e) >= 0) { bad = true; break; }
            if (bad) continue;
            res[kind].push(a);
          }
        }
      }
      // automagic (items with an "auto prefix" group): exactly one eligible row is attached
      res.auto = [];
      if (it.ap) {
        for (const a of (autoByGroup[it.ap] || [])) {
          if (!((CONFIG.gameMode === 'lod' && a.spl !== undefined) ? a.spl : a.sp)) continue;
          if (a.lvl > alvl) continue;
          if (a.max && a.max < alvl) continue;
          res.auto.push(a);
        }
      }
      eligCache.set(key, res);
      return res;
    }

    function condProb(a, c) {
      // probability that affix a rolls the condition stat >= min
      let best = 0;
      for (const m of a.mods) {
        if (m[4] !== c.key) continue;
        const mn = m[2], mx = m[3];
        let p;
        if (c.min <= mn) p = 1;
        else if (c.min > mx) p = 0;
        else p = (mx - c.min + 1) / (mx - mn + 1);
        if (p > best) best = p;
      }
      return best;
    }

    /** P(item of given quality has all conditions) for the given base at alvl.
     *  magic: exact enumeration. rare: seeded Monte Carlo (Rao-Blackwellised over the rolled values). */
    const affCache = new Map();
    function affixProb(code, alvl, quality_, conds, opts) {
      const rolls = (opts && opts.rolls) || 200000;
      const seed = (opts && opts.seed) || 12345;
      const el = eligible(code, alvl, quality_ === 'rare');
      if (!el.sig) el.sig = el.p.map((a) => a.i).join(',') + '/' + el.s.map((a) => a.i).join(',') + '/' + el.auto.map((a) => a.g + a.n).join(',');
      // identical affix pools (different alvl) share one result
      const ck = [items[code].t === 'jewl' ? 'J' : '', items[code].cs ? code : '', quality_, rolls, seed, JSON.stringify(conds), el.sig].join('|');
      if (affCache.has(ck)) return affCache.get(ck);
      let res;
      // auto affix
      let autoP = null;   // distribution over auto affixes: [ [prob per cond array], weight ]
      const nc = conds.length;
      const cp = (a) => conds.map((c) => condProb(a, c));
      let autoList = [];
      if (el.auto.length) {
        let W = 0; for (const a of el.auto) W += a.f;
        autoList = el.auto.map((a) => ({ w: a.f / W, c: cp(a) }));
      } else autoList = [{ w: 1, c: new Array(nc).fill(0) }];
      if (quality_ === 'magic') {
        const split = CONFIG.magicSplit;
        let both = split.both, po = split.prefixOnly, so = split.suffixOnly;
        if (!el.p.length && !el.s.length) { res = 0; affCache.set(ck, res); return res; }
        if (!el.p.length) { so = 1; both = 0; po = 0; }
        else if (!el.s.length) { po = 1; both = 0; so = 0; }
        const pre = prepSide(el.p, cp, nc);
        const suf = prepSide(el.s, cp, nc);
        const none = { w: 1, c: new Array(nc).fill(0) };
        const forms = [[both, pre, suf], [po, pre, [none]], [so, [none], suf]];
        let total = 0;
        for (const [fw, L1, L2] of forms) {
          if (fw <= 0) continue;
          let s = 0;
          for (const a of L1) for (const b of L2) {
            let pr = a.w * b.w;
            for (const au of autoList) {
              let q = 1;
              for (let i = 0; i < nc; i++) {
                q *= 1 - (1 - a.c[i]) * (1 - b.c[i]) * (1 - au.c[i]);
                if (q === 0) break;
              }
              s += pr * au.w * q;
            }
          }
          total += fw * s;
        }
        res = total;
      } else {
        res = rareMC(code, el, conds, autoList, rolls, seed);
      }
      affCache.set(ck, res);
      return res;
    }

    function prepSide(list, cp, nc) {
      // collapse affixes with no relevance to the conditions into one "irrelevant" entry
      let W = 0; for (const a of list) W += a.f;
      const out = [];
      let irr = 0;
      for (const a of list) {
        const c = cp(a);
        if (c.some((x) => x > 0)) out.push({ w: a.f / W, c });
        else irr += a.f / W;
      }
      if (irr > 0) out.push({ w: irr, c: new Array(nc).fill(0) });
      return out;
    }

    function rareMC(code, el, conds, autoList, rolls, seed) {
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
      const kMax = (it.t === 'jewl') ? CONFIG.rareJewelMax : CONFIG.rareAffixMax;
      const kMin = Math.min(CONFIG.rareAffixMin, kMax);
      const autoCum = autoList.map((a) => a.w);
      const miss = new Float64Array(nc);   // running product of (1 - p) per condition
      const usedP = [], usedS = [];
      function draw(Sd, used) {
        for (let tries = 0; tries < 60; tries++) {
          const r = rng() * Sd.total;
          let lo = 0, hi = Sd.cum.length - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (Sd.cum[mid] > r) hi = mid; else lo = mid + 1; }
          const g = Sd.groups[lo];
          if (used.indexOf(g) < 0 || g === 0) { used.push(g); return lo; }
        }
        return -1;
      }
      let acc = 0;
      for (let n = 0; n < rolls; n++) {
        const k = kMin + floor(rng() * (kMax - kMin + 1));
        usedP.length = 0; usedS.length = 0;
        for (let i = 0; i < nc; i++) miss[i] = 1;
        let np = 0, ns = 0;
        for (let j = 0; j < k; j++) {
          const canP = np < CONFIG.rareMaxPerSide && P.list.length > 0;
          const canS = ns < CONFIG.rareMaxPerSide && S.list.length > 0;
          if (!canP && !canS) break;
          const pickP = canP && canS ? rng() < CONFIG.rarePrefixChance : canP;
          let idx = pickP ? draw(P, usedP) : draw(S, usedS);
          if (idx < 0) continue;
          const cps = pickP ? P.cps[idx] : S.cps[idx];
          if (pickP) np++; else ns++;
          for (let i = 0; i < nc; i++) miss[i] *= 1 - cps[i];
        }
        let q = 0;
        for (const au of autoList) {
          let z = 1;
          for (let i = 0; i < nc; i++) z *= 1 - miss[i] * (1 - au.c[i]);
          q += au.w * z;
        }
        acc += q;
      }
      return acc / rolls;
    }

    /** For each condition: lowest affix level (and monster level) at which some eligible affix on the base can reach it */
    function minLevels(code, quality_, conds) {
      const it = items[code];
      const out = [];
      for (const c of conds) {
        let found = null;
        for (let al = 1; al <= 99; al++) {
          const el = eligible(code, al, quality_ === 'rare');
          const lists = [el.p, el.s, el.auto];
          let ok = false;
          for (const L of lists) for (const a of L) if (condProb(a, c) > 0) { ok = true; break; }
          if (ok) { found = al; break; }
        }
        out.push({ key: c.key, alvl: found, mlvl: found === null ? null : minIlvlForAlvl(it, found) });
      }
      return out;
    }

    /** stats available (label list) for a set of bases at max alvl and given quality */
    function statList(codes, quality_) {
      const set = new Map();
      for (const code of codes) {
        const el = eligible(code, 99, quality_ === 'rare');
        for (const L of [el.p, el.s, el.auto]) for (const a of L) for (const m of a.mods) {
          const cur = set.get(m[4]) || { key: m[4], max: 0 };
          if (m[3] > cur.max) cur.max = m[3];
          set.set(m[4], cur);
        }
      }
      return Array.from(set.values()).sort((a, b) => a.key.localeCompare(b.key));
    }

    /** Ranked list of kill sources for "base(s) + quality + affix conditions".
     *  o = {codes, quality:'magic'|'rare', conds:[{key,min}], mf, diff(-1 all), act(0 all), area(0 all), rolls}  */
    function affixSearch(ctx, o, progress) {
      const codes = new Set(o.codes);
      const qn = o.quality;
      let srcs = sources(ctx).filter((s) => (o.diff < 0 || s.diff === o.diff) && (!o.act || s.act === o.act) && (!o.area || s.area === o.area));
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
          const w = p * q[qn];
          pbase += p;
          if (w <= 0) continue;
          pq += w;
          const alvl = affixLevel(src.mlvl, items[code]);
          const pk = code + '|' + alvl;
          parts.set(pk, (parts.get(pk) || 0) + w);
          need.set(pk, [code, alvl]);
        }
        if (pq > 0) recs.push({ src, parts, pbase, pq });
      }
      const probs = new Map();
      let done = 0;
      for (const [pk, [code, alvl]] of need) {
        probs.set(pk, affixProb(code, alvl, qn, o.conds, { rolls: o.rolls }));
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
        rows.push({ src: r.src, pBase: r.pbase, pQual: r.pq, pAff: tot / r.pq, pTotal: tot, perRun: tot * r.src.perRun, alvl });
      }
      return { rows, minLv: o.codes.length ? o.codes.map((c) => minLevels(c, qn, o.conds)) : [], pools: need.size };
    }

    // ---------------- search index ----------------
    function searchIndex() {
      const out = [];
      for (const code in items) {
        const it = items[code];
        if (!spOf(it) || code === 'gld') continue;
        if (it.q <= 0 && it.k !== 'm') continue;
        out.push({ kind: 'base', code, label: it.n + ' (' + code + ', qlvl ' + it.q + (it.tier === 1 ? ', exceptional' : it.tier === 2 ? ', elite' : '') + ')', name: it.n });
      }
      const explicitU = new Set();
      for (const n in TC) for (const e of TC[n].e) if (uniqById[e[0]]) explicitU.add(e[0]);   // e.g. Sunder charms (spawnable=0 but dropped explicitly)
      for (const u of D.uniques) if ((u.sp || explicitU.has(u.id)) && !u.dis && !u.dc) out.push({ kind: 'unique', id: u.id, code: u.code, label: u.id + ' - unique ' + (items[u.code] ? items[u.code].n : u.code) + ' (lvl ' + u.lvl + ')', name: u.id });
      for (const s of D.sets) if (s.sp && !s.dis) out.push({ kind: 'set', id: s.id, code: s.code, label: s.id + ' - set ' + (items[s.code] ? items[s.code].n : s.code) + ' (' + s.set + ', lvl ' + s.lvl + ')', name: s.id });
      return out;
    }

    function baseTypes() {
      // types that have at least one spawnable base and can be magic/rare
      const m = new Map();
      for (const code in items) {
        const it = items[code];
        if (!spOf(it) || it.an || it.q <= 0 && it.k !== 'm') continue;
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
      CONFIG, data: D, DIFFS, items, types, getCtx, playersN, adjNoDrop, dist, upgradeTC,
      setMode, heraldsAvailable, sunderChance, sunderPaths, isSunder, adjQuality, heraldSpawnPct, spOf, quality, qualityTotals, sources, srcDist, chanceFor, baseQualityChance, affixLevel, minIlvlForAlvl, eligible, affixProb, minLevels,
      statList, affixSearch, searchIndex, baseTypes, metaCache, uniqById, setById, uniqByCode, setByCode, prettyId, tzLevel,
      eligibleUniques, eligibleSets, condProb, trialsFor,
    };
  }

  const api = { create, CONFIG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Engine = api;
})(typeof self !== 'undefined' ? self : this);
