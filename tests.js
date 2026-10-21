/* Browser-side half of the validation: runs the real engine and prints one JSON blob into #out.
 * Driven by test_engine.py (headless Edge/Chrome --dump-dom), but you can also open test.html by hand. */
(async function () {
  const out = document.getElementById('out');
  const res = { cases: {}, errors: [] };
  try {
    const data = await (await fetch('data.json')).json();
    const E = Engine.create(data);
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
    res.sourcesCount = E.sources(ctxFor(1, 1)).length;
    res.config = E.CONFIG;
  } catch (e) { res.errors.push(String(e.stack || e)); }
  out.textContent = JSON.stringify(res);
  document.title = 'done';
})();
