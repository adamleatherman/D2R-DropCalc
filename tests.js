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
    // ---- quest drop (act bosses use TreasureClassQuest) ----
    res.quest = {};
    { const cq = (q) => E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0, quest: q });
      const hc = { kind: 'unique', id: 'Harlequin Crest' };
      for (const nm of ['Mephisto', 'Andariel', 'Baal', 'Diablo', 'Duriel']) {
        const r = {};
        for (const q of [false, true]) {
          const ctx = cq(q), sr = (q && find(ctx, nm + ' (quest)', 2, ['boss'])) || find(ctx, nm, 2, ['boss']);   // quest on: the quest row (none for Andariel)
          r[q ? 'on' : 'off'] = { tc: sr.tc, mlvl: sr.mlvl, N: ctx.N, quest: sr.quest, totals: E.qualityTotals(ctx, sr, 0), hc: E.chanceFor(ctx, sr, hc, 0).target, hc300: E.chanceFor(ctx, sr, hc, 300).target };
        }
        res.quest[nm] = r;
      }
      { const ctx = cq(true), sr = find(ctx, 'Mephisto (quest)', 2, ['boss']);   // a base the quest TC can drop: weapon/armor -> rare-or-better only
        let code = null; for (const [k, p] of E.srcDist(ctx, sr)) { const m = E.metaCache.get(k); if (m.kind === 'i' && p > 0 && E.items[m.id] && E.items[m.id].k && E.items[m.id].t !== 'grim' && !/^r\d\d$|^gld$/.test(m.id) && E.items[m.id].sp) { code = m.id; break; } }
        const c = code && E.chanceFor(ctx, sr, { kind: 'base', code }, 0), o = code && E.chanceFor(cq(false), find(cq(false), 'Mephisto', 2, ['boss']), { kind: 'base', code }, 0);
        res.quest.mephBase = { code, on: c, off: o }; }
      { const f = (q) => E.sources(E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, mf: 0, quest: q })).filter((x) => x.rank === 'boss' && x.mon === 'diablo' && x.diff === 2 && x.tz).sort((a, b) => b.quest - a.quest)[0];   // the quest row when there is one; getCtx returns a shared object: use each result at once
        const on = f(true), off = f(false); E.CONFIG.questOverridesTz = false; const fl = f(true); E.CONFIG.questOverridesTz = true;
        res.quest.tz = { on: on && on.tc, off: off && off.tc, flagOff: fl && fl.tc }; }
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
        let p = row.u[0] - Math.trunc((99 - 85) / row.u[1]);
        p = Math.trunc((12800 * p) / (100 + 111));
        p = Math.max(p, row.u[2]);
        return p - Math.floor((p * baalTc.u) / 1024);
      })(),
    };
    // ---- class tagged affixes: class-specific bases only take their own class, neutral bases of a matching type take any
    res.affix = {};
    for (const code of ['ob1', 'ba1', 'am5', 'amu']) {
      const el = E.eligible(code, 99, false);
      res.affix[code] = { p: el.p.map((a) => a.n + '|' + a.cls).sort(), s: el.s.map((a) => a.n + '|' + a.cls).sort() };
    }
    // ---- game modes: one data file (and engine) per mode ------------------------------------------
    // RotW = data.json (E), LoD = data-lod.json (EL). The engines share CONFIG (dropCap is off here).
    res.modes = {};
    const dataL = await (await fetch('data-lod.json')).json();
    const EL = Engine.create(dataL);
    E.CONFIG.gameMode = 'rotw';
    const grim = Object.keys(data.items).filter((c) => data.items[c].t === 'grim');
    const grimSet = new Set(grim);
    const bracket = (q) => Math.max(3, Math.ceil(q / 3) * 3);
    const grimBr = new Set(grim.map((c) => bracket(data.items[c].q)));
    const midBase = Object.keys(data.items).find((c) => { const it = data.items[c]; return it.k === 'a' && it.sp && it.t !== 'grim' && !it.cs && it.q >= 40 && it.q <= 70 && grimBr.has(bracket(it.q)); });
    res.modes.midBase = midBase;
    res.modes.meta = { rotw: data.meta, lod: dataL.meta, rotwMode: E.mode, lodMode: EL.mode, lodDirty: Object.keys(dataL.items).filter((c) => dataL.items[c].spl !== undefined).length + dataL.automagic.filter((a) => a.spl !== undefined).length,
      rotwHeraldTiers: data.tz.herald.length, lodHeraldTiers: dataL.tz.herald.length };
    for (const [mode, Em, Dm] of [['rotw', E, data], ['lod', EL, dataL]]) {
      const ctx = Em.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0 });
      const srcs = Em.sources(ctx).filter((s) => s.diff === 2);
      let grimMass = 0, maxGrim = 0;
      for (const s of srcs) {
        let m = 0;
        for (const [k, p] of Em.srcDist(ctx, s)) { const meta = Em.metaCache.get(k); if (meta.kind === 'i' && grimSet.has(meta.id)) m += p; }
        grimMass += m; if (m > maxGrim) maxGrim = m;
      }
      const meph = srcs.find((s) => s.name === 'Mephisto' && s.rank === 'boss');
      const c = Em.chanceFor(ctx, meph, { kind: 'base', code: midBase }, 0);
      const index = Em.searchIndex();
      const idx = index.filter((x) => x.kind === 'base' && grimSet.has(x.code)).length;
      const inIdx = (codes) => codes.filter((cd) => index.some((x) => x.kind === 'base' && x.code === cd)).length;
      res.modes[mode] = { grimMass, maxGrim, midBaseMeph: c.base, indexGrim: idx, autoGrim: Em.eligible('wa5', 99, false).auto.length,
        statueInIndex: inIdx(['ua1', 'ua2', 'ua3', 'ua4', 'ua5']), shardInIndex: inIdx(['xa1', 'xa2', 'xa3', 'xa4', 'xa5']),
        poolShare: (function () { const d = Em.dist('armo' + bracket(Dm.items[midBase].q), ctx, 99, [0, 0, 0, 0]); let p = 0; for (const [k, v] of d) { const mt = Em.metaCache.get(k); if (mt.kind === 'i' && mt.id === midBase) p += v; } return p; })(),
        // the Tab 1 autocomplete source is exactly searchIndex() (app.js: autocomplete($('q1'), $('ac1'), () => INDEX, ...)): spawnable=0 items named in TCs must be there
        acKeys: ['pk1', 'pk2', 'pk3'].map((cd) => { const x = index.find((y) => y.kind === 'base' && y.code === cd); return x ? x.label : null; }),
        acQuery: (function () { const words = 'key of'.split(' '); return index.filter((x) => words.every((w) => x.label.toLowerCase().indexOf(w) >= 0)).map((x) => x.code); })(),
        acEssence: index.filter((x) => x.kind === 'base' && x.label.toLowerCase().indexOf('essence') >= 0).length,
        grimSp: grim.map((g) => Dm.items[g] ? Dm.items[g].sp : 0).reduce((a, b) => a + b, 0),
        warAmulet: ['p', 's'].map((k) => Em.eligible('amu', 99, false)[k].filter((a) => a.cls === 'war').length).reduce((a, b) => a + b, 0),
        sorAmulet: ['p', 's'].map((k) => Em.eligible('amu', 99, false)[k].filter((a) => a.cls === 'sor').length).reduce((a, b) => a + b, 0),
        warAffixesInData: Dm.prefixes.concat(Dm.suffixes).filter((a) => a.cls === 'war').length,
        andariel: Dm.tc['Andarielq (H)'] && { u: Dm.tc['Andarielq (H)'].u, s: Dm.tc['Andarielq (H)'].s, r: Dm.tc['Andarielq (H)'].r, m: Dm.tc['Andarielq (H)'].m },
        heraldSources: Em.sources(Em.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: 1, mf: 0 })).filter((s) => s.rank === 'herald').length,
        tzBounds: Dm.tz.bounds };
    }
    // ---- display names and stat descriptions (strings/*.json), both modes ------------------------------
    res.names = {};
    for (const [mode, Em, Dm] of [['rotw', E, data], ['lod', EL, dataL]]) {
      const index = Em.searchIndex();
      const mods = Dm.prefixes.concat(Dm.suffixes, Dm.automagic).filter((a) => a.sp).map((a) => a.mods.map((m) => [a, m])).reduce((x, y) => x.concat(y), []);
      const tab = (n) => { const m = mods.find((x) => x[1][0] === 'skilltab' && x[1][1] === String(n)); return m ? m[1][4] : null; };
      const search = (q) => index.filter((x) => q.toLowerCase().split(/\s+/).every((w) => (x.search || x.label).toLowerCase().indexOf(w) >= 0)).map((x) => x.label);
      const aff = Dm.prefixes.find((a) => a.n === 'TaintedAffix');
      const su = Em.sources(Em.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0 })).find((x) => x.key === 'su|Siege Boss|2');
      res.names[mode] = {
        hc: Em.uniqById['Harlequin Crest'].n, hcLabel: (index.find((x) => x.id === 'Harlequin Crest') || {}).label,
        thunder: Em.uniqById["Thudergod's Vigor"].n, thunderBoth: [search('thundergod').length, search('thudergod').length],
        siege: su ? su.name : null, siegeId: Dm.su.find((x) => x.id === 'Siege Boss').n,
        tainted: aff ? aff.dn : null, eburin: (Dm.prefixes.find((a) => a.n === 'Eburin') || {}).dn, taintedId: aff ? aff.n : null,
        tabs: [21, 22, 23].map(tab), tab0: tab(0), fcr: mods.find((x) => x[1][0] === 'cast1')[1][4],
        emptyDesc: mods.filter((x) => !x[1][4] || x[1][4].toLowerCase() === String(x[1][0]).toLowerCase()).map((x) => x[1][0]),
        statue: ['ua1', 'ua2', 'ua3', 'ua4', 'ua5'].map((c) => (Dm.items[c] || {}).n), statueSearch: search('talic'),
        areaName: Dm.levels['39'].name, mon: Dm.monsters.izual.n,
        range: [Em.describe('+#% Faster Cast Rate', 10, 20), Em.describe('+# to Strength', 5, 5), Em.describe('Requirements +#%', -20, -10), Em.describe('Level # Fire Bolt (#/# Charges)', 1, 5)],
        statList: Em.statList(['ci0'], 'magic').filter((x) => /Faster Cast|Warlock|Cold Skills/.test(x.key)).map((x) => x.text),
      };
    }
    // LoD Hell act bosses vs the independent reference on the base tables
    res.lod = { cases: {} };
    { const ctxL = (pl) => EL.getCtx({ players: pl, party: 1, ladder: true, tz: false, mf: 0 });
      for (const [name, ranks] of [['Andariel', ['boss']], ['Mephisto', ['boss']], ['The Countess', ['super']], ['Baal', ['boss']]]) {
        for (const mf of [0, 300]) {
          const ctx = ctxL(1);
          const s = EL.sources(ctx).find((x) => x.name === name && x.diff === 2 && ranks.indexOf(x.rank) >= 0);
          if (!s) throw new Error('LoD source missing: ' + name + ' ' + EL.sources(ctx).filter((x) => x.diff === 2 && /Andariel|Mephisto|Countess|Baal/.test(x.name)).map((x) => x.name + '/' + x.rank).join()); 
          res.lod.cases[[name, 'H', 'mf' + mf, 'p1'].join('|')] = { mlvl: s.mlvl, tc: s.tc, N: ctx.N, totals: EL.qualityTotals(ctx, s, mf) };
        }
      }
      const ctx = ctxL(1), s = EL.sources(ctx).find((x) => x.name === 'Andariel' && x.diff === 2 && x.rank === 'boss');
      res.lod.hcAndariel = EL.chanceFor(ctx, s, { kind: 'unique', id: 'Harlequin Crest' }, 0).target;
      const ctxR = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0 }), sR = E.sources(ctxR).find((x) => x.name === 'Andariel' && x.diff === 2 && x.rank === 'boss');
      res.lod.hcAndarielRotw = E.chanceFor(ctxR, sR, { kind: 'unique', id: 'Harlequin Crest' }, 0).target; }
    // terror zone act boss levels: max(own, min(clvl + 2, cap) + 3), Radament / Griswold / Nihlathak +3 more (can pass 99); outside a terror zone their own level
    { const lv = (tz, clvl, mon) => { const s = E.sources(E.getCtx({ players: 1, party: 1, ladder: true, tz, clvl, mf: 0 })).find((x) => x.rank === 'boss' && x.mon === mon && x.diff === 2); return s && s.mlvl; };
      res.tzBoss = { and88: lv(true, 88, 'andariel'), and99: lv(true, 99, 'andariel'), and0: lv(false, 88, 'andariel'), dia85: lv(true, 85, 'diablo'), dia99: lv(true, 99, 'diablo'), baal99: lv(true, 99, 'baalcrab'),
        nih99: lv(true, 99, 'nihlathakboss'), nih0: lv(false, 99, 'nihlathakboss'), rad95: lv(true, 95, 'radament'), sum99: lv(true, 99, 'summoner') }; }
    // ladder season gating (CONFIG.currentSeason): RotW season-15 uniques are ladder-only, the Angelic set too (15-16), Sunders (2-2) open to non-ladder; LoD has no gating
    { const hell = (Em, ladder) => { const ctx = Em.getCtx({ players: 1, party: 1, ladder, tz: false, mf: 0 }); return [ctx, Em.sources(ctx).find((x) => x.name === 'Andariel' && x.diff === 2 && x.rank === 'boss')]; };
      const p = (Em, ladder, tg) => { const [ctx, s] = hell(Em, ladder); return Em.chanceFor(ctx, s, tg, 0).target; };
      const bane = { kind: 'unique', id: 'Bane Ash' }, halo = { kind: 'set', id: 'Angelic Halo' };
      res.ladder = { season: E.CONFIG.currentSeason, baneL: p(E, true, bane), baneNL: p(E, false, bane), haloL: p(E, true, halo), haloNL: p(E, false, halo), baneLodNL: p(EL, false, bane),
        sunderNL: E.eligibleUniques('cm3', 99, false, 99, 2).filter((u) => E.isSunder(u.id)).length, sunderL: E.eligibleUniques('cm3', 99, true, 99, 2).filter((u) => E.isSunder(u.id)).length }; }

    // ---- heralds ---------------------------------------------------------------------------------
    res.herald = { tiers: {}, sunder: {}, flame: {}, statue: {} };
    const HERALD_RE = / Herald [ABC]$/;
    const heraldSrc = (ctx) => E.sources(ctx).find((s) => s.rank === 'herald' && s.mon === 'zombie1' && s.areaName === 'Blood Moor' && s.diff === 2);
    for (const clvl of [60, 94]) {
      for (const tier of [1, 5]) {
        const ctx = E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl, tier, mf: 0 });
        const hs = heraldSrc(ctx);
        res.herald.tiers['c' + clvl + 't' + tier] = { mlvl: hs.mlvl, tc: hs.tc, boost: hs.tcBoost, resolved: E.upgradeTC(hs.tc, hs.mlvl + hs.tcBoost, false, HERALD_RE), ungated: E.upgradeTC(hs.tc, hs.mlvl + hs.tcBoost, false) };
      }
    }
    // a herald whose mlvl + tier boost lands on 92 (the Ancient Statue TCs share group 41 at that level) must stay in the Herald TCs
    for (let clvl = 40; clvl <= 99 && !res.herald.statue.found; clvl++) for (let tier = 1; tier <= 5; tier++) {
      const ctx = E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl, tier, mf: 0 });
      const hs = heraldSrc(ctx);
      if (hs && hs.mlvl + hs.tcBoost === 92) {
        const codes = []; for (const [k] of E.srcDist(ctx, hs)) { const m = E.metaCache.get(k); if (m.kind === 'i' && /^ua\d$/.test(m.id)) codes.push(m.id); }
        res.herald.statue = { found: true, clvl, tier, ungated: E.upgradeTC(hs.tc, 92, false), uaLeaves: codes.length, leaves: E.srcDist(ctx, hs).size };
        break;
      }
    }
    for (const [pl, pa] of [[1, 1], [3, 1], [8, 8], [5, 2]]) {
      const ctx = E.getCtx({ players: pl, party: pa, ladder: true, tz: true, clvl: 85, tier: 3, mf: 0 });
      const hs = heraldSrc(ctx);
      res.herald.sunder[pl + '/' + pa] = { N: ctx.N, p: E.sunderChance(ctx, hs), tc: hs.tc };
    }
    // PreCrafted Flame Rift per herald kill by tier (published: 1:342.8 tier 1-2, 1:228.7 tier 3-4, 1:171.7 tier 5), with and without the 6-item cap
    for (const cap of [null, 6]) {
      E.CONFIG.dropCap = cap;
      const row = {};
      for (const tier of [1, 2, 3, 4, 5]) {
        const ctx = E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier, mf: 0 });
        const hs = heraldSrc(ctx);
        const sp = E.sunderPaths(ctx, hs, 'PreCrafted Flame Rift', 0);
        row[tier] = { table: sp.table, mf: sp.mf, total: sp.total, explicit: E.chanceFor(ctx, hs, { kind: 'unique', id: 'PreCrafted Flame Rift' }, 0).explicit };
      }
      res.herald.flame[cap === null ? 'off' : 'cap'] = row;
    }
    E.CONFIG.dropCap = null;
    // herald only exists in rotw + TZ
    { res.herald.inLod = res.modes.lod.heraldSources;
      const c2 = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, clvl: 85, tier: 1, mf: 0 }); res.herald.noTz = E.sources(c2).filter((s) => s.rank === 'herald').length;
      const c3 = E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: 1, mf: 0 }); const hsAll = E.sources(c3).filter((s) => s.rank === 'herald'); res.herald.count = hsAll.length;
      res.herald.badTC = hsAll.filter((s) => !/^Act \d \(H\) Herald [ABC]$/.test(s.tc)).length;
      res.herald.zombieMon = E.data.monsters.zombie1.tc[2].hr; }
    // ---- Sunder paths ------------------------------------------------------------------------------
    res.sunderPaths = { table: {}, mf: {}, adj: {} };
    const hsrc = (tier, pl, pa, clvl) => { const ctx = E.getCtx({ players: pl || 1, party: pa || 1, ladder: true, tz: true, clvl: clvl || 85, tier, mf: 0 });
      return [ctx, heraldSrc(ctx)]; };
    for (const pl of [1, 3, 8]) { const [ctx, hs] = hsrc(5, pl, 1); const sp = E.sunderPaths(ctx, hs, null, 0); res.sunderPaths.table[pl] = { table: sp.table }; }
    { const [ctx, hs] = hsrc(1); const sp = E.sunderPaths(ctx, hs, 'PreCrafted Cold Rupture', 0); res.sunderPaths.coldShare = { table: sp.table, any: E.sunderPaths(ctx, hs, null, 0).table }; }
    // MF path (PreCrafted Sunders are spawnable cm3 uniques with DropConditionCalc Hell)
    const cm3f = [983, 983, 983, 1024];
    const mfCount = (mlvl, diff) => { const q = E.quality('cm3', mlvl, 0, cm3f, true, diff); const sun = q.uniques.filter((x) => E.isSunder(x.u.id)); return { n: sun.length, p: sun.reduce((a, x) => a + x.p, 0), byId: Object.fromEntries(sun.map((x) => [x.u.id, x.p])) }; };
    res.sunderPaths.mf = { m74h: mfCount(74, 2), m75h: mfCount(75, 2), m87h: mfCount(87, 2), m87n: mfCount(87, 1), m87nm0: mfCount(87, 0), m99h: mfCount(99, 2), nonSunderUniques87: E.quality('cm3', 87, 0, cm3f, true, 2).uniques.filter((x) => !E.isSunder(x.u.id)).map((x) => x.u.id) };
    { const ctx = ctxFor(1, 1); const hell = E.sources(ctx).filter((s) => s.diff === 2 && !s.tz);
      const lowS = hell.find((s) => s.rank === 'regular' && s.mlvl < 75); const hiS = hell.find((s) => s.name === 'Mephisto' && s.rank === 'boss');
      const tg = { kind: 'unique', id: 'PreCrafted Cold Rupture' };
      res.sunderPaths.src = { lowMlvl: lowS.mlvl, low: E.chanceFor(ctx, lowS, tg, 0).mf, hiMlvl: hiS.mlvl, hi: E.chanceFor(ctx, hiS, tg, 0).mf, hiMf300: E.chanceFor(ctx, hiS, tg, 300).mf,
        hiTable: E.chanceFor(ctx, hiS, tg, 0).explicit };
      const nmS = E.sources(ctx).filter((s) => s.diff === 1 && s.mlvl >= 75); res.sunderPaths.src.nmHigh = nmS.length;
      res.sunderPaths.src.nmMf = nmS.length ? E.chanceFor(ctx, nmS[0], tg, 0).mf : 0; }
    // ---- table-driven explicit drops: statue pieces, shards, keys, Uber Ancients, Ars grimoires ----------------------------------------
    res.drops = { idx: {}, src: {}, ars: {}, ubers: {} };
    { const idx = E.searchIndex();
      for (const c of ['pk1', 'pk2', 'pk3', 'ua1', 'ua2', 'ua3', 'ua4', 'ua5', 'xa1', 'xa5']) res.drops.idx[c] = idx.some((x) => x.kind === 'base' && x.code === c);
      const ctx = ctxFor(1, 1);
      const top = (s) => E.upgradeTC(s.tc, s.mlvl + (s.tcBoost || 0), s.boss && !s.tz);
      const one = (name, rank, code, act) => {
        const s = E.sources(ctx).find((x) => x.name === name && x.diff === 2 && x.rank === rank && !x.tz && (!act || x.act === act));
        if (!s) return null;
        const r = { tc: top(s), mlvl: s.mlvl, area: s.areaName };
        for (const cap of [null, 6]) { E.CONFIG.dropCap = cap; r[cap === null ? 'off' : 'cap'] = E.chanceFor(ctx, s, { kind: 'base', code }, 0).target; }
        E.CONFIG.dropCap = null;
        return r;
      };
      for (const [nm, codes] of [['Andariel', ['ua1', 'ua2', 'ua3']], ['Duriel', ['ua1', 'ua2', 'ua3', 'ua4', 'ua5']], ['Mephisto', ['ua1', 'ua2', 'ua3', 'ua4', 'ua5']], ['Diablo', ['ua1', 'ua2', 'ua3', 'ua4', 'ua5']], ['Baal', ['ua1', 'ua2', 'ua3', 'ua4', 'ua5']]])
        for (const c of codes) res.drops.src[nm + '|' + c] = one(nm, 'boss', c);
      res.drops.src['The Countess|pk1'] = one('The Countess', 'super', 'pk1');
      res.drops.src['The Summoner|pk2'] = one('The Summoner', 'boss', 'pk2');
      res.drops.src['Nihlathak|pk3'] = one('Nihlathak', 'boss', 'pk3');
      // quest-type items have no quality: all of their chance is P(base), none of it magic (pk2 from Hell Summoner); a normal magic-capable item (cm3 grand charm, small charm) is unaffected
      { const s = E.sources(ctx).find((x) => x.name === 'The Summoner' && x.diff === 2 && x.rank === 'boss' && !x.tz);
        const c = E.chanceFor(ctx, s, { kind: 'base', code: 'pk2' }, 0);
        const qn = E.quality('pk2', s.mlvl, 0, [0, 0, 0, 1024], true, 2), qj = E.quality('jew', s.mlvl, 0, [0, 0, 0, 1024], true, 2);
        const tot = E.qualityTotals(ctx, s, 0);
        res.drops.nq = { base: c.base, target: c.target, magic: c.magic, rare: c.rare, set: c.set, unique: c.unique, normal: c.normal, low: c.low, hq: c.hq, qsum: qn.magic + qn.rare + qn.set + qn.unique + qn.hq + qn.normal + qn.low,
          jewMagic: qj.magic, jewSum: qj.magic + qj.rare + qj.set + qj.unique + qj.hq + qj.normal + qj.low, totalsItems: tot.items }; }
      // Hell champion in act 1 -> Western Worldstone Shard (first champion row whose TC can drop it)
      { const cs = E.sources(ctx).filter((x) => x.diff === 2 && x.rank === 'champion' && x.act === 1 && !x.tz);
        let hit = null; for (const s of cs) { const p = E.chanceFor(ctx, s, { kind: 'base', code: 'xa1' }, 0).target; if (p > 0) { hit = [s, p]; break; } }
        res.drops.src['champion|xa1'] = hit ? { tc: top(hit[0]), mlvl: hit[0].mlvl, area: hit[0].areaName, mon: hit[0].name, off: hit[1], n: cs.length } : null;
        // how many distinct source kinds drop xa1 at all
        const kinds = {}; for (const s of E.sources(ctx).concat(E.sources(E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: 5, mf: 0 })))) if (s.diff === 2 && E.chanceFor(ctx, s, { kind: 'base', code: 'xa1' }, 0).target > 0) kinds[s.rank + (s.tz ? '/tz' : '')] = 1;
        res.drops.xa1Ranks = Object.keys(kinds).sort(); }
      res.drops.herald = {};
      for (const tier of [1, 5]) { const cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier, mf: 0 }); const hs = E.sources(cx).find((x) => x.rank === 'herald' && x.mon === 'zombie1' && x.areaName === 'Blood Moor' && x.diff === 2);
        res.drops.herald[tier] = { tc: hs.tc, tcName: E.upgradeTC(hs.tc, hs.mlvl + hs.tcBoost, false, / Herald [ABC]$/), p: ['xa1', 'xa2', 'xa3', 'xa4', 'xa5'].map((c) => E.chanceFor(cx, hs, { kind: 'base', code: c }, 0).target) }; }
      // Ars grimoires (unique waf/wae/wac): all sources at 0 MF, 1 player
      for (const id of ["Ars Al'Diablolos", "Ars Tor'Baalos", "Ars Dul'Mephistos"]) {
        const rows = [];
        for (const tzOn of [false, true]) {
          const cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: tzOn, clvl: 85, tier: 5, mf: 0 });
          for (const s of E.sources(cx)) { const p = E.chanceFor(cx, s, { kind: 'unique', id }, 0).target; if (p > 0) rows.push([s.name, s.areaName, s.rank, s.diff, !!s.tz, p, s.tier || 0]); }
        }
        rows.sort((a, b) => b[5] - a[5]);
        res.drops.ars[id] = { n: rows.length, top: rows.slice(0, 5), topNoTz: rows.filter((x) => !x[4]).slice(0, 5), inIndex: idx.some((x) => x.kind === 'unique' && x.id === id) };
      }
      // Uber Ancients: six explicit uniques, expect 50% each per kill (before the cap)
      for (const [nm, mon, ids] of [['Uber Talic', 'colossal1', ["Defender's Bile", "Defender's Fire"]], ['Uber Madawc', 'colossal2', ["Guardian's Light", "Guardian's Thunder"]], ['Uber Korlic', 'colossal3', ["Protector's Stone", "Protector's Frost"]]]) {
        const rowsN = E.sources(ctx).filter((x) => x.mon === mon);   // by monster id (the display names are the strings' Talic / Madawc / Korlic)
        const s = rowsN.find((x) => x.diff === 2);
        const r = { rows: rowsN.length, diffs: rowsN.map((x) => x.diff), mlvl: s ? s.mlvl : null, area: s ? s.areaName : null, act: s ? s.act : null, ps: {}, idx: {} };
        for (const id of ids) { r.ps[id] = s ? E.chanceFor(ctx, s, { kind: 'unique', id }, 0).target : 0; r.idx[id] = idx.some((x) => x.kind === 'unique' && x.id === id); }
        res.drops.ubers[nm] = r;
      }
    }
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
    // per-run model: engine areaRun for a spread of areas (independent Python reference in test_engine.py), and sources() perRun == areaRun
    { const ctx = ctxFor(1, 1); const S = E.sources(ctx); const run = {};
      for (const [lid, d] of [[8, 0], [2, 0], [3, 2], [12, 2], [39, 2], [66, 2], [74, 1], [107, 2], [111, 2], [113, 2], [116, 2], [119, 2], [122, 2], [126, 2], [128, 2], [133, 2], [28, 2], [102, 2], [106, 2], [110, 0], [110, 2], [121, 2], [124, 2]]) {
        const r = E.areaRun(String(lid), d), kills = {}, share = {};
        for (const [id, k] of r.kills) kills[id] = k; for (const [id, x] of r.share) share[id] = x;
        let srcSum = 0, runSum = 0; for (const x of S) if (x.area === lid && x.diff === d && x.rank !== 'super' && x.rank !== 'boss' && x.rank !== 'herald') srcSum += x.perRun - (x.suMin || 0);
        for (const k of r.kills.values()) for (const rk in k) runSum += k[rk];
        run[lid + '|' + d] = { kills, share, packs: r.packs, bosses: r.bosses, rolls: r.rolls, rooms: r.rooms, srcSum, runSum }; }
      res.cap.run = run; }
    { E.CONFIG.dropCap = 6; const ctx = ctxFor(1, 1); const S = E.sources(ctx); const f1 = (n, d) => S.find((s) => s.name === n && s.diff === d && s.rank === 'super');
      const rak = f1('Rakanishu', 0), rad = S.find((s) => s.name === 'Radament' && s.diff === 2);
      res.cap.su = { pind: f1('Pindleskin', 2).mlvl, countess: f1('The Countess', 2).mlvl, rak: rak.mlvl, cow: S.find((s) => s.name === 'The Cow King' && s.diff === 0).mlvl,
        bane: E.chanceFor(ctx, rak, { kind: 'unique', id: 'Bane Ash' }, 0).target, radament: rad.mlvl, radamentBase: data.monsters.radament.lv[2] }; }
    // super unique area mapping (SU_AREA fixes)
    { const ctx = ctxFor(1, 1); const S = E.sources(ctx).filter((s) => s.rank === 'super');
      const row = (id, d) => { const s = S.find((x) => x.key === 'su|' + id + '|' + d);   // by super unique id (display names come from the string tables)
        return s ? { area: s.areaName, id: s.area, mlvl: s.mlvl, expect: data.levels[String(s.area)].lvl[d] + 3 } : null; };
      res.cap.suMap = { shenk: row('Siege Boss', 2), eldritch: row('Megaflow Rectifier', 2), thresh: row('Threash Socket', 2), colenzo: row('Baal Subject 1', 2),
        lister: row('Baal Subject 5', 1), bremm: row('Bremm Sparkfist', 2),
        unused: ['Winged Death', 'The Tormentor', 'Taintbreeder', 'Riftwraith the Cannibal', 'Axe Dweller', 'Anodized Elite', 'Vinvear Molech', 'Magma Torquer', 'Blaze Ripper', 'Flamespike the Crawler'].filter((n) => S.some((x) => x.key.indexOf('su|' + n + '|') === 0)) }; }
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
    res.mfThresh = Object.fromEntries([0, 10, 11, 100, 110, 111, 200].map((mf) => [mf, E.quality('scp', 31, mf, [850, 983, 983, 1024], true, 0).unique]));
    { const ctx = ctxFor(1, 1), tg = { kind: 'base', code: 'utp' }, hell = E.sources(ctx).filter((s) => s.diff === 2);
      const pick = (rank, boss) => { for (const s of hell) { if (s.rank !== rank) continue; const c = E.chanceFor(ctx, s, tg, 0); if (c.base > 0) return { name: s.name, c }; } return null; };
      res.baseQuality = { baal: E.chanceFor(ctx, find(ctx, 'Baal', 2, ['boss']), tg, 0), regular: pick('regular'), champion: pick('champion') };
      // no qlvl <= mlvl filter on generic TCs: Hell Bovine (mlvl 81, regular) can drop Archon Plate (utp, qlvl 84); quality at diff -3 with zero TC factors
      const bs = E.sources(ctxFor(1, 1)).find((s) => s.name === 'Hell Bovine' && s.diff === 2 && s.rank === 'regular');
      res.bovine = bs ? { mlvl: bs.mlvl, c: E.chanceFor(ctx, bs, tg, 0), q: E.quality('utp', 81, 0, [0, 0, 0, 0], true, 2) } : null; }
    // ---- item generation rules: staff mods, magic exact odds, rare Monte Carlo (reference: test_engine.py, independent re-implementation of D2MOO)
    res.rules = { staff: [], magic: [], rare: [], lodNoStaff: null, cfg: JSON.parse(JSON.stringify(E.CONFIG.staffMods)) };
    {
      const FIRE = 'Fire Resist +#%', MANA = 'Cold Resist +#%';   // (MANA = the second condition: cold resist)
      const skey = (D, cls, idx) => D.staff[cls][idx].k;
      const alv = (Eg, code, il) => Eg.affixLevel(il, Eg.items[code]);
      for (const [code, cls, idx, mn, il] of [['wnd', 'nec', 12, 1, 20], ['wnd', 'nec', 12, 2, 50], ['wnd', 'nec', 7, 1, 20], ['ob5', 'sor', 14, 1, 20], ['ob5', 'sor', 14, 3, 50],
                                               ['dgr', 'war', 16, 1, 20], ['dgr', 'war', 18, 2, 50], ['wa1', 'war', 14, 1, 20], ['wa1', 'war', 16, 1, 50]]) {
        const k = skey(data, cls, idx), al = alv(E, code, il), o = { ilvl: il, rolls: 60000 };
        const sc = { key: k, min: mn }, fc = { key: FIRE, min: 10 };
        res.rules.staff.push({ code, cls, idx, min: mn, ilvl: il, key: k,
          magicStaff: E.affixProb(code, al, 'magic', [sc], o), magicBoth: E.affixProb(code, al, 'magic', [sc, fc], o), magicFire: E.affixProb(code, al, 'magic', [fc], o),
          rareStaff: E.affixProb(code, al, 'rare', [sc], o), rareBoth: E.affixProb(code, al, 'rare', [sc, fc], o), rareFire: E.affixProb(code, al, 'rare', [fc], o),
          inList: E.statList([code], 'magic').some((x) => x.key === k) });
      }
      // LoD: the same wand rolls the same staff mods; a knife has none (StaffMods 'war' is RotW only), and the Warlock list is absent
      { const k = skey(dataL, 'nec', 12), al = alv(EL, 'wnd', 20);
        res.rules.lodNoStaff = { wand: EL.affixProb('wnd', al, 'magic', [{ key: k, min: 1 }], { ilvl: 20 }), wandRotw: E.affixProb('wnd', al, 'magic', [{ key: k, min: 1 }], { ilvl: 20 }),
          knifeSm: dataL.types.knif.sm, knifeSmRotw: data.types.knif.sm, warStaff: !!dataL.staff.war, listed: EL.statList(['dgr'], 'magic').filter((x) => /Warlock/.test(x.key) && /Hex/.test(x.key)).length,
          listedRotw: E.statList(['dgr'], 'magic').filter((x) => /Hex/.test(x.key)).length }; }
      // magic exact odds, affix conditions only (no staff mods): several bases / item levels, one and two conditions
      for (const [code, il] of [['wnd', 20], ['wnd', 70], ['ob5', 45], ['cap', 60], ['amu', 80], ['wa5', 55], ['dgr', 30], ['jew', 50], ['gwn', 33]]) {
        const al = alv(E, code, il);
        res.rules.magic.push({ code, ilvl: il, alvl: al, one: E.affixProb(code, al, 'magic', [{ key: FIRE, min: 10 }], { ilvl: il }),
          two: E.affixProb(code, al, 'magic', [{ key: FIRE, min: 10 }, { key: MANA, min: 10 }], { ilvl: il }) });
      }
      // rare: engine Monte Carlo of the game's affix loop (one armor, one jewel, one orb with automagic)
      for (const [code, il] of [['cap', 60], ['jew', 60], ['ob5', 60]]) {
        const al = alv(E, code, il);
        res.rules.rare.push({ code, ilvl: il, alvl: al, one: E.affixProb(code, al, 'rare', [{ key: FIRE, min: 10 }], { ilvl: il, rolls: 200000 }),
          two: E.affixProb(code, al, 'rare', [{ key: FIRE, min: 10 }, { key: MANA, min: 10 }], { ilvl: il, rolls: 200000 }) });
      }
    }
    // ---- socket affixes (Mechanist's / Artificer's / Jeweler's): chance of >= N sockets by quality, base and item level
    res.rules.sock = [];
    {
      const SK = 'Socketed (#)';
      for (const [code, q, il, mn] of [['uit', 'magic', 80, 4], ['uit', 'magic', 80, 3], ['uit', 'magic', 60, 4], ['uit', 'magic', 60, 1], ['uit', 'magic', 60, 2], ['uit', 'magic', 40, 4], ['uit', 'rare', 80, 4], ['uit', 'rare', 60, 4], ['uit', 'rare', 60, 1], ['uit', 'rare', 60, 2],
                                       ['cap', 'magic', 60, 2], ['cap', 'magic', 60, 3], ['cap', 'rare', 60, 2], ['ssd', 'magic', 60, 2],
                                       ['ci0', 'magic', 20, 2], ['ci0', 'magic', 30, 2], ['ci0', 'rare', 20, 2], ['ci0', 'rare', 30, 2], ['gth', 'magic', 20, 3], ['gth', 'magic', 75, 4],
                                       ['rin', 'magic', 80, 1], ['amu', 'magic', 80, 1], ['rin', 'rare', 80, 1], ['jew', 'magic', 80, 1], ['jew', 'rare', 80, 1]]) {
        const al = E.affixLevel(il, E.items[code]);
        res.rules.sock.push({ code, q, ilvl: il, min: mn, p: E.affixProb(code, al, q, [{ key: SK, min: mn }], { ilvl: il, rolls: 200000 }),
          listed: E.statList([code], q).some((x) => x.key === SK), maxS: E.maxSockets(code, il) });
      }
    }

    // ---- item builder (types, per-affix odds, type aggregation, feasibility / levels; reference: test_engine.py) ------------------------
    res.builder = { types: {}, appear: [], rareFire: null, agg: [], combos: [], chromatic: null };
    {
      for (const t of ['boot', 'circ', 'ashd', 'wand']) res.builder.types[t] = E.builderBases(t, -1).sort();
      res.builder.tiers = { boot: [0, 1, 2].map((tr) => E.builderBases('boot', tr).length), amu: [E.builderBases('amul', 1).length, E.builderBases('amul', -1).length] };
      for (const [code, il] of [['lbt', 85], ['cap', 60], ['wnd', 20], ['ci0', 70], ['uit', 80]]) {
        const rows = E.builderAffixTable([code], il, { rolls: 20000 });
        res.builder.appear.push({ code, ilvl: il, rows: rows.filter((r) => ['prefix', 'suffix', 'auto'].indexOf(r.side) >= 0).map((r) => [r.side, r.lvl, r.mods.map((m) => [m.min, m.max]), r.magic, r.rareP, r.nOn, r.id]) });
      }
      { const rows = E.builderAffixTable(['cap'], 60, { rolls: 200000 }); let p = 0;
        for (const r of rows) if (r.mods.some((m) => m.key === 'Fire Resist +#%')) p += r.rareP;
        res.builder.rareFire = p; }
      // odds weighting: plain average vs weighted by the drop rate of each base in an area (boots, Hell, Chaos Sanctuary) and for one monster
      { const ctx = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0, clvl: 85, tier: 1 }), boots = E.builderBases('boot', -1).sort();
        const srcs = E.sources(ctx).filter((x) => x.diff === 2 && /Chaos Sanctuary/.test(x.areaName));
        const area = srcs[0].area, w = E.baseDropWeights(ctx, boots, { diff: 2, area });
        const w1 = E.baseDropWeights(ctx, boots, { srcKey: srcs[0].key });
        // independent weights through chanceFor: sum over the area's sources of perRun * P(base)
        const raw = boots.map((c) => srcs.reduce((t, x) => t + x.perRun * E.chanceFor(ctx, x, { kind: 'base', code: c }, 0).base, 0)), rt = raw.reduce((a, b) => a + b, 0);
        const rowsOf = (o) => E.builderAffixTable(boots, 85, Object.assign({ rare: false }, o)).filter((r) => ['prefix', 'suffix', 'auto'].indexOf(r.side) >= 0).map((r) => [r.side, r.lvl, r.mods.length, r.magic]);
        res.builder.weights = { boots, il: 85, w: boots.map((c) => w.get(c) || 0), w1: boots.map((c) => w1.get(c) || 0), wChance: boots.map((c, i) => raw[i] / rt), n: w.nSources,
          srcName: srcs[0].name, equal: rowsOf({}), weighted: rowsOf({ weights: w }), one: rowsOf({ weights: w1 }),
          none: E.builderAffixTable(boots, 85, { rare: false, weights: new Map() }).filter((r) => ['prefix', 'suffix', 'auto'].indexOf(r.side) >= 0).map((r) => r.magic), pbOk: (() => { const r = E.builderAffixTable(boots, 85, { rolls: 2000 })[5]; return r.pb.m.length === boots.length && Math.abs(r.pb.m.reduce((a, b) => a + b, 0) / boots.length - r.magic) < 1e-12; })() };
      }
      // type aggregation: affixSearch over all boots == sum of the single-base searches (magic exact and rare with the same seeds); prune does not change a result
      { const ctx = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0, clvl: 85, tier: 1 });
        const boots = E.builderBases('boot', -1), FRW = '+#% Faster Run/Walk';
        for (const [q, conds] of [['magic', [{ key: FRW, min: 20 }]], ['magic', [{ key: FRW, min: 20 }, { key: 'Fire Resist +#%', min: 30 }]], ['rare', [{ key: FRW, min: 20 }, { key: 'Fire Resist +#%', min: 30 }]]]) {
          const o = { quality: q, conds, mf: 0, diff: 2, act: 1, area: 0, rolls: 6000, byBase: true };
          const all = E.affixSearch(ctx, Object.assign({ codes: boots }, o), null), pr = E.affixSearch(ctx, Object.assign({ codes: boots, prune: true }, o), null);
          const sum = new Map();
          for (const c of boots) for (const r of E.affixSearch(ctx, Object.assign({ codes: [c] }, o), null).rows) sum.set(r.src.key, (sum.get(r.src.key) || 0) + r.pTotal);
          const pm = new Map(pr.rows.map((r) => [r.src.key, r.pTotal]));
          let maxRel = 0, maxRelPrune = 0, maxBB = 0;
          for (const r of all.rows) {
            maxRel = Math.max(maxRel, Math.abs(r.pTotal - (sum.get(r.src.key) || 0)) / r.pTotal);
            maxRelPrune = Math.max(maxRelPrune, Math.abs(r.pTotal - (pm.get(r.src.key) || 0)) / r.pTotal);
            let bb = 0; for (const c in r.byBase) bb += r.byBase[c];
            maxBB = Math.max(maxBB, Math.abs(bb - r.pTotal) / r.pTotal);
          }
          res.builder.agg.push({ q, nc: conds.length, rows: all.rows.length, sumRows: sum.size, maxRel, maxRelPrune, maxBB });
        }
      }
      // feasibility and levels per base
      const K = { frw: '+#% Faster Run/Walk', fire: 'Fire Resist +#%', cold: 'Cold Resist +#%', ed: '+#% Enhanced Defense', sock: 'Socketed (#)', all: 'All Resistances +#', fcr: '+#% Faster Cast Rate' };
      const amp = data.staff.nec[2].k;   // tier 1 skill of the necromancer list
      res.builder.staffKey = amp;
      const specs = [
        ['boots FRW20 + fire30', E.builderBases('boot', -1), [[K.frw, 20], [K.fire, 30]]],
        ['boots ED30 + cold20 + fire20 (3 prefixes)', E.builderBases('boot', -1), [[K.ed, 30], [K.cold, 20], [K.fire, 20]]],
        ['boots fire30 + cold20 (2 prefixes)', E.builderBases('boot', -1), [[K.fire, 30], [K.cold, 20]]],
        ['monarch sockets 4', ['uit'], [[K.sock, 4]]],
        ['circlet FCR 20', E.builderBases('circ', -1), [[K.fcr, 20]]],
        ['wand staff +3 tier1 skill', E.builderBases('wand', -1), [[amp, 3]]],
        ['wand staff +3 + fire10', E.builderBases('wand', -1), [[amp, 3], [K.fire, 10]]],
        ['auric shields all res 35', E.builderBases('ashd', -1), [[K.all, 35]]],
      ];
      for (const [name, codes, cs] of specs) {
        const conds = cs.map(([key, min]) => ({ key, min }));
        const out = { name, conds: cs, per: {} };
        for (const q of ['magic', 'rare']) out.per[q] = codes.map((c) => { const r = E.comboForBase(c, conds, q); return [c, r.ok, r.minIl, r.maxIl, r.reqLv]; });
        const an = E.comboAnalysis(codes, conds);
        out.an = { magic: an.magic.ok, rare: an.rare.ok, why: { magic: an.magic.why, rare: an.rare.why } };
        res.builder.combos.push(out);
      }
      res.builder.chromatic = { magic: E.eligible('pa5', 99, false).auto.filter((a) => a.n === 'Chromatic').length, rare: E.eligible('pa5', 99, true).auto.filter((a) => a.n === 'Chromatic').length };
      // lower-is-better direction: "Requirements +#%" <= -20 vs >= -20
      res.builder.le = { statLe: E.builderStats(E.builderBases('boot', -1)).filter((s) => s.le).map((s) => s.key),
        reqLe: E.condProb({ mods: [['x', '', -30, -30, 'R']] }, { key: 'R', min: -20, le: true }), reqGe: E.condProb({ mods: [['x', '', -30, -30, 'R']] }, { key: 'R', min: -20 }) };
      // labels with several numbers: per-row tooltip text, merged text of a type, poison / damage threshold odds, slider ranges
      { const POIS = 'Adds #-# poison damage over # seconds', FIRE = 'Adds #-# fire damage';
        const L = res.builder.labels = { text: {}, left: [], pois: [], fire: [], sl: {}, nodata: 0 };
        for (const [mode, Em] of [['rotw', E], ['lod', EL]]) {
          const rowsOf = (code, re) => Array.from(Em.builderCatalog([code], 99).values()).map((r) => r.mods.filter((m) => re.test(m.key)).map((m) => [r.name, r.side, Em.describe(m.key, m.min, m.max, m.v)])).reduce((x, y) => x.concat(y), []);
          L.text[mode] = { pois: rowsOf('cm1', /poison damage over/), charged: rowsOf('sst', /Charges\)/), proc: rowsOf('cap', /Chance to cast/), fire: rowsOf('dgr', /fire damage/), cold: rowsOf('dgr', /cold damage/), magic: Em.items.wa1 ? rowsOf('wa1', /magic damage/) : [], hit: rowsOf('lsd', /on striking/), att: rowsOf('lsd', /on attack/) };
        }
        for (const t of E.builderTypes()) for (const x of E.builderStats(t.codes)) if (x.text.indexOf('#') >= 0 && x.key.split('#').length > 2) L.left.push([t.code, x.key, x.text]);
        const al = E.affixLevel(99, E.items.cm1);
        for (const min of [1, 6, 7, 15, 16, 25, 26, 50, 51, 100, 101, 175, 176]) L.pois.push([min, E.affixProb('cm1', al, 'magic', [{ key: POIS, min }], { ilvl: 99 })]);
        for (const min of [1, 2, 3]) L.fire.push([min, E.affixProb('dgr', E.affixLevel(3, E.items.dgr), 'magic', [{ key: FIRE, min }], { ilvl: 3 })]);
        const bs = new Map(E.builderStats(['cm1']).map((x) => [x.key, x]));
        L.sl = { pois: [bs.get(POIS).min, bs.get(POIS).max, bs.get(POIS).text, bs.get(POIS).what], at: E.describeAt(POIS, 50, bs.get(POIS).v), atAll: E.describeAt(POIS, 50), atFire: E.describeAt(FIRE, 5), what: [E.sliderWhat('Level # Teleport (#/# Charges)'), E.sliderWhat('#% Chance to cast level # Nova on striking')] };
        { const AR = '+# to Attack Rating', MX = '+# to Maximum Damage', LF = '+# to Life', cs = [{ key: AR, min: 1 }, { key: MX, min: 1 }, { key: LF, min: 1 }], o = { qualities: ['magic'], diff: 2 };
          const sr = (c, i) => { const r = E.statRange(['cm1'], c, i, o); return [r.min, r.max]; };
          L.range = { ar: sr(cs, 0), mx: sr(cs, 1), lf: sr(cs, 2), arAlone: sr([cs[0]], 0), arMx: sr([cs[0], cs[1]], 0), arLf: sr([cs[0], cs[2]], 0), cat: [bs.get(AR).min, bs.get(AR).max], conflict: sr([{ key: AR, min: 1 }, { key: AR, min: 30 }, cs[1], cs[2]], 0) }; }
        L.nodata = E.describe('Level # Fire Bolt (#/# Charges)', 1, 5);
      }
    }
    // ---- low / normal / superior items: sockets, ethereal, superior bonus (CONFIG.nonMagic) ----
    res.white = { cases: [], facts: {} };
    { const W = res.white, SK = E.SOCK_KEY, ET = E.ETH_KEY, ED = '+#% Enhanced Defense', EDM = '+#% Enhanced Damage', AR = '+# to Attack Rating', DUR = 'Increase Maximum Durability #%';
      const kinds = { sock: SK, eth: ET, ed: ED, dm: EDM, ar: AR, dur: DUR };
      const add = (name, code, q, ilvl, diff, conds) => W.cases.push({ name, code, q, ilvl, diff, conds, p: E.affixProb(code, E.affixLevel(ilvl, E.items[code]), q, conds.map(([k, m]) => ({ key: kinds[k], min: m })), { ilvl, diff, rolls: 20000 }) });
      for (const m of [1, 2, 3, 4, 5]) add('Monarch normal ilvl 60 Hell sockets >= ' + m, 'uit', 'normal', 60, 2, [['sock', m]]);
      add('Monarch normal ilvl 85 Hell sockets >= 4', 'uit', 'normal', 85, 2, [['sock', 4]]);
      for (const m of [1, 3, 4]) add('Monarch normal ilvl 30 Hell sockets >= ' + m, 'uit', 'normal', 30, 2, [['sock', m]]);
      for (const m of [1, 4, 5]) add('Monarch normal ilvl 60 Nightmare sockets >= ' + m, 'uit', 'normal', 60, 1, [['sock', m]]);
      for (const m of [3, 4]) add('Monarch normal ilvl 85 Normal sockets >= ' + m, 'uit', 'normal', 85, 0, [['sock', m]]);
      add('Monarch superior ilvl 60 Hell sockets >= 4', 'uit', 'sup', 60, 2, [['sock', 4]]);
      add('Monarch low ilvl 60 Hell sockets >= 1', 'uit', 'low', 60, 2, [['sock', 1]]);
      for (const c of ['lbt', 'lgl', 'mbl', 'jav', 'tkf', 'amu', 'rin']) add(c + ' (no sockets possible) normal ilvl 85 Hell sockets >= 1', c, 'normal', 85, 2, [['sock', 1]]);
      add('Amazon bow am1 normal ilvl 85 Hell sockets >= 5', 'am1', 'normal', 85, 2, [['sock', 5]]);
      add('Monarch normal ilvl 60 Hell sockets >= 4 and ethereal', 'uit', 'normal', 60, 2, [['sock', 4], ['eth', 1]]);
      for (const q of ['low', 'normal', 'sup', 'magic', 'rare']) { add('Monarch ' + q + ' ethereal', 'uit', q, 85, 2, [['eth', 1]]); add('Short Bow sbw ' + q + ' ethereal', 'sbw', q, 85, 2, [['eth', 1]]); }
      for (const c of ['lxb', 'am1', '7cr', 'jav', 'amu', 'lsd', 'lbt']) add(c + ' normal ethereal', c, 'normal', 85, 2, [['eth', 1]]);
      const tpot = Object.keys(E.items).filter((c) => E.items[c].t === 'tpot' && E.items[c].sp)[0];
      if (tpot) add(tpot + ' (throwing potion) normal ethereal', tpot, 'normal', 85, 2, [['eth', 1]]);
      for (const [c, nm] of [['uit', 'Monarch (armor)'], ['lsd', 'Long Sword'], ['sbw', 'Short Bow'], ['7cr', 'Phase Blade'], ['jav', 'Javelin'], ['lbt', 'Boots']]) {
        add(nm + ' superior +% enhanced defense >= 1', c, 'sup', 70, 2, [['ed', 1]]);
        add(nm + ' superior +% enhanced damage >= 1', c, 'sup', 70, 2, [['dm', 1]]);
        add(nm + ' superior +# attack rating >= 1', c, 'sup', 70, 2, [['ar', 1]]);
        add(nm + ' superior max durability >= 10', c, 'sup', 70, 2, [['dur', 10]]);
      }
      add('Monarch superior enhanced defense >= 15', 'uit', 'sup', 70, 2, [['ed', 15]]);
      add('Monarch superior enhanced defense >= 10', 'uit', 'sup', 70, 2, [['ed', 10]]);
      add('Monarch superior enhanced defense >= 5 and durability >= 10', 'uit', 'sup', 70, 2, [['ed', 5], ['dur', 10]]);
      add('Long Sword superior attack rating >= 1 and enhanced damage >= 5', 'lsd', 'sup', 70, 2, [['ar', 1], ['dm', 5]]);
      add('Long Sword superior attack rating >= 3 and enhanced damage >= 15', 'lsd', 'sup', 70, 2, [['ar', 3], ['dm', 15]]);
      add('Short Bow superior attack rating >= 1 and enhanced damage >= 1', 'sbw', 'sup', 70, 2, [['ar', 1], ['dm', 1]]);
      add('Monarch superior ED >= 5, 4 sockets, ethereal', 'uit', 'sup', 70, 2, [['ed', 5], ['sock', 4], ['eth', 1]]);
      // automagic on non-magic items (Paladin shield group 304: Chromatic res-all 35-45 | Knight's +AR and +Enhanced Damage) and low-quality staff mods
      const RA = 'All Resistances +#', amp = data.staff.nec[20].k;
      for (const q of ['low', 'normal', 'sup']) {
        const al = E.affixLevel(85, E.items.pa5);
        W.cases.push({ name: 'pa5 ' + q + ' All Resistances >= 35 (automagic)', code: 'pa5', q, ilvl: 85, diff: 2, conds: [['auto', 'res-all', 35]], p: E.affixProb('pa5', al, q, [{ key: RA, min: 35 }], { ilvl: 85, diff: 2 }) });
        W.cases.push({ name: 'pa5 ' + q + " Knight's AR >= 110 and Enhanced Damage >= 55", code: 'pa5', q, ilvl: 85, diff: 2, conds: [['auto2', 'att', 110, 'dmg%', 55]], p: E.affixProb('pa5', al, q, [{ key: AR, min: 110 }, { key: EDM, min: 55 }], { ilvl: 85, diff: 2 }) });
      }
      W.cases.push({ name: 'pa5 superior ED >= 15 and All Resistances >= 35', code: 'pa5', q: 'sup', ilvl: 85, diff: 2, conds: [['ed', 15], ['auto', 'res-all', 35]], p: E.affixProb('pa5', E.affixLevel(85, E.items.pa5), 'sup', [{ key: ED, min: 15 }, { key: RA, min: 35 }], { ilvl: 85, diff: 2 }) });
      const wal = E.affixLevel(40, E.items.wnd);
      W.staffLow = { key: amp, ilvl: 40, idx: 20, one: E.affixProb('wnd', wal, 'low', [{ key: amp, min: 1 }], { ilvl: 40 }), two: E.affixProb('wnd', wal, 'low', [{ key: amp, min: 2 }], { ilvl: 40 }),
        magicOne: E.affixProb('wnd', wal, 'magic', [{ key: amp, min: 1 }], { ilvl: 40 }), magicTwo: E.affixProb('wnd', wal, 'magic', [{ key: amp, min: 2 }], { ilvl: 40 }), normalTwo: E.affixProb('wnd', wal, 'normal', [{ key: amp, min: 2 }], { ilvl: 40 }) };
      // per kill: the engine's search result for a source == P(base normal / superior) x the socket rule
      { const ctx = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0, clvl: 85, tier: 1 });
        const src = E.sources(ctx).find((s) => s.name === 'Hell Bovine' && s.diff === 2 && s.rank === 'regular');
        const c = E.chanceFor(ctx, src, { kind: 'base', code: 'uit' }, 0);
        const row = (q, conds) => { const r = E.affixSearch(ctx, { codes: ['uit'], quality: q, conds, mf: 0, diff: 2, act: src.act, area: src.area, srcKey: src.key, rolls: 1000 }, null).rows.find((x) => x.src.key === src.key); return r ? r.pTotal : 0; };
        W.perKill = { tc: src.tc, mlvl: src.mlvl, name: src.name, base: c.base, normal: c.normal, sup: c.hq, low: c.low, magic: c.magic, n4: row('normal', [{ key: SK, min: 4 }]), s4: row('sup', [{ key: SK, min: 4 }]),
          n4e: row('normal', [{ key: SK, min: 4 }, { key: ET, min: 1 }]), l1: row('low', [{ key: SK, min: 1 }]), me: row('magic', [{ key: ET, min: 1 }]) };
      }
      // levels / feasibility (structure)
      { const an = (codes, cs, o) => E.comboAnalysis(codes, cs.map(([k, m]) => ({ key: kinds[k] || k, min: m })), o);
        const pickOk = (r) => Object.fromEntries(E.QUALS.map((q) => [q, r[q].ok]));
        const sock4 = an(['uit'], [['sock', 4]], { diff: 2 });
        W.levels = { sock4: pickOk(sock4), sock4Il: Object.fromEntries(E.QUALS.map((q) => [q, sock4[q].ok ? [sock4[q].minIl, sock4[q].reqLv] : null])), sock4Normal: pickOk(an(['uit'], [['sock', 4]], { diff: 0 })), sock3Normal: pickOk(an(['uit'], [['sock', 3]], { diff: 0 })),
          ethBow: pickOk(an(E.builderBases('bow', -1), [['eth', 1]], { diff: 2 })), ethMonarch: pickOk(an(['uit'], [['eth', 1]], {})), ringSock: pickOk(an(['rin'], [['sock', 1]], {})), edDur: pickOk(an(['uit'], [['ed', 5], ['dur', 10]], {})), threeRows: pickOk(an(['lsd'], [['ar', 1], ['dm', 5], ['dur', 10]], {})) };
      }
      // item-kind facts
      const codesOf = (pred) => Object.keys(E.items).filter((c) => E.items[c].sp && pred(E.items[c]));
      W.ethList = Object.fromEntries(Object.keys(E.items).filter((c) => E.items[c].k !== 'm').map((c) => [c, E.ethItem(c) ? 1 : 0]));
      W.ethChance = { low: E.ethChance('uit', 'low'), set: E.ethChance('uit', 'set'), unique: E.ethChance('uit', 'unique'), normal: E.ethChance('uit', 'normal'), sup: E.ethChance('uit', 'sup'), magic: E.ethChance('uit', 'magic'), rare: E.ethChance('uit', 'rare') };
      const F = W.facts;
      F.jewelerMagic4 = E.affixProb('uit', E.affixLevel(85, E.items.uit), 'magic', [{ key: SK, min: 4 }], { ilvl: 85 });
      F.rareSock1 = E.affixProb('uit', E.affixLevel(85, E.items.uit), 'rare', [{ key: SK, min: 1 }], { ilvl: 85, rolls: 40000 });
      F.rareSock3 = E.affixProb('uit', E.affixLevel(85, E.items.uit), 'rare', [{ key: SK, min: 3 }], { ilvl: 85, rolls: 40000 });
      const nms = (L) => L.map((a) => a.n);
      const names = (code, rare) => nms(E.eligible(code, 99, rare).auto);   // the facts below are about automagic rows
      const cnt = (pred, rare, wanted) => codesOf(pred).filter((c) => names(c, rare).some((x) => wanted.indexOf(x) >= 0)).length;
      const ama = (i) => i.cs && (i.t === 'abow' || i.t === 'ajav' || i.t === 'aspe');
      F.chromatic = { rare: cnt((i) => i.t === 'ashd', true, ['Chromatic']), magic: cnt((i) => i.t === 'ashd', false, ['Chromatic']), bases: codesOf((i) => i.t === 'ashd').length };
      F.archer = { rare: cnt(ama, true, ["Archer's", "Lancer's"]), magic: cnt(ama, false, ["Archer's", "Lancer's"]), bases: codesOf(ama).length };
      F.anthrax = { rare: cnt((i) => i.t === 'head', true, ['of Anthrax']), magic: cnt((i) => i.t === 'head', false, ['of Anthrax']), bases: codesOf((i) => i.t === 'head').length };
      F.orbs = { rare: cnt((i) => i.t === 'orb', true, ["Great Wyrm's", 'of the Colossus']), magic: cnt((i) => i.t === 'orb', false, ["Great Wyrm's", 'of the Colossus']), wyrmRare: cnt((i) => i.t === 'orb', true, ["Wyrm's"]), bases: codesOf((i) => i.t === 'orb').length };
      { const ob = 'ob1', al = E.affixLevel(85, E.items[ob]), LM = [{ key: '+# to Life', min: 1 }, { key: '+# to Mana', min: 1 }];
        F.orbLifeMana = { life: E.affixProb(ob, al, 'normal', [LM[0]], { ilvl: 85 }), mana: E.affixProb(ob, al, 'normal', [LM[1]], { ilvl: 85 }), both: E.affixProb(ob, al, 'normal', LM, { ilvl: 85 }), bothRare: E.affixProb(ob, al, 'rare', LM, { ilvl: 85, rolls: 3000 }), bothMagic: E.affixProb(ob, al, 'magic', LM, { ilvl: 85 }) }; }
      F.knight = { rareRow: E.eligible('pa5', 99, true).auto.filter((a) => a.n === "Knight's").map((a) => a.mods.map((m) => m[4])), normalBoth: E.affixProb('pa5', E.affixLevel(85, E.items.pa5), 'normal', [{ key: AR, min: 101 }, { key: EDM, min: 51 }], { ilvl: 85 }),
        rareBoth: E.affixProb('pa5', E.affixLevel(85, E.items.pa5), 'rare', [{ key: AR, min: 101 }, { key: EDM, min: 51 }], { ilvl: 85, rolls: 20000 }) };
      { const ctx = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0, clvl: 85, tier: 1 });
        const hs = (nmx, ranks) => E.sources(ctx).find((s) => s.name === nmx && s.diff === 2 && ranks.indexOf(s.rank) >= 0);
        F.drops = { hc: E.chanceFor(ctx, hs('Mephisto', ['boss']), { kind: 'unique', id: 'Harlequin Crest' }, 0).target, ua1: E.chanceFor(ctx, hs('Andariel', ['boss']), { kind: 'base', code: 'ua1' }, 0).target, pk2: E.chanceFor(ctx, hs('The Summoner', ['boss']), { kind: 'base', code: 'pk2' }, 0).target };
        F.whiteDrops = { normalSock: E.affixSearch(ctx, { codes: ['uit'], quality: 'normal', conds: [{ key: SK, min: 1 }], mf: 0, diff: 2, act: 0, area: 0, rolls: 1000 }, null).rows.length,
          supSock: E.affixSearch(ctx, { codes: ['uit'], quality: 'sup', conds: [{ key: SK, min: 1 }], mf: 0, diff: 2, act: 0, area: 0, rolls: 1000 }, null).rows.length }; }
      F.bowEth = Object.fromEntries(['am1', 'sbw', 'lxb'].map((c) => [c, Object.fromEntries(['low', 'normal', 'sup', 'magic', 'rare', 'unique'].map((q) => [q, E.ethChance(c, q)]))]));
      F.bowEthRow = ['bow', 'xbow'].some((t) => E.builderBases(t, -1).some((c) => E.builderCatalog([c], 85).has('xeth')));
      F.monarchEthRow = E.builderCatalog(['uit'], 85).has('xeth');
      F.ethSetQuals = E.builderCatalog(['uit'], 85).get('xeth').quals;
      // area grouping (areaSources): champions / uniques / minions / heralds of one area merged; per-kill odds of a merged row = each member's, area totals unchanged
      F.groups = {};
      for (const tzOn of [false, true]) {
        const cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: tzOn, clvl: 85, tier: 1, mf: 0 }), tg = { kind: 'base', code: 'uit' };
        const raw = E.sources(cx).filter((s) => s.diff === 2), grp = E.areaSources(cx).filter((s) => s.diff === 2);
        let worst = 0, members = 0;
        for (const g of grp) {
          if (!g.members) continue;
          const ids = g.mon.split(' '), pg = E.chanceFor(cx, g, tg, 0).target;
          for (const s of raw) if (s.rank === g.rank && s.area === g.area && s.tz === g.tz && s.mlvl === g.mlvl && ids.indexOf(s.mon) >= 0) {
            members++; const p = E.chanceFor(cx, s, tg, 0).target; worst = Math.max(worst, Math.abs(p - pg) / Math.max(pg, 1e-300)); }
        }
        const tot = (L) => L.reduce((t, s) => t + E.chanceFor(cx, s, tg, 0).target * s.perRun, 0);
        const cnt = (L, rank, area) => L.filter((s) => s.rank === rank && s.areaName === area && s.tz === tzOn).length;
        F.groups[tzOn ? 'tz' : 'noTz'] = { worst, members, grouped: grp.filter((s) => s.members).length, rawGroupable: raw.filter((s) => /champion|unique|minion|herald/.test(s.rank)).length,
          totRaw: tot(raw), totGrp: tot(grp), drifterChamp: cnt(grp, 'champion', 'Drifter Cavern'), drifterUnique: cnt(grp, 'unique', 'Drifter Cavern'),
          drifterChampRaw: cnt(raw, 'champion', 'Drifter Cavern'), heraldRows: grp.filter((s) => s.rank === 'herald' && s.tz === tzOn).length, bloodMoorHeraldRaw: cnt(raw, 'herald', 'Blood Moor') };
      }
      // All tiers (tier 0): one 'Herald tier N' row per tier over all terror-zone areas, each equal to the per-monster herald of that tier (Blood Moor, Hell, Sunder Charm path via Monarch + Flame Rift)
      { const all = E.areaSources(E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: 0, mf: 0 })).filter((s) => s.rank === 'herald' && s.diff === 2);
        const names = all.map((s) => s.name), tg = { kind: 'unique', id: 'PreCrafted Flame Rift' };
        let worst = 0;
        for (const g of all) { const cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: g.tier, mf: 0 }); const r = E.sources(cx).find((x) => x.rank === 'herald' && x.mon === 'zombie1' && x.areaName === 'Blood Moor' && x.diff === 2);
          const cx0 = E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: 0, mf: 0 }); const pg = E.chanceFor(cx0, g, tg, 0).target, pr = E.chanceFor(E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: g.tier, mf: 0 }), r, tg, 0).target;
          worst = Math.max(worst, Math.abs(pg - pr) / Math.max(pr, 1e-300)); }
        F.heraldTiers = { names, worst, p: all.map((g) => E.chanceFor(E.getCtx({ players: 1, party: 1, ladder: true, tz: true, clvl: 85, tier: 0, mf: 0 }), g, tg, 0).target) }; }
      { const cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0 }); const t = E.areaSources(cx).filter((s) => s.diff === 2 && /^Tal Rasha's Tomb/.test(s.areaName));
        F.talTombs = { dupOf: Object.keys(E.DUP_OF).sort((a, b) => a - b).map((k) => [+k, +E.DUP_OF[k]]), areas: Array.from(new Set(t.map((s) => s.area))), maxRowsPerMon: Math.max(...Object.values(t.filter((s) => s.rank === 'regular').reduce((o, s) => (o[s.mon] = (o[s.mon] || 0) + 1, o), {}))) }; }
      // Tal Rasha's Tombs: area 66 = all seven tombs (staff + boss + 5 plain, each its own areaRun with geo.tomb cells); the true-tomb run = one staff tomb
      { const T = E.data.levels[66].geo.tomb, all = (ranks, r) => { let t = 0; for (const [, k] of r.kills) for (const rk of ranks) t += k[rk] || 0; return t; }, RK = ['regular', 'champion', 'unique', 'minion'];
        const cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0 }), L = E.areaSources(cx), S = E.sources(cx), tg = { kind: 'base', code: 'r08' };
        F.tombs = { tomb: T, umin: E.data.levels[66].umin, umax: E.data.levels[66].umax, d: [] };
        for (const d of [0, 1, 2]) {
          const r = E.areaRun(66, d), c = { staff: E.areaRun(66, d, T.staff[d]), boss: E.areaRun(66, d, T.boss[d]), plain: E.areaRun(66, d, T.plain[d]) };
          const rows = S.filter((s) => s.area === 66 && s.diff === d && s.cases);
          F.tombs.d.push({ kills: all(RK, r), sum: all(RK, c.staff) + all(RK, c.boss) + 5 * all(RK, c.plain), elite: r.bosses, eliteSum: c.staff.bosses + c.boss.bosses + 5 * c.plain.bosses,
            caseElite: [c.staff.bosses, c.boss.bosses, c.plain.bosses], caseKills: [all(RK, c.staff), all(RK, c.boss), all(RK, c.plain)],
            rowsMatch: rows.length > 0 && rows.every((s) => Math.abs(s.perRun - (s.suMin || 0) - (s.cases.staff + s.cases.boss + 5 * s.cases.plain)) <= 1e-9 * Math.max(1, s.perRun)),   // suMin: Ancient Kaa's minions
            kaa: S.filter((s) => s.area === 66 && s.diff === d && s.rank === 'super').map((s) => [s.name, s.perRun]) });
        }
        const tt = E.runSources(cx, 'truetomb', 2, L), names = E.areaSources(cx).filter((s) => s.area === 66).map((s) => s.areaName);
        const perKill = (ctx) => Object.fromEntries(E.sources(ctx).filter((s) => s.area === 66 && s.diff === 2).map((s) => [s.key, E.chanceFor(ctx, s, tg, 0).target]));
        const pk1 = perKill(cx);
        E.CONFIG.run.tombsAllSeven = false;
        const cx0 = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0 }), old = E.sources(cx0).filter((s) => s.area === 66 && s.diff === 2 && /^(regular|champion|unique|minion)$/.test(s.rank));
        const pk0 = perKill(cx0), oldName = old[0].areaName, oldRun = E.areaRun(66, 2);
        E.CONFIG.run.tombsAllSeven = true;
        // the true tomb run vs the old whole-area clear without Ancient Kaa's minions (suMin): kills per run in total and of the regular rows one by one
        const oldReg = Object.fromEntries(old.filter((s) => s.rank === 'regular').map((s) => [s.key, s.perRun])), ttReg = Object.fromEntries(tt.filter((s) => s.rank === 'regular').map((s) => [s.key, s.perRun]));
        const oldTot = old.reduce((a, s) => a + s.perRun - (s.suMin || 0), 0), ttTot = tt.reduce((a, s) => a + s.perRun, 0);
        let worstTrue = Math.abs(ttTot - oldTot) / oldTot; for (const k in oldReg) worstTrue = Math.max(worstTrue, Math.abs((ttReg[k] || 0) - oldReg[k]) / Math.max(oldReg[k], 1));
        Object.assign(F.tombs, { trueKills: tt.reduce((a, s) => a + s.perRun, 0), trueKaa: tt.filter((s) => s.rank === 'super').length, worstTrue,
          oldKills: all(RK, oldRun), oldElite: oldRun.bosses, oldName, names: Array.from(new Set(names)),
          perKillSame: Object.keys(pk0).length > 0 && Object.keys(pk0).every((k) => pk1[k] === pk0[k]),
          farms: E.CONFIG.farms.filter((f) => /^Tal Rasha/.test(f.name)).map((f) => [f.name, f.area, f.src]) });
        // the all-seven farm beats the true tomb per run (same rows, more kills)
        const runP = (rows, t) => -Math.expm1(rows.reduce((a, s) => a + s.perRun * Math.log1p(-Math.min(E.chanceFor(cx, s, t, 0).target, 1)), 0));
        const allRows = L.filter((s) => s.area === 66 && s.diff === 2 && !s.herald && !s.quest);
        F.tombs.farmOrder = ['r08', 'r15', 'r22'].map((code) => { const t = { kind: 'base', code }; return [code, runP(allRows, t), runP(tt, t)]; }); }
      // item tooltip stat lines (itemStats): known items, no '#' left anywhere, the parenthesised range format vs the builder's
      { const T = {};
        for (const [k, id] of [['unique', 'Harlequin Crest'], ['unique', 'The Stone of Jordan'], ['unique', 'Annihilus'], ['unique', 'PreCrafted Flame Rift'], ['unique', 'Magefist'],
          ['unique', 'Hellfire Torch'], ['unique', "Blackbog's Sharp"], ['set', "Tal Rasha's Horadric Crest"], ['set', "Sigon's Visor"]]) T[id] = E.itemStats(k, id);
        const left = [], all = [];
        for (const u of E.data.uniques) { const s = E.itemStats('unique', u.id); all.push(...s.mods); }
        for (const u of E.data.sets) { const s = E.itemStats('set', u.id); all.push(...s.mods, ...s.smods.map((x) => x[1]), ...(s.set ? s.set.p.map((x) => x[1]).concat(s.set.f) : [])); }
        for (const x of all) if (x.indexOf('#') >= 0 || /\bNaN\b|undefined/.test(x)) left.push(x);
        F.tipStats = { items: T, left: left.slice(0, 20), nLines: all.length, unknown: E.itemStats('unique', 'no such item'),
          fmt: [E.describe('+#% Enhanced Defense', 120, 150), E.describe('+#% Enhanced Defense', 120, 150, null, { paren: true }), E.describe('+# to All Skills', 2, 2, null, { paren: true }),
            E.describe('Adds #-# fire damage', 25, 40, [[10, 15], [25, 40]]), E.describe('Adds #-# fire damage', 25, 40, [[10, 15], [25, 40]], { paren: true }),
            E.describe('+# to Life (Based on Character Level)', 12, 12), E.describe('+# to Life (Based on Character Level)', 12, 12, null, { paren: true })] }; }
      // super unique minions (rows with suMin: the part of a minion row that comes from super uniques) and the Hell-only Pandemonium areas
      { const cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0 }), S = E.sources(cx);
        F.suMinions = S.filter((s) => s.suMin > 0).map((s) => [s.area, s.mon, s.diff, s.suMin, s.perRun, s.tc, s.mlvl]);
        F.pandemonium = { low: S.filter((s) => s.area >= 133 && s.area <= 136 && s.diff < 2).length, hell: [133, 134, 135, 136].map((a) => S.filter((s) => s.area === a && s.diff === 2).length),
          colossalLow: S.filter((s) => s.area === 137 && s.diff < 2).length, colossalHell: S.filter((s) => s.area === 137 && s.diff === 2).length };
        const grp = E.areaSources(cx).filter((s) => s.rank === 'minion' && s.diff === 2 && (s.area === 83 || s.area === 102));
        F.councilGroups = grp.map((s) => [s.area, s.mon, s.perRun, s.tc]); }
      // the eight Rainbow Facets: distinct ids from their properties (build.py), each its own search entry with its own chance, together the old combined one
      { const ids = E.data.uniques.filter((u) => /^Rainbow Facet/.test(u.id)).map((u) => u.id), cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0 });
        const src = E.sources(cx).find((s) => s.rank === 'boss' && s.mon === 'diablo' && s.diff === 2), each = ids.map((id) => E.chanceFor(cx, src, { kind: 'unique', id }, 0).target);
        F.facets = { ids, indexed: E.searchIndex().filter((x) => x.kind === 'unique' && /^Rainbow Facet/.test(x.id)).length, each, spread: Math.max(...each) / Math.min(...each) }; }
      // popular farms (CONFIG.farms, tab 2): each resolves to at least one source in every difficulty, as the app looks it up
      { const cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, mf: 0, quest: false }), L = E.areaSources(cx);
        F.farms = E.CONFIG.farms.map((f) => [f.name, [0, 1, 2].map((d) => (f.src.indexOf('run|') === 0 ? E.runSources(cx, f.src.slice(4), d, L)
          : L.filter((s) => s.area === f.area && s.diff === d && !s.herald && !s.quest && (!f.src || s.key === f.src + '|' + d))).length)]);
        const clr = (a, d) => L.filter((s) => s.area === a && s.diff === d && !s.herald && !s.quest);   // tab 2's whole area clear
        F.pit = [0, 1, 2].map((d) => { const r = E.runSources(cx, 'pit', d, L), c = clr(12, d).concat(clr(16, d)); return [r.length, c.length, r.reduce((t, s) => t + s.perRun, 0), c.reduce((t, s) => t + s.perRun, 0), c.every((s) => r.indexOf(s) >= 0)]; }); }
      // farm times (farmMinutes, docs/plans/farm-times.md): scenarios A-F against the plan's table, ordering, overrides
      { const SC = [['boss', 'fast', 'saved', 0], ['boss', 'fast', 'random', 0], ['density', 'fast', 'random', 0], ['density', 'slow', 'random', 0], ['density', 'slow', 'random', 1], ['density', 'none', 'random', 0]];
        const EXP = { 'Pindleskin': [1.3, 1.3, 1.4, 1.5, 1.5, 2.1], 'Andariel': [1.8, 2.1, 2.2, 2.6, 2.6, 4.5], 'Countess': [2.3, 3.0, 3.0, 3.6, 3.6, 6.8], 'Summoner: boss only': [1.5, 1.9, 1.9, 2.3, 2.3, 4.1],
          'Summoner: + Arcane Sanctuary ghosts': [4.8, 5.2, 4.3, 4.8, 4.6, 7.5], 'Travincal council': [1.6, 1.6, 1.6, 1.8, 1.7, 2.5], 'Mephisto: boss only': [1.5, 1.9, 2.0, 2.4, 2.4, 4.2],
          'Mephisto: + Bremm (5 council)': [2.3, 3.0, 3.2, 3.8, 3.7, 6.7], 'Mephisto: + full council (7 council)': [2.3, 3.0, 3.2, 3.8, 3.7, 6.7], 'Shenk + Eldritch': [1.8, 1.9, 2.1, 2.3, 2.3, 3.6],
          'Nihlathak': [2.3, 2.8, 3.0, 3.6, 3.5, 6.2], 'Ancient Tunnels': [3.6, 4.2, 3.5, 4.1, 4.0, 6.5], "Tal Rasha's Tombs: all seven": [11.5, 13.0, 10.6, 12.2, 11.5, 19.6], "Tal Rasha's Tombs: true tomb": [3.2, 3.7, 3.3, 3.8, 3.6, 6.0], 'The Pit': [4.8, 5.4, 4.5, 5.1, 4.9, 8.1], 'Chaos: seal pop': [5.1, 5.3, 4.8, 5.5, 5.0, 8.4],
          'Chaos: full clear': [10.0, 10.4, 8.9, 9.7, 8.5, 13.7], 'Baal': [6.2, 7.2, 6.6, 7.4, 6.7, 11.1], 'Cow Level': [9.8, 10.5, 7.5, 8.3, 8.3, 13.8] };
        const mk = (sc, ov) => ({ style: sc[0], teleport: sc[1], map: sc[2], sunder: !!sc[3], overhead: ov == null ? 0.5 : ov });   // the plan's A-F table was computed with 0.5 min overhead
        const FM = { missing: [], worst: 0, noTime: E.CONFIG.farms.filter((f) => !f.time).length, order: [], sunder: [], overhead: null, none: E.farmMinutes({ name: 'x' }, {}) };
        for (const f of E.CONFIG.farms) {
          const ex = EXP[f.name]; if (!ex) { FM.missing.push(f.name); continue; }
          SC.forEach((sc, i) => { FM.worst = Math.max(FM.worst, Math.abs(E.farmMinutes(f, mk(sc)) - ex[i])); });
          const m = (tp, map, st, sd) => E.farmMinutes(f, { style: st || 'boss', teleport: tp, map, sunder: !!sd });
          FM.order.push([f.name, m('none', 'saved') >= m('slow', 'saved') && m('slow', 'saved') >= m('fast', 'saved'), m('fast', 'random') >= m('fast', 'saved'), m('none', 'random') >= m('slow', 'random') && m('slow', 'random') >= m('fast', 'random')]);
          FM.sunder.push([f.name, m('fast', 'saved', 'boss', 1) <= m('fast', 'saved', 'boss', 0)]);
        }
        FM.overhead = [E.farmMinutes(E.CONFIG.farms[0], { overhead: 0 }), E.farmMinutes(E.CONFIG.farms[0], { overhead: 2 }), E.farmMinutes(E.CONFIG.farms[0], {})];
        const cow = E.CONFIG.farms.find((f) => f.name === 'Cow Level'); FM.cowWalk = [E.farmMinutes(cow, { teleport: 'fast', overhead: 0 }), E.farmMinutes(cow, { teleport: 'none', overhead: 0 })];
        FM.perHour = [[0.01, 2], [0.002, 10], [0.5, 1.5]].map(([p, m]) => [p, m, 1 - Math.pow(1 - p, 60 / m)]);
        F.farmTime = FM; }
      // magic find in the Tab 1 charts: a rune's chance does not move with MF, a unique's rises (Hell Mephisto)
      { const cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: false, clvl: 85, mf: 0 }), sm = E.sources(cx).find((s) => s.name === 'Mephisto' && s.diff === 2 && s.rank === 'boss' && !s.quest);
        const at = (tg, mf) => E.chanceFor(cx, sm, tg, mf).target, ber = { kind: 'base', code: 'r30' }, hc = { kind: 'unique', id: 'Harlequin Crest' };
        F.mfChart = { src: !!sm, ber: [at(ber, 0), at(ber, 1000)], hc: [at(hc, 0), at(hc, 1000)] }; }
      // seal pop (runSources 'sealpop'): the rows per difficulty / terror zone; per-run chance via chanceFor == via dropsOf (what tab 2 adds up); never above the full clear
      F.sealPop = { rows: {}, worstRun: 0, items: 0, aboveClear: [] };
      for (const tzOn of [false, true]) for (let d = 0; d < 3; d++) {
        const cx = E.getCtx({ players: 1, party: 1, ladder: true, tz: tzOn, clvl: 85, tier: 0, mf: 0, quest: true }), L = E.areaSources(cx), R = E.runSources(cx, 'sealpop', d, L);
        F.sealPop.rows[(tzOn ? 'tz' : 'noTz') + d] = R.map((s) => [s.rank, s.mon, s.su || '', s.perRun, s.mlvl, s.tc, !!s.quest]);
        if (tzOn || d !== 2) continue;
        const clear = L.filter((s) => s.area === 108 && s.diff === 2 && !s.herald && !s.quest), lm = (S) => {
          const m = new Map();
          for (const s of S) { const dr = E.dropsOf(cx, s, 0); for (const [kind, mm] of [['base', dr.base], ['unique', dr.unique], ['set', dr.set]]) for (const [id, p] of mm) m.set(kind + '|' + id, (m.get(kind + '|' + id) || 0) + s.perRun * Math.log1p(-Math.min(p, 1))); }
          return m; };
        const run = lm(R), full = lm(clear);
        for (const [k, v] of run) {
          F.sealPop.items++;
          const [kind, id] = k.split(/\|(.*)/), tg = kind === 'base' ? { kind, code: id } : { kind, id };
          if (F.sealPop.items % 25 === 1) {   // every 25th item: the same per-run chance from chanceFor
            const ref = 1 - R.reduce((t, s) => t * Math.pow(1 - E.chanceFor(cx, s, tg, 0).target, s.perRun), 1), got = -Math.expm1(v);
            F.sealPop.worstRun = Math.max(F.sealPop.worstRun, Math.abs(got - ref) / Math.max(ref, 1e-300)); }
          if (-Math.expm1(v) > -Math.expm1(full.get(k) || 0) * (1 + 1e-12)) F.sealPop.aboveClear.push(k);
        }
      }
    }
    // ---- affix table fit test (fitsCombo, the fast structural test) against the full sweep (feasibleAny) ----
    { const QSA = ['low', 'normal', 'sup', 'magic', 'rare'], T = E.builderTypes(), fit = res.fit = { cases: [], missed: 0, extra: 0, n: 0, bad: [], ms: {} };
      let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const mk = (st, cs, r) => { cs = cs.slice(); for (const m of r.mods) { const s = st.get(m.key); if (!s) continue; const v = s.le ? m.max : m.min, i = cs.findIndex((c) => c.key === m.key);
        if (i >= 0) cs[i] = Object.assign({}, cs[i], { min: s.le ? Math.min(cs[i].min, v) : Math.max(cs[i].min, v) }); else cs.push(s.le ? { key: m.key, min: v, le: true } : { key: m.key, min: v }); } return cs; };
      for (const [tn, quals] of [['Boots', QSA], ['Small Charm', QSA], ['Circlet', QSA], ['Staff', QSA], ['Boots', ['magic']], ['Circlet', ['rare']], ['Boots', ['normal']], ['Boots', ['sup']]]) {
        const ty = T.find((t) => t.name === tn), codes = E.builderBases(ty.code, -1), idx = E.fitIndex(codes), cat = Array.from(E.builderCatalog(codes, 85).values()), st = new Map(E.builderStats(codes).map((x) => [x.key, x]));
        for (let sc = 0; sc < 4; sc++) {
          let conds = []; for (let k = 0; k < sc; k++) conds = mk(st, conds, cat[Math.floor(rnd() * cat.length)]);
          for (const r of cat) { const cs = mk(st, conds, r), a = E.fitsCombo(idx, cs, quals, 2), b = E.feasibleAny(codes, cs, quals, 2); fit.n++; if (b && !a) fit.missed++; if (a && !b) fit.extra++; if (a !== b && fit.bad.length < 5) fit.bad.push([tn, quals.join(), JSON.stringify(cs)]); }
        }
      }
      for (const tn of ['Any Armor', 'Melee Weapon']) {   // one full table pass on a broad type with two picks
        const ty = T.find((t) => t.name === tn), codes = E.builderBases(ty.code, -1), cat = Array.from(E.builderCatalog(codes, 85).values()), st = new Map(E.builderStats(codes).map((x) => [x.key, x]));
        const t0 = performance.now(), idx = E.fitIndex(codes), t1 = performance.now();
        const conds = mk(st, mk(st, [], cat[40]), cat[200]); let unfit = 0;
        for (const r of cat) if (!E.fitsCombo(idx, mk(st, conds, r), QSA, 2)) unfit++;
        fit.ms[tn] = { bases: codes.length, rows: cat.length, unfit, index: Math.round(t1 - t0), pass: Math.round(performance.now() - t1) };
      }
    }
    // ---- item card odds (cardOdds: exact magic; rare reweighted from recorded samples) vs affixProb averaged over the bases ----
    { const T = E.builderTypes(), card = res.card = { cases: [], mono: [], ms: {} }, ilOf = (c, il) => Math.max(il, E.items[c].q, 1);
      const avg = (codes, q, cs, il, rolls, w) => { let t = 0, W = 0; for (const c of codes) { const wi = w ? w.get(c) || 0 : 1; if (!wi || E.items[c].q > il) continue; const l = ilOf(c, il); t += wi * E.affixProb(c, E.affixLevel(l, E.items[c]), q, cs, { ilvl: l, rolls }); W += wi; } return W ? t / W : 0; };
      const kf = (st, re) => st.find((x) => re.test(x.text));
      const mkc = (st, res_) => res_.map((re) => { const x = typeof re === 'string' ? st.find((s) => s.key === re) : kf(st, re); return { key: x.key, min: x.min }; });
      const cases = [
        ['Boots', 85, ['magic'], [/Faster Run/, /Fire Resist/], null], ['Small Charm', 85, ['magic'], [/Attack Rating/, /Maximum Damage/, /to Life/], null],
        ['Boots', 85, ['rare', 'magic'], [/Faster Run/, /Fire Resist/], null], ['Circlet', 60, ['rare', 'magic', 'normal'], [/Fire Resist/, /Cold Resist/], null],
        ['Staff', 80, ['rare', 'magic'], ['staff'], null], ['Wand', 40, ['rare', 'magic'], ['staff', /to Life/], null], ['Any Armor', 85, ['rare', 'magic', 'sup'], [/Fire Resist/, /to Life/, /Cold Resist/], 'w'],
      ];
      for (const [tn, il, quals, res_, wt] of cases) {
        const ty = T.find((t) => t.name === tn), codes = E.builderBases(ty.code, -1), st = E.builderStats(codes);
        let cs;
        if (res_[0] === 'staff') { const x = st.filter((s) => s.staff).sort((a, b) => a.text.localeCompare(b.text))[0]; cs = [{ key: x.key, min: Math.min(x.max, 2) }].concat(mkc(st, res_.slice(1))); }
        else cs = mkc(st, res_);
        let w = null; if (wt) { w = new Map(); codes.forEach((c, i) => w.set(c, i % 3 ? 1 + (i % 5) : 0)); }
        const rolls = 20000, ix = cs.map((c, i) => i), groups = cs.length > 1 ? [ix.slice(0, 2), ix.slice(1)] : [ix];
        const t0 = performance.now(), r = E.cardOdds(codes, cs, il, quals, w, { rolls, groups }), t1 = performance.now();
        const c = { name: tn, ilvl: il, n: codes.length, conds: cs.length, ms: Math.round(t1 - t0), q: {} };
        for (const q of quals) {
          const want = avg(codes, q, cs, il, rolls, w), wantC = cs.map((x) => avg(codes, q, [x], il, rolls, w)), wantG = groups.map((g) => avg(codes, q, g.map((i) => cs[i]), il, rolls, w));
          c.q[q] = { got: r.total[q], want, cond: r.perCond.map((x, i) => [x[q], wantC[i]]), grp: r.perGroup.map((x, i) => [x[q], wantG[i]]),
            ord: r.total[q] <= Math.min.apply(null, r.perGroup.map((x) => x[q]).concat(r.perCond.map((x) => x[q]))) + 1e-15 ? 1 : 0 };
          // raising the first threshold never raises the odds
          const hi = cs.map((x, i) => i ? x : Object.assign({}, x, { min: x.min + Math.max(1, Math.round((st.find((s) => s.key === x.key).max - x.min) / 3)) }));
          const p1 = E.cardOdds(codes, hi, il, [q], w, { rolls }).total[q]; c.q[q].mono = p1 <= r.total[q] + 1e-15 ? 1 : 0;
        }
        card.cases.push(c);
      }
    }
    // ---- best item level (ilvlCurve): argmax, first, flat band, single values == cardOdds ----
    { const T = E.builderTypes(), cv = res.curve = { cases: [] }, codesOf = (n) => E.builderBases(T.find((t) => t.name === n).code, -1);
      const key = (codes, re) => E.builderStats(codes).find((x) => re.test(x.key)).key;
      for (const [nm, tn, cs, il] of [['boots FRW30 + fire31', 'Boots', [[/Faster Run/, 30], [/^Fire Resist/, 31]], 85], ['grand charm +45 life', 'Grand Charm', [[/^\+# to Life$/, 45]], 91], ['boots FRW30 + fire31 + light31 + MF16', 'Boots', [[/Faster Run/, 30], [/^Fire Resist/, 31], [/^Lightning Resist/, 31], [/Magic Items/, 16]], 68]]) {
        const codes = codesOf(tn), conds = cs.map(([re, m]) => ({ key: key(codes, re), min: m })), quals = ['magic', 'rare'], c = E.ilvlCurve(codes, conds, quals, null, {}), o = { name: nm, ilvl: il, q: {} };
        for (const q of quals) {
          const x = c[q], mx = Math.max.apply(null, x.p), fi = x.p.findIndex((v) => v > 0) + 1, one = E.cardOdds(codes, conds, il, [q], null, {}).total[q];
          o.q[q] = { best: x.best, argmax: x.p.indexOf(mx) + 1, pBest: x.pBest, mx, first: x.first, firstWant: fi % 100, n: x.p.length, one: x.p[il - 1], oneWant: one,
            band: x.best ? (x.p.slice(x.lo - 1, x.hi).every((v) => v >= 0.95 * mx - 1e-300) && (x.lo <= 1 || x.p[x.lo - 2] < 0.95 * mx) && (x.hi >= 99 || x.p[x.hi] < 0.95 * mx) ? 1 : 0) : 1 };
        }
        cv.cases.push(o);
      }
    }
    // ---- affix families (builderFamilies / familyTable), per-character-level stats ----
    {
      const T = E.builderTypes(), codesOf = (n) => E.builderBases(T.find((t) => t.name === n).code, -1), fam = {};
      const famsOf = (n) => Array.from(E.builderFamilies(codesOf(n)).values());
      const sc = codesOf('Small Charm'), F = famsOf('Small Charm'), br = F.filter((f) => f.name === 'Bronze');
      fam.bronze = { n: br.length, tiers: br.length ? br[0].tiers.map((t) => [t.lvl, t.mods[0].min, t.mods[0].max]) : [], vals: br.length ? br[0].vals[br[0].keys[0]] : [], ids: br.length ? br[0].ids.length : 0 };
      const cat = E.builderCatalog(sc);
      fam.idsMap = br.length ? br[0].ids.every((id) => E.familyIdOf(cat.get(id)) === br[0].fid) : false;
      const K = br[0].keys[0], iv = br[0].vals[K];
      const av = E.allowedValues(iv, 2, 36);
      fam.allowed = { all: av, lo7: E.allowedValues(iv, 7, 36), none: E.allowedValues(iv, 20, 30), ge5: E.snapValue(av, 5, false), ge13: E.snapValue(av, 13, false), le5: E.snapValue(av, 5, true), le1: E.snapValue(av, 1, true), ge4: E.snapValue(av, 4, false) };
      const tf = (v) => { const t = E.tierFor(br[0], K, v, false); return t ? [t.lvl, t.lr] : null; };
      fam.tier = { t3: tf(3), t4: tf(4), t6: tf(6), t12: tf(12), t13: tf(13) };
      const bo = famsOf('Boots').filter((f) => /^of Acceleration$/i.test(f.name));
      fam.accel = bo.map((f) => ({ keys: f.keys, vals: f.vals[f.keys[0]], tiers: f.tiers.length }));
      // a family never has two groups on one base (tier odds add up), over every type
      let bad = 0;
      const allc = new Set(); for (const t of T) for (const c of t.codes) allc.add(c);
      for (const c of allc) {
        const g = new Map();
        for (const r of E.builderCatalog([c]).values()) { if (r.side !== 'prefix' && r.side !== 'suffix') continue; const k = E.familyIdOf(r), s = g.get(k) || new Set(); s.add(r.g); g.set(k, s); }
        for (const s of g.values()) if (s.size > 1) bad++;
      }
      fam.groupBad = bad;
      // family odds: the table's family row == affixProb of a condition only this family can meet, averaged over the bases (magic exact; rare close), tier rows add up
      fam.odds = [];
      for (const [tn, ilvl] of [['Small Charm', 85], ['Boots', 85], ['Ring', 60], ['Sword', 85]]) {
        const codes = codesOf(tn), fams = E.builderFamilies(codes), rows = E.builderAffixTable(codes, ilvl, { rolls: 20000, qualities: ['magic', 'rare'] }), ft = E.familyTable(rows, fams);
        const keyCount = new Map(); for (const f of fams.values()) for (const k of f.keys) keyCount.set(k, (keyCount.get(k) || 0) + 1);
        for (const f of ft) {
          if ((f.side !== 'prefix' && f.side !== 'suffix') || f.keys === undefined && f.mods.length !== 1) continue;
          if (f.mods.length !== 1 || keyCount.get(f.mods[0].key) !== 1 || f.mods[0].key.split('#').length !== 2) continue;
          const c = [{ key: f.mods[0].key, min: f.mods[0].min }];
          let m = 0, r = 0; for (const code of codes) { const il = Math.max(ilvl, E.items[code].q, 1), al = E.affixLevel(il, E.items[code]); m += E.affixProb(code, al, 'magic', c, { ilvl: il }); r += E.rareProbFromSamples(code, al, c, { ilvl: il, rolls: 20000 }); }
          const tierSum = f.rows.reduce((a, x) => a + x.magic, 0), tierSumR = f.rows.reduce((a, x) => a + x.rareP, 0);
          fam.odds.push({ t: tn, name: f.name, side: f.side, n: f.rows.length, fam: f.magic, ref: m / codes.length, tierSum, famR: f.rareP, refR: r / codes.length, tierSumR });
        }
      }
      // per-character-level stats: the parameter is the value
      const sw = codesOf('Sword'), K1 = '+# to Maximum Damage (Based on Character Level)', K2 = '+# to Attack Rating (Based on Character Level)';
      const al = E.affixLevel(99, E.items[sw[0]]), el = E.eligible(sw[0], al, true, 99), by = (n) => el.p.find((a) => (a.dn || a.n) === n);
      const fool = by("Fool's"), grind = by('Grinding');
      const hf = famsOf('Sword').find((f) => f.name === 'Hawkeye'), hc = hf ? hf.tiers[0].codes[0] : null;
      const hawk = hc ? E.eligible(hc, E.affixLevel(hf.tiers[0].minIl, E.items[hc]), false, hf.tiers[0].minIl).p.find((a) => (a.dn || a.n) === 'Hawkeye') : null;
      fam.lvl = { has: !!(fool && grind && hawk), fool: fool ? fool.mods.map((m) => [m[4], m[1], m[2], m[3]]) : [],
        p4: E.condProb(fool, { key: K1, min: 4 }), p5: E.condProb(fool, { key: K1, min: 5 }), g5: E.condProb(grind, { key: K1, min: 5 }), g7: E.condProb(grind, { key: K1, min: 7 }),
        a33: E.condProb(fool, { key: K2, min: 33 }), a34: E.condProb(fool, { key: K2, min: 34 }), h33: E.condProb(hawk, { key: K2, min: 33 }),
        div: [E.perLevelDiv(K1), E.perLevelDiv(K2), E.perLevelDiv('+#% Enhanced Damage')], at: E.perLevelAt(K1, 4, 85), desc: E.describe(K1, 4, 4), desc2: E.describeAt(K2, 33),
        f4: E.feasibleAny(sw, [{ key: K1, min: 4 }, { key: K2, min: 33 }], ['magic']), f5: E.feasibleAny(sw, [{ key: K1, min: 5 }, { key: K2, min: 33 }], ['magic']), f5r: E.feasibleAny(sw, [{ key: K1, min: 5 }, { key: K2, min: 33 }], ['rare']), f5b: E.feasibleAny(sw, [{ key: K1, min: 5 }], ['magic']),
        pm4: E.affixProb(sw[0], al, 'magic', [{ key: K1, min: 4 }], { ilvl: 99 }), pm5: E.affixProb(sw[0], al, 'magic', [{ key: K1, min: 5 }], { ilvl: 99 }), pm7: E.affixProb(sw[0], al, 'magic', [{ key: K1, min: 7 }], { ilvl: 99 }) };
      const lk = Array.from(new Set([].concat(...[...allc].map((c) => E.builderStats([c]).map((s) => s.key))))).filter((k) => k.indexOf('(Based on Character Level)') >= 0);
      fam.lvlKeys = lk.map((k) => [k, E.perLevelDiv(k)]);
      res.fam = fam;
    }
    // ---- exact rare odds: rareExact (each side alone) == rareSteps (both sides in one state), on real pools and on a pool with a group on both sides ----
    {
      const RX = res.rareExact = { cases: [], app: [] };
      const keyOf = (Em, code, re) => { const x = Em.builderStats([code]).find((s) => re.test(s.key)); return x ? x.key : null; };
      const one = (Em, tag, code, il, cs) => {
        const conds = cs.map(([re, m]) => ({ key: keyOf(Em, code, re), min: m }));
        if (conds.some((c) => !c.key)) { RX.cases.push({ tag, code, il, missing: true }); return; }
        const al = Em.affixLevel(il, Em.items[code]);
        const p = Em.affixProb(code, al, 'rare', conds, { ilvl: il }), q = Em.affixProb(code, al, 'rare', conds, { ilvl: il, rareSteps: true });
        RX.cases.push({ tag, code, il, n: conds.length, p, q });
      };
      const app = (Em, tag, code, il) => {
        const a = Em.affixAppearance(code, il, 'rare'), b = Em.affixAppearance(code, il, 'rare', undefined, { rareSteps: true });
        let d = 0, sp = 0, ss = 0;
        for (const [k, v] of a) { d = Math.max(d, Math.abs(v - (b.get(k) || 0))); if (k[0] === 'p') sp += v; else if (k[0] === 's') ss += v; }
        RX.app.push({ tag, code, il, n: a.size, d, sp, ss });
      };
      const RES = (e) => [[/^Fire Resist/, 31], [/^Lightning Resist/, 31], [/^Poison Resist/, 31], [/^Cold Resist/, 31]].slice(0, e);
      one(E, 'boots FRW 30 + fire res 31', 'utb', 99, [[/Faster Run/, 30], [/^Fire Resist/, 31]]);
      one(E, 'boots 3 resist prefixes + FRW 30 + MF 16 (5 affixes)', 'utb', 99, RES(3).concat([[/Faster Run/, 30], [/Magic Items/, 16]]));
      one(E, 'boots 4 resist prefixes (only 3 prefixes fit: impossible)', 'utb', 99, RES(4));
      one(E, 'cap fire res 10', 'cap', 60, [[/^Fire Resist/, 10]]);
      one(E, 'monarch life 30 + fire res 20', 'uit', 85, [[/^\+# to Life$/, 30], [/^Fire Resist/, 20]]);
      one(E, 'ring mana 10 + fire res 20', 'rin', 85, [[/^\+# to Mana$/, 10], [/^Fire Resist/, 20]]);
      one(E, 'jewel enhanced damage 30', 'jew', 85, [[/Enhanced Damage/, 30]]);
      app(E, 'boots', 'utb', 99); app(E, 'cap', 'cap', 60); app(E, 'ring', 'rin', 85); app(E, 'jewel', 'jew', 85);
      // RotW group 307 (Virulent / of Acidity ...) is on both sides but not spawnable; made spawnable here to run the shared-group path
      const dataS = JSON.parse(JSON.stringify(data));
      for (const a of dataS.prefixes.concat(dataS.suffixes)) if (a.g === 307) a.sp = 1;
      const ES = Engine.create(dataS);
      { const el = ES.eligible('utb', ES.affixLevel(99, ES.items.utb), true, 99), pg = new Set(el.p.map((a) => a.g)); RX.shared = el.s.filter((a) => pg.has(a.g)).length; }
      one(ES, 'shared group: boots -poison res 2', 'utb', 99, [[/Enemy Poison Resistance/, 2]]);
      one(ES, 'shared group: boots -poison res 3 + FRW 30', 'utb', 99, [[/Enemy Poison Resistance/, 3], [/Faster Run/, 30]]);
      one(ES, 'shared group: boots fire res 31 + FRW 30', 'utb', 99, [[/^Fire Resist/, 31], [/Faster Run/, 30]]);
      one(ES, 'shared group: two pierces of the one group (impossible)', 'utb', 99, [[/Enemy Poison Resistance/, 1], [/Enemy Fire Resistance/, 1]]);
      app(ES, 'shared group: boots', 'utb', 99);
      E.CONFIG.gameMode = 'rotw';
    }
    // ---- popular item presets (CONFIG.itemPresets): the type or base exists, every stat key is a builder stat of it, its quality is feasible ----
    res.presets = { n: E.CONFIG.itemPresets.length, groups: Array.from(new Set(E.CONFIG.itemPresets.map((p) => p.group))), bad: { rotw: [], lod: [] } };
    for (const [mode, EE] of [['rotw', E], ['lod', EL]]) {
      E.CONFIG.gameMode = mode;
      for (const p of E.CONFIG.itemPresets) {
        if (p.rotw && mode === 'lod') continue;
        const ty = p.t ? EE.builderTypes().find((t) => t.code === p.t) : null, codes = p.b ? (EE.items[p.b] ? [p.b] : []) : ty ? EE.builderBases(p.t, p.tr === undefined ? -1 : p.tr) : [];
        if (!codes.length) { res.presets.bad[mode].push(p.name + ': no type / base ' + (p.b || p.t)); continue; }
        const st = new Map(EE.builderStats(codes).map((x) => [x.key, x])), miss = p.a.filter(([k]) => !st.has(k)).map(([k]) => k);
        if (miss.length) { res.presets.bad[mode].push(p.name + ': stat keys missing: ' + miss.join(', ')); continue; }
        const conds = p.a.map(([k, v]) => ({ key: k, min: v === 'max' ? st.get(k).max : v }));
        const an = EE.comboAnalysis(codes, conds, { qualities: [p.q] });
        if (!an[p.q].ok) res.presets.bad[mode].push(p.name + ': not possible as ' + p.q + ' (' + an[p.q].why.join(' ') + ')');
      }
    }
    E.CONFIG.gameMode = 'rotw';
    res.sourcesCount = E.sources(ctxFor(1, 1)).length;
    res.config = E.CONFIG;
  } catch (e) { res.errors.push(String(e.stack || e)); }
  out.textContent = JSON.stringify(res);
  document.title = 'done';
})();
