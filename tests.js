/* Browser-side half of the validation: runs the real engine and prints one JSON blob into #out.
 * Driven by test_engine.py (headless Edge/Chrome --dump-dom), but you can also open test.html by hand. */
(async function () {
  const out = document.getElementById('out');
  const res = { cases: {}, errors: [] };
  try {
    const data = await (await fetch('data.json')).json();
    const E = Engine.create(data);
    E.CONFIG.dropCap = null;   // the legacy comparisons below are against the uncapped independent re-implementation
    const ctxFor = (players, party) => E.getCtx({ players: players || 1, party: party || 1, ladder: true, tz: false, mf: 0 });
    const find = (ctx, name, diff, ranks) => E.sources(ctx).find((s) => s.name === name && s.diff === diff && ranks.indexOf(s.rank) >= 0);

    const cases = [
      ['Andariel', 2, ['boss']], ['Mephisto', 2, ['boss']], ['The Countess', 2, ['super']], ['Duriel', 2, ['boss']], ['Baal', 2, ['boss']],
    ];
    for (const [name, diff, ranks] of cases) {
      for (const mf of [0, 300]) {
        for (const pl of [1, 3]) {
          const ctx = ctxFor(pl, 1);
          const s = find(ctx, name, diff, ranks);
          const t = E.qualityTotals(ctx, s, mf);
          res.cases[[name, 'H', 'mf' + mf, 'p' + pl].join('|')] = { mlvl: s.mlvl, tc: s.tc, N: ctx.N, totals: t };
        }
      }
    }
    // specific items
    const spec = [
      ['Mephisto', 2, ['boss'], { kind: 'unique', id: 'Harlequin Crest' }],
      ['Mephisto', 2, ['boss'], { kind: 'set', id: "Tal Rasha's Horadric Crest" }],
      ['Andariel', 2, ['boss'], { kind: 'unique', id: 'Harlequin Crest' }],
      ['The Countess', 2, ['super'], { kind: 'base', code: 'r24' }],
      ['The Countess', 2, ['super'], { kind: 'base', code: 'r30' }],
      ['The Countess', 2, ['super'], { kind: 'base', code: 'r23' }],
      ['The Countess', 2, ['super'], { kind: 'base', code: 'r01' }],
      ['The Countess', 2, ['super'], { kind: 'base', code: 'r12' }],
      ['Mephisto', 2, ['boss'], { kind: 'base', code: 'r30' }],
    ];
    for (const [name, diff, ranks, tg] of spec) {
      for (const mf of [0, 300]) {
        const ctx = ctxFor(1, 1);
        const s = find(ctx, name, diff, ranks);
        const c = E.chanceFor(ctx, s, tg, mf);
        res.cases['spec|' + name + '|' + (tg.id || tg.code) + '|mf' + mf] = { mlvl: s.mlvl, tc: s.tc, c };
      }
    }
    // pure formula checks
    const baalTc = data.tc['Baal (H)'];
    res.formula = {
      effMF200: Math.floor((200 * 250) / (200 + 250)),
      effMF300: Math.floor((300 * 250) / (300 + 250)),
      playersN: [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [3, 3], [8, 8], [8, 2]].map(([p, q]) => [p, q, E.playersN(p, q)]),
      adjNoDrop_60_40: [1, 2, 3, 4].map((n) => E.adjNoDrop(60, 40, n)),
      baalTc,
      // baal hell, base qlvl 85, 200 MF : final p (integer arithmetic)
      baal_unique_p: (function () {
        const row = data.ratio.find((r) => r.ver === 1 && r.uber === 1 && r.cls === 0);
        let p = row.u[0] * 128 - Math.floor(((99 - 85) * 128) / row.u[1]);
        p = Math.floor((p * 100) / (100 + 111));
        p = Math.max(p, row.u[2]);
        return p - Math.floor((p * baalTc.u) / 1024);
      })(),
    };
    // ---- game modes -----------------------------------------------------------------------------
    res.modes = {};
    const grim = Object.keys(data.items).filter((c) => data.items[c].t === 'grim');
    const grimSet = new Set(grim);
    const bracket = (q) => Math.max(3, Math.ceil(q / 3) * 3);
    const grimBr = new Set(grim.map((c) => bracket(data.items[c].q)));
    const midBase = Object.keys(data.items).find((c) => { const it = data.items[c]; return it.k === 'a' && it.sp && it.t !== 'grim' && !it.cs && it.q >= 40 && it.q <= 70 && grimBr.has(bracket(it.q)); });
    res.modes.midBase = midBase;
    for (const mode of ['lod', 'rotw']) {
      E.setMode(mode);
      const ctx = ctxFor(1, 1);
      const srcs = E.sources(ctx).filter((s) => s.diff === 2);
      let grimMass = 0, maxGrim = 0;
      for (const s of srcs) {
        let m = 0;
        for (const [k, p] of E.srcDist(ctx, s)) { const meta = E.metaCache.get(k); if (meta.kind === 'i' && grimSet.has(meta.id)) m += p; }
        grimMass += m; if (m > maxGrim) maxGrim = m;
      }
      const meph = srcs.find((s) => s.name === 'Mephisto' && s.rank === 'boss');
      const c = E.chanceFor(ctx, meph, { kind: 'base', code: midBase }, 0);
      const idx = E.searchIndex().filter((x) => x.kind === 'base' && grimSet.has(x.code)).length;
      const opts = E.baseTypes();
      res.modes[mode] = { grimMass, maxGrim, midBaseMeph: c.base, indexGrim: idx, autoGrim: E.eligible('wa5', 99, false).auto.length,
        grimSpOf: grim.map((g) => E.spOf(data.items[g])).reduce((a, b) => a + b, 0) };
    }
    E.setMode('rotw');

    // ---- heralds ---------------------------------------------------------------------------------
    res.herald = { tiers: {}, sunder: {} };
    for (const clvl of [60, 94]) {
      for (const tier of [1, 5]) {
        const ctx = E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl, tier, mf: 0 });
        const hs = E.sources(ctx).find((s) => s.rank === 'herald' && s.mon === 'zombie1' && s.areaName === 'Blood Moor' && s.diff === 2);
        res.herald.tiers['c' + clvl + 't' + tier] = { mlvl: hs.mlvl, tc: hs.tc, boost: hs.tcBoost, resolved: E.upgradeTC(hs.tc, hs.mlvl + hs.tcBoost, false), src: hs.tc };
      }
    }
    for (const [pl, pa] of [[1, 1], [3, 1], [8, 8], [5, 2]]) {
      const ctx = E.getCtx({ players: pl, party: pa, ladder: true, tz: true, clvl: 85, tier: 1, mf: 0 });
      const hs = E.sources(ctx).find((s) => s.rank === 'herald' && s.mon === 'zombie1' && s.areaName === 'Blood Moor' && s.diff === 2);
      res.herald.sunder[pl + '/' + pa] = { N: ctx.N, p: E.sunderChance(ctx, hs) };
    }
    // herald only exists in rotw + TZ
    { E.setMode('lod'); const ctx = E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: 1, mf: 0 }); res.herald.inLod = E.sources(ctx).filter((s) => s.rank === 'herald').length;
      E.setMode('rotw'); const c2 = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, clvl: 85, tier: 1, mf: 0 }); res.herald.noTz = E.sources(c2).filter((s) => s.rank === 'herald').length;
      const c3 = E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: 1, mf: 0 }); res.herald.count = E.sources(c3).filter((s) => s.rank === 'herald').length; }
    // ---- Sunder paths (patch notes 3.2/3.3) -------------------------------------------------------
    res.sunderPaths = { bonus: {}, table: {}, mf: {}, adj: {} };
    const hsrc = (tier, pl, pa, clvl) => { const ctx = E.getCtx({ players: pl || 1, party: pa || 1, ladder: true, tz: true, clvl: clvl || 85, tier, mf: 0 });
      return [ctx, E.sources(ctx).find((s) => s.rank === 'herald' && s.mon === 'zombie1' && s.areaName === 'Blood Moor' && s.diff === 2)]; };
    E.CONFIG.heraldSunderBonusBase = null;
    { const [ctx, hs] = hsrc(1); const sp = E.sunderPaths(ctx, hs, null, 0); res.sunderPaths.unknown = { bonus: sp.bonus, total: sp.total, table: sp.table, chance: E.sunderChance(ctx, hs) }; }
    E.CONFIG.heraldSunderBonusBase = 0.01;
    for (const tier of [1, 2, 3, 4, 5]) { const [ctx, hs] = hsrc(tier); res.sunderPaths.bonus[tier] = E.sunderPaths(ctx, hs, null, 0).bonus; }
    for (const pl of [1, 3, 8]) { const [ctx, hs] = hsrc(5, pl, 1); const sp = E.sunderPaths(ctx, hs, null, 0); res.sunderPaths.table[pl] = { table: sp.table, bonus: sp.bonus }; }
    { const [ctx, hs] = hsrc(1); const sp = E.sunderPaths(ctx, hs, 'Cold Rupture', 0); res.sunderPaths.coldShare = { table: sp.table, bonus: sp.bonus, any: E.sunderPaths(ctx, hs, null, 0).table }; }
    E.CONFIG.heraldSunderBonusBase = null;
    // MF path
    const cm3f = [983, 983, 983, 1024];
    const mfCount = (mlvl, diff) => { const q = E.quality('cm3', mlvl, 0, cm3f, true, diff); return { n: q.uniques.filter((x) => x.u.mf).length, p: q.uniques.filter((x) => x.u.mf).reduce((a, x) => a + x.p, 0), byId: Object.fromEntries(q.uniques.filter((x) => x.u.mf).map((x) => [x.u.id, x.p])) }; };
    res.sunderPaths.mf = { m74h: mfCount(74, 2), m75h: mfCount(75, 2), m87h: mfCount(87, 2), m87n: mfCount(87, 1), m87nm0: mfCount(87, 0), m99h: mfCount(99, 2), nonSunderUniques87: E.quality('cm3', 87, 0, cm3f, true, 2).uniques.filter((x) => !x.u.mf).map((x) => x.u.id) };
    { const ctx = ctxFor(1, 1); const hell = E.sources(ctx).filter((s) => s.diff === 2 && !s.tz);
      const lowS = hell.find((s) => s.rank === 'regular' && s.mlvl < 75); const hiS = hell.find((s) => s.name === 'Mephisto' && s.rank === 'boss');
      const tg = { kind: 'unique', id: 'Cold Rupture' };
      res.sunderPaths.src = { lowMlvl: lowS.mlvl, low: E.chanceFor(ctx, lowS, tg, 0).mf, hiMlvl: hiS.mlvl, hi: E.chanceFor(ctx, hiS, tg, 0).mf, hiMf300: E.chanceFor(ctx, hiS, tg, 300).mf,
        hiTable: E.chanceFor(ctx, hiS, tg, 0).explicit };
      const nmS = E.sources(ctx).filter((s) => s.diff === 1 && s.mlvl >= 75); res.sunderPaths.src.nmHigh = nmS.length;
      res.sunderPaths.src.nmMf = nmS.length ? E.chanceFor(ctx, nmS[0], tg, 0).mf : 0; }
    // herald quality adj
    { const [ctx, hs1] = hsrc(1), [ctx3, hs3] = hsrc(3);
      const manual = (cx, s) => { let u = 0; for (const [k, p] of E.srcDist(cx, s)) { const m = E.metaCache.get(k); if (m.kind === 'i' && m.id !== 'gld') u += p * E.quality(m.id, s.mlvl, 0, m.f, true, s.diff).unique; } return u; };
      const tot = (cx, s) => E.qualityTotals(cx, s, 0).unique;
      res.sunderPaths.adj.default1 = [manual(ctx, hs1), tot(ctx, hs1)]; res.sunderPaths.adj.default3 = [manual(ctx3, hs3), tot(ctx3, hs3)];
      E.CONFIG.heraldQualityAdj = { t12: { unique: 0.5, set: 1, rare: 1 }, t3plus: { rarePlus: 2 } };
      res.sunderPaths.adj.half1 = tot(E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: 1, mf: 0 }), hs1);
      res.sunderPaths.adj.dbl3 = tot(ctx3, hs3);
      const nonH = E.sources(ctx).find((s) => s.rank === 'unique' && s.mon === 'zombie1' && s.areaName === 'Blood Moor' && s.diff === 2);
      res.sunderPaths.adj.nonHerald = [manual(ctx, nonH), tot(ctx, nonH)];
      E.CONFIG.heraldQualityAdj = { t12: { unique: 1, set: 1, rare: 1 }, t3plus: { rarePlus: 1 } }; }
    // ---- per-kill drop cap (CONFIG.dropCap) ----------------------------------------------------------------
    res.cap = { dist: {}, knell: {}, off: {}, dups: {}, tal: {}, perf: {} };
    const dumpDist = (ctx, tc, mlvl) => { const o = []; for (const [k, p] of E.dist(tc, ctx, mlvl, [0, 0, 0, 0])) { const m = E.metaCache.get(k); o.push([m.kind, m.id, m.f, p]); } return o; };
    const CAP_TCS = ['Duriel (H)', 'Duriel (H) Desecrated D', 'Mephisto (H) Desecrated D', 'Countess (H)', 'Andarielq (H)', 'Andarielq (H) Desecrated H'];
    for (const cap of [6, null]) {
      E.CONFIG.dropCap = cap;
      for (const tc of CAP_TCS) for (const pl of [1, 8]) {
        const ctx = ctxFor(pl, 1);
        res.cap.dist[(cap || 0) + '|' + tc + '|' + pl] = { N: ctx.N, leaves: dumpDist(ctx, tc, 85) };
      }
    }
    // Knell Striker (unique scepter) from normal Cow King, 620 MF, 1 player: Cow King never reaches 6 items, so cap on == cap off
    for (const cap of [null, 6]) {
      E.CONFIG.dropCap = cap;
      const ctx = ctxFor(1, 1);
      const cow = E.sources(ctx).find((s) => s.name === 'The Cow King' && s.diff === 0);
      const c = E.chanceFor(ctx, cow, { kind: 'unique', id: 'Knell Striker' }, 620);
      res.cap.knell[cap || 0] = { target: c.target, base: c.base, tc: cow.tc, mlvl: cow.mlvl };
    }
    // dropCap = null / 0 must be the old engine: compare with the Hell Duriel totals of the legacy section (uncapped Ref match above)
    for (const cap of [null, 0, 6]) {
      E.CONFIG.dropCap = cap;
      const ctx = ctxFor(1, 1);
      const s = find(ctx, 'Duriel', 2, ['boss']);
      res.cap.off[String(cap)] = { totals: E.qualityTotals(ctx, s, 0) };
    }
    // duplicates in sources()
    { const ctx = ctxFor(1, 1); const seen = {}; const dup = [];
      for (const s of E.sources(ctx)) { const k = s.name + '|' + s.mon + '|' + s.rank + '|' + s.area + '|' + s.diff; if (seen[k]) dup.push(k); seen[k] = 1; }
      const nm = {}; const dupName = [];
      for (const s of E.sources(ctx)) { if (s.rank === 'regular' || s.rank === 'champion' || s.rank === 'unique' || s.rank === 'minion' || s.rank === 'herald') continue; const k = s.name + '|' + s.area + '|' + s.diff; if (nm[k]) dupName.push(k); nm[k] = 1; }
      res.cap.dups = { dup, dupName, bossNames: ['Nihlathak', 'Radament', 'The Summoner', 'Griswold'].map((n) => E.sources(ctx).filter((s) => s.name === n && s.diff === 2).map((s) => s.rank)) }; }
    // Tal Rasha's Tomb: Unraveler listed twice
    { const ctx = ctxFor(1, 1); const rows = E.sources(ctx).filter((s) => s.diff === 2 && s.rank === 'regular' && s.areaName === "Tal Rasha's Tomb" && s.area === 66);
      const A = data.levels['66']; const names = {}; for (const r of rows) names[r.mon] = r;
      const packsBase = A.sx[2] * A.sy[2] * E.CONFIG.run.areaFill * A.den[2] / 100000;
      const shares = rows.map((r) => ({ mon: r.mon, share: r.share, perRun: r.perRun }));
      res.cap.tal = { shares, packsBase, nmon: A.nmon, rows: rows.length, apparition: rows.filter((r) => /wraith/.test(r.mon)).map((r) => ({ mon: r.mon, n: r.name, perRun: r.perRun })) }; }
    { E.CONFIG.dropCap = 6; const ctx = ctxFor(1, 1); const S = E.sources(ctx); const f1 = (n, d) => S.find((s) => s.name === n && s.diff === d && s.rank === 'super');
      const rak = f1('Rakanishu', 0), rad = S.find((s) => s.name === 'Radament' && s.diff === 2);
      res.cap.su = { pind: f1('Pindleskin', 2).mlvl, countess: f1('The Countess', 2).mlvl, rak: rak.mlvl, cow: S.find((s) => s.name === 'The Cow King' && s.diff === 0).mlvl,
        bane: E.chanceFor(ctx, rak, { kind: 'unique', id: 'Bane Ash' }, 0).target, radament: rad.mlvl, radamentBase: data.monsters.radament.lv[2] }; }
    // performance: all Hell sources, cap on vs off (cold caches via a fresh context key)
    for (const cap of [null, 6]) {
      E.CONFIG.dropCap = cap;
      const ctx = E.getCtx({ players: cap ? 6 : 5, party: 1, ladder: true, tz: true, clvl: 96, mf: 620, tier: 1 });   // same N=3, separate cold caches
      const t0 = Date.now(); let n = 0;
      for (const s of E.sources(ctx)) { if (s.diff !== 2) continue; E.srcDist(ctx, s); n++; }
      res.cap.perf[cap || 0] = { ms: Date.now() - t0, n };
    }
    E.CONFIG.dropCap = 6;
    res.trials = { half: [0.25, 0.5, 0.75, 0.99].map((q) => E.trialsFor(0.5, q)), p449: E.trialsFor(1 / 449, 0.5), p449_99: E.trialsFor(1 / 449, 0.99), zero: E.trialsFor(0, 0.5), neg: E.trialsFor(-1, 0.5), one: E.trialsFor(1, 0.99), tiny: E.trialsFor(1e-12, 0.5) };
    res.sourcesCount = E.sources(ctxFor(1, 1)).length;
    res.config = E.CONFIG;
  } catch (e) { res.errors.push(String(e.stack || e)); }
  out.textContent = JSON.stringify(res);
  document.title = 'done';
})();
