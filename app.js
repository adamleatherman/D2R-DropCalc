/* UI for the D2R drop calculator. All math lives in engine.js. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DIFF = ['Normal', 'Nightmare', 'Hell'];
  let E = null, S = null, INDEX = [];
  // one data file and one engine per game mode, loaded on first use and kept
  const DATAFILE = { rotw: 'data.json', lod: 'data-lod.json' };
  const ENGINES = {};

  // ---------------- persistent selectors ----------------
  const KEYS = ['s_mode', 's_tier', 's_diff', 's_players', 's_party', 's_mf', 's_quest', 's_tz', 's_clvl', 's_ladder', 's_act'];
  function loadSel() {
    try {
      const raw = localStorage.getItem('d2rdropcalc.sel');
      if (!raw) return;
      const o = JSON.parse(raw);
      for (const k of KEYS) if (k in o) { const el = $(k); if (el.type === 'checkbox') el.checked = !!o[k]; else el.value = o[k]; }
    } catch (e) { /* storage unavailable */ }
  }
  function saveSel() {
    try {
      const o = {};
      for (const k of KEYS) { const el = $(k); o[k] = el.type === 'checkbox' ? el.checked : el.value; }
      localStorage.setItem('d2rdropcalc.sel', JSON.stringify(o));
    } catch (e) { /* ignore */ }
  }
  function clampInt(el, lo, hi) { let v = parseInt(el.value, 10); if (isNaN(v)) v = lo; v = Math.max(lo, Math.min(hi, v)); el.value = v; return v; }
  function updTier() {
    const d = parseInt($('s_diff').value, 10);
    $('l_tier').hidden = !(E && E.data.tz.herald.length && $('s_tz').checked && (d === 2 || d < 0));
  }
  function readSel() {
    updTier();
    const players = clampInt($('s_players'), 1, 8);
    const party = Math.min(clampInt($('s_party'), 1, 8), players);
    $('s_party').value = party;
    return {
      diff: parseInt($('s_diff').value, 10), players, party,
      mf: clampInt($('s_mf'), 0, 1000), tz: $('s_tz').checked, quest: $('s_quest').checked, clvl: clampInt($('s_clvl'), 1, 99),
      mode: E.mode, tier: parseInt($('s_tier').value, 10) || 0,   // 0 = all tiers (one herald row per tier)
      ladder: $('s_ladder').value === '1', act: parseInt($('s_act').value, 10),
    };
  }

  // ---------------- formatting ----------------
  /** Every probability is shown as odds: "1 in 4,334,276", "1 in 1.50" below 10, "always" at p >= 1, "-" for none. */
  function odds(p) {
    if (!(p > 0)) return '-';
    if (p >= 1) return 'always';
    const n = 1 / p;
    if (n < 10) return '1 in ' + n.toFixed(2);
    return '1 in ' + Math.round(n).toLocaleString('en-US');
  }
  function countFmt(n) { return n === null ? '-' : n.toLocaleString('en-US'); }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------- sortable table ----------------
  function makeTable(el, cols, defKey, defDir) {
    const st = { key: defKey, dir: defDir || -1, rows: [], limit: 300 };
    function render() {
      const vcols = cols.filter((c) => !c.show || c.show());
      const col = vcols.find((c) => c.k === st.key) || vcols[0];
      const rows = st.rows.slice().sort((a, b) => {
        const x = col.sort ? col.sort(a) : col.get(a), y = col.sort ? col.sort(b) : col.get(b);
        if (x < y) return -st.dir; if (x > y) return st.dir; return 0;
      });
      st.shownRows = rows;
      const shown = rows.slice(0, st.limit);
      let h = '<thead><tr>' + vcols.map((c) => '<th class="' + (c.l ? 'l' : '') + '" data-k="' + c.k + '"' + (c.note ? ' title="' + esc(c.note) + '"' : '') + '>' + esc(c.label) + (c.k === st.key ? (st.dir < 0 ? ' v' : ' ^') : '') + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of shown) h += '<tr' + (st.rowCls ? ' class="' + st.rowCls(r) + '"' : '') + '>' + vcols.map((c) => '<td class="' + (c.l ? 'l' : '') + '"' + (c.rtip ? ' title="' + esc(c.rtip(r)) + '"' : '') + '>' + (c.html ? c.html(r) : esc(c.fmt ? c.fmt(r) : c.get(r))) + '</td>').join('') + '</tr>';
      h += '</tbody>';
      el.innerHTML = h;
      return { total: rows.length, shown: shown.length };
    }
    el.addEventListener('click', (ev) => {
      const th = ev.target.closest('th'); if (!th) return;
      const k = th.dataset.k;
      if (st.key === k) st.dir = -st.dir; else { st.key = k; st.dir = -1; if (cols.find((c) => c.k === k).l) st.dir = 1; }
      st.onSort && st.onSort(render());
    });
    el.addEventListener('click', (ev) => {   // optional row click handler (st.onRow(row))
      const tr = ev.target.closest('tbody tr'); if (!tr || !st.onRow) return;
      st.onRow(st.shownRows[tr.sectionRowIndex]);
    });
    st.render = render;
    return st;
  }

  const HERALD_TIP = 'Drop table: monstats TreasureClassHerald(H), group-upgraded at mlvl + herald tier boost (group 41: Act N (H) Herald A-C).';
  const rankTag = (r) => r === 'regular' ? '' : r === 'herald' ? ' <span class="tag herald" title="' + esc(HERALD_TIP) + '">herald</span>' : ' <span class="tag ' + r + '">' + r + '</span>';
  const srcCols = [
    { k: 'name', label: 'Monster', l: 1, get: (r) => r.src.name, html: (r) => (r.src.members ? '<span title="' + esc(r.src.members.join(', ')) + '">' + esc(r.src.name) + '</span>' : esc(r.src.name)) + rankTag(r.src.rank) },
    { k: 'area', label: 'Area', l: 1, get: (r) => r.src.areaName, html: (r) => esc(r.src.areaName) + (r.src.tz ? ' <span class="tz">TZ</span>' : '') },
    { k: 'diff', label: 'Diff', l: 1, get: (r) => r.src.diff, fmt: (r) => DIFF[r.src.diff].slice(0, 2) + (r.src.diff == 1 ? 'm' : '') },
    { k: 'act', label: 'Act', get: (r) => r.src.act },
    { k: 'mlvl', label: 'mlvl', get: (r) => r.src.mlvl },
  ];

  // ---------------- autocomplete ----------------
  function autocomplete(input, ul, source, onPick) {
    let items = [], hi = -1;
    function show() {
      const q = input.value.trim().toLowerCase();
      if (!q) { ul.hidden = true; return; }
      const words = q.split(/\s+/);
      items = source().filter((x) => { const t = (x.search || x.label).toLowerCase(); return words.every((w) => t.indexOf(w) >= 0); })
        .sort((a, b) => (a.label.toLowerCase().startsWith(q) ? 0 : 1) - (b.label.toLowerCase().startsWith(q) ? 0 : 1)).slice(0, 40);
      ul.innerHTML = items.map((x, i) => '<li data-i="' + i + '">' + esc(x.label) + '</li>').join('');
      ul.hidden = !items.length; hi = -1;
    }
    function pick(i) { const x = items[i]; if (!x) return; input.value = x.label; ul.hidden = true; onPick(x); }
    input.addEventListener('input', show);
    input.addEventListener('focus', show);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { hi = Math.min(items.length - 1, hi + 1); }
      else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(hi < 0 ? 0 : hi); return; }
      else if (e.key === 'Escape') { ul.hidden = true; return; }
      else return;
      Array.from(ul.children).forEach((li, i) => li.classList.toggle('hi', i === hi));
      e.preventDefault();
    });
    ul.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) pick(+li.dataset.i); });
    document.addEventListener('click', (e) => { if (!ul.contains(e.target) && e.target !== input) ul.hidden = true; });
  }

  // ---------------- Tab 1 ----------------
  let target1 = null, T1 = null;
  const QNOTE = 'Herald rows are NOT adjusted for known-but-unquantified patch changes: 3.2 slightly reduced Unique/Set/Rare for heralds, 3.3 increased Rare+ for tiers 3+. Sizes unknown (CONFIG.heraldQualityAdj, default no-op).';
  const isSun = () => target1 && target1.kind === 'unique' && E.isSunder(target1.id);
  const isWhiteBase = () => target1 && target1.kind === 'base' && (E.items[target1.code].k === 'a' || E.items[target1.code].k === 'w') && !E.items[target1.code].an;
  const BQN = { white: 'white (low+normal+superior)', normsup: 'normal+superior', sup: 'superior only' };
  const showQB = () => $('qb1').checked, areaMode = () => $('g1').value === 'area';
  /** columns that are per-kill chances: while the table is sorted by one, "for 50%" counts kills instead of runs */
  const PERKILL = new Set(['ptar', 'pbase', 'plow', 'pnorm', 'psup', 'pmag', 'prare', 'pset', 'puni', 'sTable', 'sMf', 'sTotal']);
  const kills1 = () => PERKILL.has(T1.key);
  /** chance per run: kills/run x per-kill chance (rough); an area row carries the sum over its sources */
  const runP = (r) => r.runP !== undefined ? r.runP : r.c.target * r.src.perRun;
  const PCTS = [25, 50, 75, 90, 95, 99];
  const unit1 = () => kills1() ? 'kills' : 'runs';
  const per1 = (r) => kills1() ? r.c.target : runP(r);
  const srcLine = (p) => srcCols[0].html(p) + ' <span class="d">' + (p.src.herald ? 'n/a' : odds(runP(p)) + ' per run') + '</span>';
  const cols1 = [
    { k: 'name', get label() { return areaMode() ? 'Sources' : 'Monster'; }, l: 1, get: (r) => r.src.name,
      html: (r) => r.parts ? '<details class="mem"><summary>' + r.parts.length + ' source' + (r.parts.length > 1 ? 's' : '') + '</summary>' + r.parts.map((p) => '<div>' + srcLine(p) + '</div>').join('') + '</details>' : srcCols[0].html(r),
      rtip: (r) => r.parts ? r.parts.map((p) => p.src.name + ': ' + odds(runP(p)) + ' per run').join('\n') : '' },
    srcCols[1], srcCols[2],
    Object.assign({}, srcCols[3], { show: showQB }), Object.assign({}, srcCols[4], { show: showQB }),
    { k: 'sTable', show: isSun, label: 'Sunder: table path', note: 'Data-driven: the Sunder Charms TC inside desecrated champ/unique/boss TCs and the Herald Item TCs (herald tier gates the extra item picks), incl. player-count NoDrop.', get: (r) => r.sp ? r.sp.table : 0, fmt: (r) => odds(r.sp.table) },
    { k: 'sMf', show: isSun, label: 'Sunder: MF path', note: 'Data-driven: the PreCrafted Sunders are spawnable unique grand charms (rarity 1, lvl 75, DropConditionCalc Hell only), so a unique cm3 roll can pick one.', get: (r) => r.sp ? r.sp.mf : 0, fmt: (r) => odds(r.sp.mf) },
    { k: 'sTotal', show: isSun, label: 'Sunder: total', note: 'Combined chance of both paths.', get: (r) => r.sp ? r.sp.total : 0, fmt: (r) => odds(r.sp.total) },
    { k: 'pbase', show: showQB, label: 'P(base)', get: (r) => r.c.base, fmt: (r) => odds(r.c.base) },
    { k: 'plow', show: isWhiteBase, label: 'P(low)', note: 'Low quality (crude/cracked/damaged/low quality) base. Boss, champion and unique TCs force Magic=1024, so this is 0 there.', get: (r) => r.c.low, fmt: (r) => odds(r.c.low) },
    { k: 'pnorm', show: isWhiteBase, label: 'P(normal)', note: 'Normal quality base (what is left after unique/set/rare/magic/superior/low).', get: (r) => r.c.normal, fmt: (r) => odds(r.c.normal) },
    { k: 'psup', show: isWhiteBase, label: 'P(superior)', note: 'Superior quality base.', get: (r) => r.c.hq, fmt: (r) => odds(r.c.hq) },
    { k: 'pmag', show: showQB, note: QNOTE, label: 'P(magic)', get: (r) => r.c.magic, fmt: (r) => odds(r.c.magic) },
    { k: 'prare', show: showQB, note: QNOTE, label: 'P(rare)', get: (r) => r.c.rare, fmt: (r) => odds(r.c.rare) },
    { k: 'pset', show: showQB, note: QNOTE, label: 'P(set)', get: (r) => r.c.set, fmt: (r) => odds(r.c.set) },
    { k: 'puni', show: showQB, note: QNOTE, label: 'P(unique)', get: (r) => r.c.unique, fmt: (r) => odds(r.c.unique) },
    { k: 'ptar', label: 'Chance per kill', get note() { return 'Chance that one kill drops the target (shown as odds; sorts by probability).' + (areaMode() ? ' Area rows: the average over all kills of an area clear.' : ''); }, get: (r) => r.c.target, fmt: (r) => odds(r.c.target) },
    { k: 'runs', label: 'kills/run', get: (r) => r.src.perRun, fmt: (r) => r.src.herald ? 'n/a' : r.src.perRun < 10 ? r.src.perRun.toFixed(2) : r.src.perRun.toFixed(0) },
    { k: 'perrun', label: 'Chance per run', get note() { return 'Chance of finding the target in one run: kills/run x per-kill chance (rough model; shown as odds).' + (areaMode() ? ' Area rows add up the per-run chances of their sources (same linear model, capped at 1).' : ''); }, get: runP, fmt: (r) => odds(runP(r)) },
    { k: 'n50', get label() { return unit1() + ' for 50%'; }, get note() { return 'Number of ' + unit1() + ' needed to have found the target with 50% probability: ceil(ln(0.5) / ln(1-p)). Counts kills while the table is sorted by a per-kill column, runs otherwise. Hover a cell for 25/50/75/90/95/99%.'; },
      get: per1, fmt: (r) => countFmt(E.trialsFor(per1(r), 0.5)), rtip: (r) => PCTS.map((q) => q + '%: ' + countFmt(E.trialsFor(per1(r), q / 100)) + ' ' + unit1()).join('\n') },
  ];

  let srcCache = { sig: '', list: null };
  function getSources(sel) {
    const ctx = E.getCtx({ players: sel.players, party: sel.party, ladder: sel.ladder, tz: sel.tz, quest: sel.quest, clvl: sel.clvl, mf: sel.mf, tier: sel.tier });
    const sig = JSON.stringify([sel.quest, sel.tz, sel.clvl, sel.mode, sel.tier, sel.players, sel.party]);
    if (srcCache.sig !== sig) srcCache = { sig, list: E.areaSources(ctx) };   // champions / uniques / minions / heralds merged per area
    return { ctx, list: srcCache.list };
  }
  /** every source that can drop the target (no search filters), cached until the target or a game setting changes */
  let allCache = { sig: '' };
  function allRows(sel, ctx, list, bq) {
    const sig = JSON.stringify([target1.kind, target1.code || target1.id, srcCache.sig, sel.ladder, sel.mf, bq]);
    if (allCache.sig === sig) return allCache;
    const rows = [];
    for (const src of list) {
      const c = E.chanceFor(ctx, src, target1, sel.mf);
      if (bq) c.target = E.baseQualityChance(c, bq);
      if (c.target > 0) rows.push({ src, c, sp: undefined });
    }
    return (allCache = { sig, rows, maxMl: list.reduce((a, s) => Math.max(a, s.mlvl), 0) });
  }
  /** Group by area: one row per area / difficulty / terror-zone flag. Per-run chance = the SUM of the sources' per-run chances (matches how per-run is
   *  computed, kills/run x p, so it is additive; capped at 1). Per-kill values are kill-weighted averages. Herald rows (no per-run) are left out. */
  function groupAreas(rows) {
    const m = new Map();
    for (const r of rows) {
      if (r.src.herald || !(r.src.perRun > 0)) continue;
      const k = r.src.area + '|' + r.src.diff + '|' + (r.src.tz ? 1 : 0);
      (m.get(k) || m.set(k, []).get(k)).push(r);
    }
    const wavg = (parts, kills, get) => parts.reduce((a, r) => a + get(r) * r.src.perRun, 0) / kills;
    return Array.from(m.values()).map((parts) => {
      const s0 = parts[0].src, kills = parts.reduce((a, r) => a + r.src.perRun, 0);
      const p = Math.min(1, parts.reduce((a, r) => a + r.c.target * r.src.perRun, 0));
      const c = {}; for (const key in parts[0].c) c[key] = wavg(parts, kills, (r) => r.c[key]);
      c.target = p / kills;
      const sp = parts[0].sp ? { table: wavg(parts, kills, (r) => r.sp.table), mf: wavg(parts, kills, (r) => r.sp.mf), total: wavg(parts, kills, (r) => r.sp.total) } : null;
      parts.sort((x, y) => runP(y) - runP(x));
      return { src: { name: s0.areaName, areaName: s0.areaName, diff: s0.diff, act: s0.act, tz: s0.tz, rank: 'regular', mlvl: Math.max(...parts.map((r) => r.src.mlvl)), perRun: kills }, c, sp, runP: p, parts };
    });
  }
  const srcWhere = (src) => src.name + ' in ' + src.areaName + ' (' + DIFF[src.diff] + ')';
  const runsTxt = (p) => p >= 1 ? 'always' : odds(p) + ' runs';
  const lowest = (rows) => rows.reduce((a, r) => !a || r.src.mlvl < a.src.mlvl ? r : a, null);
  /** why nothing is listed: which filters exclude it (and what would work), else why no source can drop it at all. fails[i] = the filters row i fails. */
  function whyEmpty(all, fails, ctx, list, sel, it, bq) {
    const act = [];   // active filters: [id, text]
    if (sel.diff >= 0) act.push(['diff', 'Difficulty ' + DIFF[sel.diff]]);
    if (sel.act) act.push(['act', 'Act ' + sel.act]);
    if ($('r1').value) act.push(['rank', 'Rank ' + $('r1').value]);
    if (sel.tz) act.push(['tz', 'Terror zone']);
    if ($('f1').value.trim()) act.push(['text', 'Source filter "' + $('f1').value.trim() + '"']);
    const L = [];
    if (!all.rows.length) {
      const o = E.getCtx({ players: sel.players, party: sel.party, ladder: !sel.ladder, tz: sel.tz, quest: sel.quest, clvl: sel.clvl, mf: sel.mf, tier: sel.tier });
      const other = list.some((src) => { const c = E.chanceFor(o, src, target1, sel.mf); return (bq ? E.baseQualityChance(c, bq) : c.target) > 0; });
      if (other) L.push('With ' + (sel.ladder ? 'Ladder' : 'Non-ladder') + ' selected nothing drops it, but it does in ' + (sel.ladder ? 'Non-ladder' : 'Ladder') + ': it is ' + (sel.ladder ? 'non-ladder only' : 'ladder only') + ' (change Ladder under "Your game").');
      else if (bq) L.push('No source drops this base in the chosen base quality (' + BQN[bq] + ').');
      else if (it.q > all.maxMl) L.push('The base needs a monster level of at least ' + it.q + ' (qlvl) and the highest-level source here is mlvl ' + all.maxMl + '.');
      else L.push('No monster in the drop tables can drop it with these game settings (it may be a quest, cube or event item).');
      return L;
    }
    const part = [];
    for (const [id, txt] of act) {
      const ok = all.rows.filter((r, i) => fails[i].length === 1 && fails[i][0] === id);   // rows that only this filter excludes
      if (!ok.length) continue;
      const vals = (g) => Array.from(new Set(ok.map(g))).sort();
      part.push(id === 'diff' ? txt + ': it only drops in ' + vals((r) => r.src.diff).map((d) => DIFF[d]).join(' / ')
        : id === 'act' ? txt + ': it drops in act ' + vals((r) => r.src.act).join(', ')
        : id === 'rank' ? txt + ': it drops from ' + vals((r) => r.src.rank).join(', ') + ' only'
        : id === 'tz' ? 'Terror zone is on: untick it to see the ' + ok.length + ' sources outside terror zones'
        : txt + ' matches none of them; clear it to see ' + ok.length);
    }
    if (sel.diff >= 0) for (const [id, txt] of act) {   // another filter alone leaves sources, but not in the chosen difficulty
      if (id === 'diff' || id === 'text') continue;
      const ok = all.rows.filter((r, i) => fails[i].indexOf(id) < 0 && fails[i].indexOf('text') < 0);
      const ds = Array.from(new Set(ok.map((r) => r.src.diff))).sort();
      if (ok.length && ds.indexOf(sel.diff) < 0 && !part.some((x) => x.indexOf(txt) === 0)) part.push(txt + ': it drops there only in ' + ds.map((d) => DIFF[d]).join(' / '));
    }
    const low = lowest(all.rows);
    L.push('No source in ' + act.map((a) => a[1]).join(', ') + '; the lowest-level source is ' + srcWhere(low.src) + ' (mlvl ' + low.src.mlvl + ').');
    for (const x of part) L.push(x);
    if (!part.length) L.push('Several filters combine to exclude every source; loosen one of them.');
    return L;
  }

  function runTab1() {
    if (!target1) return;
    const sel = S = readSel(); saveSel();
    const t0 = performance.now();
    const { ctx, list } = getSources(sel);
    const f = $('f1').value.trim().toLowerCase(), rk = $('r1').value;
    $('l_bq1').hidden = !isWhiteBase();
    const bq = isWhiteBase() ? $('bq1').value : '';
    const all = allRows(sel, ctx, list, bq);
    const fails = all.rows.map((r) => {
      const src = r.src, x = [];
      if (sel.diff >= 0 && src.diff !== sel.diff) x.push('diff');
      if (sel.act && src.act !== sel.act) x.push('act');
      if (rk && src.rank !== rk) x.push('rank');
      if (sel.tz && !src.tz) x.push('tz');
      if (f && (src.name + ' ' + (src.members || []).join(' ') + ' ' + src.mon + ' ' + src.areaName).toLowerCase().indexOf(f) < 0) x.push('text');
      return x;
    });
    const mon = all.rows.filter((r, i) => !fails[i].length);
    if (isSun()) for (const r of mon) if (r.sp === undefined) r.sp = E.sunderPaths(ctx, r.src, target1.id, sel.mf);
    const rows = areaMode() ? groupAreas(mon) : mon;
    T1.rows = rows; T1.limit = parseInt($('n1').value, 10);
    const r = T1.render();
    const it = target1.kind === 'base' ? E.items[target1.code] : E.items[(target1.kind === 'unique' ? E.uniqById : E.setById)[target1.id].code];
    // headline: best per kill (monster rows), best per run (area rows in area mode, else monster rows)
    const best = (rs, g) => rs.reduce((a, x) => !a || g(x) > g(a) ? x : a, null);
    const bk = best(mon, (x) => x.c.target), br = best(areaMode() ? rows : mon.filter((x) => !x.src.herald), runP);
    let hl = '<b>' + esc(target1.label) + '</b>';
    if (bk) hl += ' &middot; best per kill: ' + esc(srcWhere(bk.src)) + ', <b>' + odds(bk.c.target) + '</b>';
    if (br && runP(br) > 0) hl += ' &middot; best per run: ' + esc(areaMode() ? br.src.areaName + ' (' + DIFF[br.src.diff] + ')' : srcWhere(br.src)) + ', <b>' + runsTxt(runP(br)) + '</b>, ~' + countFmt(E.trialsFor(runP(br), 0.5)) + ' runs for 50% / ~' + countFmt(E.trialsFor(runP(br), 0.9)) + ' for 90%';
    $('hl1').innerHTML = hl;
    const lo = lowest(all.rows);
    $('low1').textContent = lo ? 'Lowest-level source: monster level ' + lo.src.mlvl + ' (' + srcWhere(lo.src) + '); base qlvl ' + it.q + '.' : 'No source can drop it with these game settings; base qlvl ' + it.q + '.';
    $('head1').hidden = false;
    $('bld1').hidden = !(target1.kind === 'base' && TYPEOPTS.some((o) => o.kind === 'base' && o.code === target1.code));
    const why = $('why1');
    if (rows.length) why.hidden = true;
    else {
      const lines = mon.length ? ['Every matching source is a herald (no per-run chance) or has no kills per run, so there are no area rows. Group by Monster to see them.'] : whyEmpty(all, fails, ctx, list, sel, it, bq);
      why.innerHTML = '<b>Nothing to list.</b><ul class="why">' + lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>';
      why.hidden = false;
    }
    $('info1').textContent = 'base qlvl ' + it.q + '  |  ' + r.total.toLocaleString() + ' ' + (areaMode() ? 'areas' : 'sources') + ' can drop it (showing ' + r.shown + ')  |  N=' + ctx.N +
      '  MF=' + sel.mf + '%' + (sel.quest ? '  |  quest drop (act bosses)' : '') + (bq ? '  |  base quality: ' + BQN[bq] : '') + '  |  ' + Math.round(performance.now() - t0) + ' ms. Click a column header to sort.';
  }

  // ---------------- Tab 2: item builder ----------------
  // State: bd.type (type or single base option), bd.codes (bases in play), bd.stats (stat key -> range over all tiers), bd.sel (picked stats with thresholds).
  // All rules live in engine.js (builder*, comboAnalysis, affixSearch); this only presents them.
  const CLASSN = { ama: 'Amazon', bar: 'Barbarian', nec: 'Necromancer', pal: 'Paladin', sor: 'Sorceress', ass: 'Assassin', dru: 'Druid', war: 'Warlock' };
  const QN = { low: 'Low quality', normal: 'Normal', sup: 'Superior', magic: 'Magic', rare: 'Rare' };
  const QS_ALL = ['low', 'normal', 'sup', 'magic', 'rare'], QAB = { low: 'L', normal: 'N', sup: 'S', magic: 'M', rare: 'R' };
  const QCOLN = { low: 'low quality', normal: 'normal', sup: 'superior', magic: 'magic', rare: 'rare' };
  /** qualities the builder considers: the forced one, else all five */
  const wantQ = () => ($('ql2').value ? [$('ql2').value] : QS_ALL);
  /** qualities that get an odds column in the affix table: the forced one, else normal / superior / magic / rare (low is the normal column minus sockets and ethereal) */
  const oddsQ = () => ($('ql2').value ? [$('ql2').value] : ['normal', 'sup', 'magic', 'rare']);
  /** difficulty for the structural checks (sockets of white items depend on it): the global selector, Hell when it says all */
  const selDiff = () => { const d = parseInt($('s_diff').value, 10); return d >= 0 ? d : 2; };
  let T2 = null, TA = null, TYPEOPTS = [];
  let bd = { type: null, codes: [], stats: new Map(), sel: [], picks: [], rows: [], an: null, farm: null, farmQ: [], wts: null, wlabel: '' };
  let tableWorker = null, farmWorker = null, tableId = 0, farmId = 0;
  /** remember a checkbox in localStorage (try/catch: storage can be blocked) */
  const lsGet = (k) => { try { return localStorage.getItem(k) === '1'; } catch (e) { return false; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) { /* ignore */ } };
  const showOdds = () => $('odds2').checked;

  const cols2 = srcCols.concat(QS_ALL.map((q) => ({ k: 'p' + q, label: 'P(' + (q === 'sup' ? 'superior' : q === 'low' ? 'low' : q) + ')', show: () => bd.farmQ.indexOf(q) >= 0,
    note: 'Chance per kill of a ' + QCOLN[q].toUpperCase() + ' item of the type with the combination (' + (q === 'rare' ? 'Monte Carlo' : 'exact') + ').', get: (r) => r.pq[q] || 0, fmt: (r) => odds(r.pq[q] || 0) })), [
    { k: 'ptot', label: 'P per kill', note: 'Chance that one kill drops a matching item (sum over every base of the type and the possible qualities; shown as odds, sorts by probability).', get: (r) => r.pTotal, fmt: (r) => odds(r.pTotal) },
    { k: 'runs', label: 'kills/run', get: (r) => r.src.perRun, fmt: (r) => r.src.herald ? 'n/a' : r.src.perRun < 10 ? r.src.perRun.toFixed(2) : r.src.perRun.toFixed(0) },
    { k: 'perrun', label: 'P per run', note: 'Chance of a matching item in one run (rough model; shown as odds).', get: (r) => r.perRun, fmt: (r) => odds(r.perRun) },
    { k: 'go1', label: 'Tab 1', note: 'Open tab 1 filtered to this monster / area (with the base as the target when the builder has a single base)', get: () => 0, html: () => '<a href="#" class="go1">search</a>' },
  ]);
  const typeLabel = (t) => t.name + (t.cls ? ' (' + (CLASSN[t.cls] || t.cls) + ')' : '') + (t.broad ? ' - broad group' : '') + ' - ' + t.codes.length + ' bases';
  const effTier = () => parseInt($('tr2').value, 10);
  const effIlvl = () => { const v = clampInt($('il2'), 1, 99); $('ilr2').value = v; return v; };
  function curCodes() {
    if (!bd.type) return [];
    return bd.type.kind === 'base' ? [bd.type.code] : E.builderBases(bd.type.code, effTier());
  }
  const baseName = (c) => E.items[c].n;
  const tierName = (c) => ['', 'exceptional', 'elite'][E.items[c].tier] || '';
  const condsOf = () => bd.sel.map((s) => { const st = bd.stats.get(s.key); return st && st.le ? { key: s.key, min: s.thr, le: true } : { key: s.key, min: s.thr }; });
  const statText = (s) => { const st = bd.stats.get(s.key); return E.describeAt(s.key, s.thr, st && st.v) + (st && st.flag ? '' : st && st.le ? '  (or lower)' : '  (or more)'); };

  function pctx() {
    const sel = S = readSel();
    return { sel, ctxS: { players: sel.players, party: sel.party, ladder: sel.ladder, tz: sel.tz, quest: sel.quest, clvl: sel.clvl, mf: sel.mf, tier: sel.tier } };
  }
  /** a fresh worker; null when Workers are unavailable (the work then runs on the main thread) */
  function newWorker() {
    if (new URLSearchParams(location.search).has('noworker')) return null;
    try { const w = new Worker('worker.js'); w.onerror = () => {}; return w; } catch (e) { return null; }
  }
  /** run a job on a dedicated worker, replacing (terminating) one that is still busy with a stale request */
  function runJob(kind, msg, onProgress, onDone, fallback) {
    const id = kind === 'farm' ? ++farmId : ++tableId;
    let w = kind === 'farm' ? farmWorker : tableWorker;
    if (w && w.busy) { w.terminate(); w = null; }
    if (!w) w = newWorker();
    if (kind === 'farm') farmWorker = w; else tableWorker = w;
    if (!w) { setTimeout(() => { if (id === (kind === 'farm' ? farmId : tableId)) onDone(fallback()); }, 20); return id; }
    w.busy = true;
    w.onmessage = (ev) => {
      const m = ev.data; if (m.id !== id) return;
      if (m.type === 'progress') onProgress && onProgress(m.done / m.total);
      else { w.busy = false; if (m.type === 'result') onDone(m.rows, null, m); else onDone(null, m.message); }
    };
    w.postMessage(Object.assign({ id, file: DATAFILE[E.mode] }, msg));
    return id;
  }

  // ----- the affix table (every prefix / suffix / automagic row / staff skill that can roll on the type) -----
  const POIS_TIP = 'Poison damage is the total the item tooltip shows (per-frame value x frames / 256). Poison from several sources adds the damage per frame, but the lengths are summed and divided by the number of poison sources when you hit (LoD 1.10-1.14 decompilation), so with two sources you get (sum of both per-frame values) x (half the summed length), usually well below the summed tooltip total.';
  const sideTag = (r) => '<span class="side ' + r.side + '">' + r.side + '</span>';
  const lvWindow = (r) => r.minIl === null ? '-' : r.maxIl >= 99 ? 'from ilvl ' + r.minIl : 'ilvl ' + r.minIl + ' to ' + r.maxIl;
  const colsA = [
    { k: 'name', label: 'Name', l: 1, get: (r) => r.name.toLowerCase(), html: (r) => esc(r.name) + ' ' + sideTag(r) + (pickIds().has(r.id) ? ' <span class="picked-tag">picked</span>' : fitOf(r) ? '' : ' <span class="nofit-tag">doesn\'t fit</span>') },
    { k: 'desc', label: 'Description (all tiers)', l: 1, get: (r) => r.desc.toLowerCase(), html: (r) => r.desc.indexOf('poison damage over') >= 0 ? '<span title="' + esc(POIS_TIP) + '">' + esc(r.desc) + '</span>' : esc(r.desc) },
    { k: 'il', label: 'Can roll at', note: 'Item levels at which some base of the type can roll this affix: "from ilvl 18" or a window "ilvl 24 to 35" (affix max level, staff skill tiers).', get: (r) => r.minIl === null ? 999 : r.minIl, fmt: lvWindow },
    { k: 'lvl', label: 'Affix lvl', note: 'Affix level. Staff skills have a tier instead.', get: (r) => r.lvl === null ? r.tier : r.lvl, fmt: (r) => r.lvl === null ? (r.tier ? 'tier ' + r.tier : '-') : r.lvl },
    { k: 'lr', label: 'Req lvl', note: 'Character level the affix requires (levelreq).', get: (r) => r.lr === null ? 0 : r.lr, fmt: (r) => r.lr === null ? '-' : r.lr },
    { k: 'cls', label: 'Class', l: 1, get: (r) => r.cls, fmt: (r) => r.cls ? (CLASSN[r.cls] || r.cls) + ' only' : '' },
    { k: 'grp', label: 'Excludes', l: 1, note: 'Affixes of the same group never appear together on one item. The group is named after its first stat.', get: (r) => r.groupName, fmt: (r) => r.g ? r.groupName : '' },
    { k: 'qual', label: 'Quality', l: 1, note: 'Qualities the row can occur on: L low quality, N normal, S superior, M magic, R rare.', get: (r) => r.quals.length * 10 + (r.rare ? 1 : 0), fmt: (r) => r.quals.map((q) => QAB[q]).join(' ') },
  ].concat(QS_ALL.map((q) => ({ k: 'o' + q, show: () => showOdds() && oddsQ().indexOf(q) >= 0, get label() { return 'Odds (' + QCOLN[q] + ', ' + (bd.wts ? 'weighted' : 'avg') + ')'; },
    get note() { return 'Chance that a ' + QCOLN[q] + ' item of the type carries this ' + (q === 'rare' ? 'at the item level above. Monte Carlo (noise on rare affixes is a few percent of the value). ' : 'at the item level above. Exact. ') + avgNote() + ' Hover a cell for the per-base odds.'; },
    get: (r) => (r.ap && r.ap[q]) || 0, fmt: (r) => odds((r.ap && r.ap[q]) || 0), tip: (r) => oddsTip(r, q) })));
  /** how the odds columns were averaged over the bases (plain average, or weighted by drop rate in the chosen area / monster) */
  function avgNote() {
    return bd.wts ? 'Weighted by drop rate in ' + bd.wlabel + ': each base counts with its share of the type\'s drops there (global difficulty, players, terror zone and mode apply); bases that cannot drop there count 0.'
      : 'Average over the ' + bd.codes.length + ' base' + (bd.codes.length === 1 ? '' : 's') + ' of the selection (each base counted equally; a base that cannot roll the affix counts 0).';
  }
  /** hover text of an odds cell: the odds on each base (and its weight in weighted mode), best first */
  function oddsTip(r, q) {
    const arr = r.pb && r.pb.q && r.pb.q[q];
    if (!arr) return 'This row cannot occur on a ' + QCOLN[q] + ' item.';
    const L = bd.codes.map((c, i) => ({ n: baseName(c), p: arr[i], w: bd.wts ? bd.wts[i] : 0 }));
    L.sort((a, b) => (b.p - a.p) || a.n.localeCompare(b.n));
    const MAXL = 30;
    const out = [bd.wts ? 'Per base: odds (weight = share of the type\'s drops in ' + bd.wlabel + ')' : 'Per base (each counted equally): odds'];
    for (const x of L.slice(0, MAXL)) out.push(x.n + ': ' + odds(x.p) + (bd.wts ? '  (weight ' + (100 * x.w).toFixed(x.w > 0 && x.w < 0.01 ? 2 : 1) + '%)' : ''));
    if (L.length > MAXL) out.push('... and ' + (L.length - MAXL) + ' more');
    return out.join('\n');
  }

  function filterRows() {
    const f = $('f2').value.trim().toLowerCase().split(/\s+/).filter(Boolean), sd = $('sd2').value, av = $('av2').checked;
    const wq = wantQ(), hf = $('hf2').checked, ids = pickIds();
    fitSync(); nofitHidden = 0;
    return bd.rows.filter((r) => (!sd || r.side === sd) && (!av || r.avail) && r.quals.some((q) => wq.indexOf(q) >= 0) &&
      f.every((w) => (r.name + ' ' + r.desc + ' ' + r.side + ' ' + (r.cls ? (CLASSN[r.cls] || r.cls) + ' only' : '') + ' ' + r.groupName).toLowerCase().indexOf(w) >= 0) && (!hf || ids.has(r.id) || fitOf(r) || (nofitHidden++, false)));
  }
  function renderTable() {
    if (!showOdds() && TA.key.charAt(0) === 'o') { TA.key = 'il'; TA.dir = 1; }
    TA.rows = filterRows();
    const r = TA.render();
    $('tinfo2').textContent = bd.codes.length ? r.total + ' of ' + bd.rows.length + ' affixes (showing ' + r.shown + ')' + (nofitHidden ? '; ' + nofitHidden + ' hidden because they do not fit your picks' : '') + (showOdds() ? '; odds at item level ' + effIlvl() + ', ' : '. ') +
      (!showOdds() ? '' : bd.wts ? (bd.wts.some((w) => w > 0) ? 'weighted by drop rate in ' + bd.wlabel + ' (bases that cannot drop there count 0)' : 'no base of the selection drops in ' + bd.wlabel + ' with the current selectors, so every odds figure is "-"')
        : 'average over the ' + bd.codes.length + ' base' + (bd.codes.length === 1 ? '' : 's') + ' of the selection (each base counted equally)') +
      (showOdds() ? '. Hover an odds cell for the per-base odds.' : '') + ' Click a row to add or remove it. Dimmed rows cannot roll at the item level set under Advanced; rows marked "doesn\'t fit" cannot be combined with your picks (hover for why).' : '';
  }
  /** weighting request for the affix table: null (plain average) unless an area is chosen */
  function weightOpts(sel) {
    const area = parseInt($('ar2').value || '0', 10);
    if (!area) return null;
    return { diff: sel.diff, act: sel.act, area, srcKey: $('mo2').value || '', tz: sel.tz };
  }
  function weightLabel() {
    const a = $('ar2'), m = $('mo2');
    return (a.selectedOptions[0] ? a.selectedOptions[0].textContent.replace(/^Act \d+ - /, '') : 'the area') + (m.value ? ' (' + m.selectedOptions[0].textContent + ')' : '');
  }
  /** monsters / sources of the chosen area under the global selectors, for the Monster selector */
  function fillMonsters() {
    const mo = $('mo2'), area = parseInt($('ar2').value || '0', 10), cur = mo.value;
    mo.disabled = !area;
    if (!area) { mo.innerHTML = '<option value="">All sources</option>'; return; }
    const sel = readSel(), { list } = getSources(sel);
    const rows = list.filter((s) => s.area === area && (sel.diff < 0 || s.diff === sel.diff) && (!sel.act || s.act === sel.act) && (!sel.tz || s.tz) && !s.herald);
    mo.innerHTML = '<option value="">All sources in the area</option>' + rows.map((s) => '<option value="' + esc(s.key) + '">' + esc(s.name) + (s.rank === 'regular' || s.members ? '' : ' (' + s.rank + ')') + (sel.diff < 0 ? ' - ' + DIFF[s.diff] : '') + '</option>').join('');
    if (rows.some((s) => s.key === cur)) mo.value = cur;
  }
  function requestTable() {
    if (!bd.codes.length) { bd.rows = []; renderTable(); return; }
    const ilvl = effIlvl(), codes = bd.codes.slice(), quals = oddsQ(), diff = selDiff();
    const rolls = Math.min(parseInt($('mc2').value, 10), Math.max(4000, Math.floor(1000000 / codes.length)));
    $('tinfo2').textContent = 'Computing affix odds...';
    const { sel, ctxS } = pctx(), wopts = weightOpts(sel), wlabel = wopts ? weightLabel() : '';
    const local = () => {   // no worker: the same computation on the main thread
      if (!wopts) return E.builderAffixTable(codes, ilvl, { rolls, qualities: quals, diff });
      const w = E.baseDropWeights(E.getCtx(ctxS), codes, wopts), rows = E.builderAffixTable(codes, ilvl, { rolls, qualities: quals, diff, weights: w, rare: codes.some((c) => w.get(c) > 0) });
      rows.wts = codes.map((c) => w.get(c) || 0); return rows;
    };
    runJob('table', { type: 'table', codes, ilvl, rolls, ctx: ctxS, wopts, qualities: quals, diff }, null, (rows, err, m) => {
      if (!rows) { $('tinfo2').textContent = 'Error: ' + err; return; }
      bd.rows = rows; bd.wts = wopts ? (m ? m.wts : rows.wts) : null; bd.wlabel = wlabel;
      renderTable();
    }, local);
  }

  // ----- which affix rows still fit the picks (E.fitsCombo: the structural test of feasibleAny, microseconds per base) -----
  let fitIdx = null, fitSig = '', fitCache = new Map(), whyCache = new Map(), nofitHidden = 0;
  const pickIds = () => new Set(bd.picks.map((p) => p.id));
  const fitIndex = () => (fitIdx && fitIdx.codes === bd.codes ? fitIdx : (fitIdx = E.fitIndex(bd.codes)));
  /** the combination a row would add to the picks: its stats at the weakest threshold (min for ge, max for le); a stat already picked keeps the stricter one */
  function rowConds(r) {
    const cs = condsOf();
    for (const m of r.mods) {
      const st = bd.stats.get(m.key); if (!st) continue;
      const v = st.le ? m.max : m.min, i = cs.findIndex((c) => c.key === m.key);
      if (i < 0) cs.push(st.le ? { key: m.key, min: v, le: true } : { key: m.key, min: v });
      else cs[i] = Object.assign({}, cs[i], { min: st.le ? Math.min(cs[i].min, v) : Math.max(cs[i].min, v) });
    }
    return cs;
  }
  /** drop the cached fits when the picks, thresholds, quality or difficulty changed */
  function fitSync() {
    const sig = JSON.stringify([condsOf(), wantQ(), selDiff()]);
    if (sig !== fitSig) { fitSig = sig; fitCache = new Map(); whyCache = new Map(); }
  }
  /** does the row fit the current picks on some base at some item level (and quality)? Always true with no picks */
  function fitOf(r) {
    if (!bd.sel.length) return true;
    let v = fitCache.get(r.id);
    if (v === undefined) { v = E.fitsCombo(fitIndex(), rowConds(r), wantQ(), selDiff()); fitCache.set(r.id, v); }
    return v;
  }
  /** why a row does not fit: E.explainCombo for the wanted qualities (the qualities the row can occur on first, magic and rare before the white ones). Computed on hover: it sweeps every item level */
  function noFitWhy(r) {
    fitSync();
    let w = whyCache.get(r.id);
    if (!w) {
      const cs = rowConds(r), wq = wantQ(), pick = (L) => L.filter((q) => wq.indexOf(q) >= 0);
      const mine = pick(['magic', 'rare', 'sup', 'normal', 'low']).filter((q) => r.quals.indexOf(q) >= 0), qs = mine.length ? mine.slice(0, 2) : pick(['magic', 'rare']).length ? pick(['magic', 'rare']) : pick(['sup', 'normal', 'low']).slice(0, 1);
      const ex = qs.map((q) => [q, E.explainCombo(bd.codes, cs, q, selDiff())]), real = ex.filter((x) => !/is not possible for this type/.test(x[1][0]));
      const use = real.length ? real : ex.slice(0, 1);
      w = "Doesn't fit with your picks: " + use.map((x) => (use.length > 1 ? QN[x[0]] + ': ' : '') + x[1].join(' ')).join(' ');
      whyCache.set(r.id, w);
    }
    return w;
  }
  let fitTimer = null;
  /** re-mark the table rows: at once after a pick is added / removed, debounced while a slider moves */
  function refit(now) {
    clearTimeout(fitTimer);
    if (!bd.rows.length) return;
    if (now) renderTable(); else fitTimer = setTimeout(renderTable, 250);
  }

  // ----- picked affixes (bd.picks: {id, name, side, keys}) and their stats (bd.sel) -----
  /** the pick a stat belongs to; null when no pick has it (deep link) or several do */
  const pickOf = (key) => { const ps = bd.picks.filter((p) => p.keys.indexOf(key) >= 0); return ps.length === 1 ? ps[0] : null; };
  const pickFromRow = (r) => ({ id: r.id, name: r.name, side: r.side, keys: r.mods.map((m) => m.key).filter((k) => bd.stats.has(k)) });
  function removePick(id) {
    const i = bd.picks.findIndex((p) => p.id === id); if (i < 0) return;
    const [p] = bd.picks.splice(i, 1);
    bd.sel = bd.sel.filter((s) => p.keys.indexOf(s.key) < 0 || bd.picks.some((q) => q.keys.indexOf(s.key) >= 0));
    updateRanges(); renderSel(); refit(true); changed();
  }
  function removeStat(i) {
    const [s] = bd.sel.splice(i, 1);
    for (const p of bd.picks) p.keys = p.keys.filter((k) => k !== s.key);
    bd.picks = bd.picks.filter((p) => p.keys.length);
    updateRanges(); renderSel(); refit(true); changed();
  }
  /** "Prefixes 1 (magic max 1, rare max 3) - Suffixes 0 (...)": picked prefixes / suffixes against the limits of the chosen quality (Auto shows both) */
  function slotLine() {
    const C = E.CONFIG, np = bd.picks.filter((p) => p.side === 'prefix').length, ns = bd.picks.filter((p) => p.side === 'suffix').length, f = $('ql2').value;
    const rmax = C.rareMaxPerSide, tot = Math.max.apply(null, C.rareAffixCounts), lim = f === 'magic' ? 1 : rmax;
    if (f && f !== 'magic' && f !== 'rare') return 'No prefixes or suffixes at this quality (only sockets, ethereal, the superior bonus and automagic rows).';
    const part = (n, one, many) => f ? one + ' ' + n + '/' + lim : many + ' ' + n + ' (magic max 1, rare max ' + rmax + ')';
    return '<span class="' + (np > lim || ns > lim ? 'bad' : '') + '">' + part(np, 'Prefix', 'Prefixes') + ' &middot; ' + part(ns, 'Suffix', 'Suffixes') + (f === 'magic' ? '' : ' &middot; a rare has ' + tot + ' affixes at most') + '</span>';
  }

  // ----- selected stats with sliders -----
  /** slider range of a picked stat: what is achievable with the other picked stats (s.lo / s.hi, set by updateRanges), else the catalogue range */
  const rngOf = (s) => { const st = bd.stats.get(s.key); return { lo: s.lo !== undefined ? s.lo : st.min, hi: s.hi !== undefined ? s.hi : st.max }; };
  const rngNote = (s) => { const st = bd.stats.get(s.key), r = rngOf(s); return r.lo + ' to ' + r.hi + (st.what ? ' ' + st.what : ''); };
  /** per picked stat: range achievable while the others hold (E.statRange); clamps the thresholds into it */
  function updateRanges() {
    const cs = condsOf(), o = { qualities: wantQ(), diff: selDiff() };
    bd.sel.forEach((s, i) => {
      const st = bd.stats.get(s.key); if (st.flag) return;
      const r = E.statRange(bd.codes, cs, i, o);
      s.lo = r.min; s.hi = r.max; s.thr = Math.max(s.lo, Math.min(s.hi, s.thr));
    });
  }
  /** after a threshold moved: refresh the other rows in place (range, value, text) without re-rendering the box */
  function syncRows(j) {
    updateRanges();
    for (const row of $('sel2').querySelectorAll('.selrow')) {
      const i = +row.dataset.i, s = bd.sel[i], st = bd.stats.get(s.key); if (i === j || st.flag) continue;
      const r = rngOf(s);
      for (const inp of row.querySelectorAll('.thr, .thrr')) { inp.min = r.lo; inp.max = r.hi; inp.value = s.thr; }
      row.querySelector('.note').textContent = rngNote(s);
      row.querySelector('.nm span').textContent = statText(s);
    }
  }
  function addStat(key, thr) {
    const st = bd.stats.get(key); if (!st) return false;
    let e = bd.sel.find((s) => s.key === key);
    if (!e) { e = { key, thr: 0 }; bd.sel.push(e); }
    if (thr === undefined || isNaN(thr)) thr = st.le ? st.max : st.min;
    e.thr = Math.max(st.min, Math.min(st.max, thr));
    updateRanges();
    return true;
  }
  /** the item card: base and quality, the slot counter, then one block per picked affix with the sliders of its stats; stats no pick owns go under "Other stats" */
  function renderSel() {
    const box = $('sel2');
    if (!bd.type) { box.className = 'note'; box.textContent = 'Pick an item type or base first.'; return; }
    box.className = '';
    const row = (s, i) => {
      const st = bd.stats.get(s.key), r = rngOf(s);
      return '<div class="selrow" data-i="' + i + '"><div class="nm"><span>' + esc(statText(s)) + '</span><button class="rm" title="remove this stat">x</button></div>' + (st.flag ? '' :
        '<div class="ctl"><span>' + (st.le ? '&lt;=' : '&gt;=') + '</span><input type="number" class="thr" value="' + s.thr + '" min="' + r.lo + '" max="' + r.hi + '">' +
        '<input type="range" class="thrr" min="' + r.lo + '" max="' + r.hi + '" step="1" value="' + s.thr + '"><small class="note">' + rngNote(s) + '</small></div>') + '</div>';
    };
    const own = new Set(), blocks = bd.picks.map((p) => {
      const mine = []; bd.sel.forEach((s, i) => { if (pickOf(s.key) === p) { mine.push(row(s, i)); own.add(i); } });
      return '<div class="pk"><div class="pkh"><span><b>' + esc(p.name) + '</b> ' + sideTag(p) + '</span><button class="rmp" data-id="' + esc(p.id) + '" title="remove this affix and its stats">remove</button></div>' +
        (mine.join('') || '<div class="note">its stats are also picked by another affix (see below)</div>') + '</div>';
    });
    const other = bd.sel.map((s, i) => own.has(i) ? '' : row(s, i)).join('');
    if (other) blocks.push('<div class="pk"><div class="pkh"><b>Other stats</b></div>' + other + '</div>');
    const q = $('ql2').value;
    box.innerHTML = '<div class="card"><div class="chd"><b>' + esc(bd.type.name) + '</b><span>' + (q ? QN[q] : 'Any quality') + '</span></div><div class="slots">' + slotLine() + '</div>' +
      (blocks.join('') || '<div class="note">Click an affix in the table to add it. Each of its stats gets a minimum value you can move with the slider.</div>') + '</div>';
  }
  let anTimer = null, farmTimer = null;
  function changed(opt) {
    opt = opt || {};
    syncUrl();
    clearTimeout(anTimer); anTimer = setTimeout(updateAnalysis, 120);
    clearTimeout(farmTimer);
    if (opt.noFarm) return;
    bd.farm = null;
    farmTimer = setTimeout(runFarm, 900);
  }

  // ----- results: item levels / character level / conflicts (cheap, main thread) -----
  const ilTxt = (lo, hi) => hi >= 99 ? lo + '+' : lo + ' to ' + hi;
  function updateAnalysis() {
    clearTimeout(anTimer);
    const res = $('res2');
    bd.an = null; bd.farmQ = [];
    if (!bd.codes.length) { res.innerHTML = '<div class="note">No bases for this type / tier.</div>'; return; }
    if (!bd.sel.length) { res.innerHTML = '<div class="note">Select at least one affix to see the item levels and farm sources.</div>'; T2.rows = []; T2.render(); $('finfo2').textContent = ''; return; }
    const an = bd.an = E.comboAnalysis(bd.codes, condsOf(), { diff: selDiff() });
    const forced = $('ql2').value, qs = wantQ();
    bd.farmQ = qs.filter((q) => an[q].ok);
    // conflicts / quality decision
    const msgs = [], feas = QS_ALL.filter((q) => an[q].ok);
    const list = (qq) => qq.map((q) => QCOLN[q]).join(', ').replace(/, ([^,]*)$/, ' and $1');
    if (!feas.length) for (const q of qs) msgs.push('<div class="bad"><b>' + QN[q] + ' not possible:</b> ' + an[q].why.map(esc).join(' ') + '</div>');
    else {
      for (const q of ['magic', 'rare']) if (!an[q].ok && (qs.indexOf(q) >= 0)) msgs.push('<div class="bad"><b>' + QN[q] + ' not possible:</b> ' + an[q].why.map(esc).join(' ') + '</div>');
      msgs.push('<div class="good">Possible as ' + (feas.length === 1 ? 'a ' + QCOLN[feas[0]] + ' item only' : 'a ' + list(feas) + ' item') + '.</div>');
    }
    if (forced && !an[forced].ok && feas.length) msgs.push('<div class="bad">Quality is restricted to ' + QCOLN[forced] + '; set it to Auto to use ' + list(feas) + '.</div>');
    if (feas.some((q) => q === 'normal' || q === 'sup') && condsOf().some((c) => c.key === E.SOCK_KEY) && $('s_diff').value === '-1') msgs.push('<div class="note">Sockets of normal / superior items: levels shown for Hell (the difficulty selector says All); up to 3 sockets in Normal, 4 in Nightmare, 6 in Hell.</div>');
    // results panel
    const mr = (q) => q === 'magic' || q === 'rare';
    const shown = QS_ALL.filter((q) => forced ? (q === forced || (mr(forced) && mr(q))) : (an[q].ok || mr(q))), okq = shown.filter((q) => an[q].ok);
    const rows = [];
    for (const q of shown) {
      const a = an[q];
      if (!a.ok) { rows.push('<tr><td class="l">' + QN[q] + '</td><td colspan="3" class="l bad">not possible</td></tr>'); continue; }
      rows.push('<tr><td class="l">' + QN[q] + '</td><td>' + a.minIl + ' <small>(' + esc(baseName(a.minIlCode)) + ')</small></td><td>' + (a.maxIl < 99 ? ilTxt(a.minIl, a.maxIl) : a.minIl + '+') + '</td><td>' + a.reqLv + ' <small>(' + esc(baseName(a.reqCode)) + ', item level ' + a.reqIl + ')</small></td></tr>');
    }
    const pq = okq.length ? okq : ['magic', 'rare'];
    const first = (x) => Math.min.apply(null, pq.map((q) => x[q].minIl || 999));
    const perRows = bd.codes.map((c) => { const o = { c }; for (const q of pq) o[q] = an[q].per.find((x) => x.code === c); return o; })
      .sort((x, y) => (first(x) - first(y)) || E.items[x.c].q - E.items[y.c].q);
    const cell = (x) => x.ok ? ilTxt(x.minIl, x.maxIl) : '-';
    const rl = (x) => x.ok ? x.reqLv : '-';
    res.innerHTML = '<div id="head2" class="head"></div>' + msgs.join('') + '<details open><summary>Item levels, required level and per-base details</summary><div class="tbl"><table><thead><tr><th class="l">Quality</th><th title="Lowest item level at which some base of the type can roll the whole combination">Lowest item level</th><th title="Item levels that work (a window with an upper bound exists when staff skills are involved: their tier depends on the item level)">Item level window</th><th class="l" title="max(base requirement, requirements of the cheapest affix tiers that satisfy the sliders)">Required character level</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
      '<details><summary>Per base (' + bd.codes.length + ')</summary><div class="tbl small"><table id="tbbase"><thead><tr><th class="l">Base</th><th>qlvl</th><th class="l">Tier</th>' + pq.map((q) => '<th>' + QN[q] + ': item level</th><th>' + QN[q] + ': req lvl</th>').join('') + '<th title="Share of the best farm source (per kill) that comes from this base">Best source: share</th></tr></thead><tbody>' +
      perRows.map((x) => '<tr data-c="' + x.c + '"><td class="l">' + esc(baseName(x.c)) + '</td><td>' + E.items[x.c].q + '</td><td class="l">' + tierName(x.c) + '</td>' + pq.map((q) => '<td>' + cell(x[q]) + '</td><td>' + rl(x[q]) + '</td>').join('') + '<td class="sh">-</td></tr>').join('') +
      '</tbody></table></div></details></details>';
    renderHead();
    if (!bd.farmQ.length) { T2.rows = []; T2.render(); $('finfo2').textContent = ''; }
    showShares();
  }
  /** why no wanted quality works: the explanation of the most permissive one (rare, then magic, ...) */
  const whyNot = (an) => { const q = ['rare', 'magic', 'sup', 'normal', 'low'].filter((x) => wantQ().indexOf(x) >= 0 && an[x].why.length && !/is not possible for this type/.test(an[x].why[0]))[0] || wantQ()[0]; return an[q].why; };
  const killsTxt = (p) => { const o = odds(p); return o.slice(0, 4) === '1 in' ? o + ' kills' : o === 'always' ? 'every kill' : o; };
  /** the one-sentence answer above the tables: quality and type, item level, character level, best farm source (or why it is impossible) */
  function renderHead() {
    const h = $('head2'), an = bd.an; if (!h || !an) return;
    const feas = wantQ().filter((q) => an[q].ok);
    if (!feas.length) { h.className = 'head bad'; h.innerHTML = '<b>Not possible:</b> ' + whyNot(an).map(esc).join(' '); return; }
    const lo = Math.min.apply(null, feas.map((q) => an[q].minIl)), hi = Math.max.apply(null, feas.map((q) => an[q].maxIl)), rq = Math.min.apply(null, feas.map((q) => an[q].reqLv));
    const qn = feas.length >= 4 ? 'Any quality' : feas.map((q) => QCOLN[q]).join(' or ').replace(/^./, (c) => c.toUpperCase()), f = bd.farm;
    const farm = !f ? 'searching farm sources&hellip;' : f.err ? 'farm search failed (' + esc(f.err) + ')' : !f.top ? 'no farm source found (try Difficulty: All)' :
      'best farm: <b>' + esc(f.top.src.name) + '</b> in ' + esc(f.top.src.areaName) + ' (' + DIFF[f.top.src.diff] + '), ' + killsTxt(f.top.pTotal);
    h.className = 'head';
    h.innerHTML = '<b>' + esc(qn + ' ' + bd.type.name) + '</b> &middot; item level ' + ilTxt(lo, hi) + ' &middot; requires character level ' + rq + ' &middot; ' + farm;
  }
  /** per-base contribution to the best farm source, from the last farm result */
  function showShares() {
    const tb = $('tbbase'); if (!tb) return;
    const top = bd.farm && bd.farm.top;
    for (const tr of tb.querySelectorAll('tbody tr')) {
      const td = tr.querySelector('.sh'), v = top && top.byBase ? top.byBase[tr.dataset.c] || 0 : 0;
      td.textContent = v > 0 ? (100 * v / top.pTotal).toFixed(1) + '% (' + odds(v) + ')' : '-';
    }
  }

  // ----- farm sources (worker) -----
  function runFarm() {
    clearTimeout(farmTimer);
    if (!bd.an || !bd.farmQ.length) return;
    const { sel, ctxS } = pctx(); saveSel();
    const qs = bd.farmQ.slice(), an = bd.an;
    const codes = bd.codes.filter((c) => qs.some((q) => an[q].per.find((x) => x.code === c).ok));
    const opts = { codes, conds: condsOf(), mf: sel.mf, diff: sel.diff, act: sel.act, area: parseInt($('ar2').value || '0', 10), srcKey: $('mo2').value || '', rolls: parseInt($('mc2').value, 10) };
    bd.farm = null; renderHead();
    $('prog2').hidden = false; $('prog2').value = 0;
    $('finfo2').textContent = 'Searching farm sources...';
    const t0 = performance.now();
    const finish = (rowsByQ, err) => {
      $('prog2').hidden = true;
      if (!rowsByQ) { $('finfo2').textContent = 'Error: ' + err; bd.farm = { err: String(err) }; renderHead(); return; }
      const m = new Map();
      for (const q of qs) for (const r of rowsByQ[q]) {
        let x = m.get(r.src.key);
        if (!x) { x = { src: r.src, pq: {}, pTotal: 0, perRun: 0, byBase: {} }; m.set(r.src.key, x); }
        x.pq[q] = r.pTotal;
        x.pTotal += r.pTotal; x.perRun += r.perRun;
        for (const c in r.byBase || {}) x.byBase[c] = (x.byBase[c] || 0) + r.byBase[c];
      }
      let rows = Array.from(m.values());
      if (sel.tz) rows = rows.filter((r) => r.src.tz);
      T2.rows = rows; T2.limit = parseInt($('n2').value, 10);
      T2.key = opts.area ? 'perrun' : 'ptot'; T2.dir = -1;
      const r = T2.render();
      let top = null; for (const x of rows) if (!top || x.pTotal > top.pTotal) top = x;
      bd.farm = { top, rows: rows.length };
      showShares(); renderHead();
      $('finfo2').textContent = (r.total ? '' : 'No source found: monsters of the selected difficulty/act may not drop items at these item levels (try Difficulty: All or Normal). ') + r.total.toLocaleString() + ' sources (showing ' + r.shown + ')' + (top ? '; best per kill: ' + top.src.name + ' in ' + top.src.areaName + ' (' + DIFF[top.src.diff] + '), ' + odds(top.pTotal) : '') + '; ' +
        qs.map((q) => QN[q] + (q === 'rare' ? ' = Monte Carlo ' + opts.rolls.toLocaleString() + ' rolls/pool' : ' = exact')).join(', ') + (sel.quest ? '; quest drop (act bosses)' : '') + '; ' + Math.round(performance.now() - t0) + ' ms. Click a column header to sort.';
    };
    runJob('farm', { type: 'farm', ctx: ctxS, opts, qualities: qs }, (f) => { $('prog2').value = f; }, finish, () => {
      const out = {}; for (const q of qs) out[q] = E.affixSearch(E.getCtx(ctxS), Object.assign({}, opts, { quality: q, prune: true, byBase: true }), null).rows; return out;
    });
  }

  // ----- URL state: ?t2=boot (or &b2=<base code>)&tr2=-1&il=85&q=&p=<affix id> (repeatable, the picked affixes)&a=<stat key>:<min> (repeatable); the old ?q2=&ql=&c= link is still read -----
  function syncUrl() {
    try {
      const qs = new URLSearchParams(location.search);
      for (const k of ['q2', 'ql', 'c', 't2', 'b2', 'tr2', 'il', 'q', 'p', 'a', 'diff']) qs.delete(k);
      if (bd.type) {
        qs.set(bd.type.kind === 'base' ? 'b2' : 't2', bd.type.code);
        if (bd.type.kind === 'type' && effTier() >= 0) qs.set('tr2', effTier());
        if ($('il2').value !== '85') qs.set('il', $('il2').value);
        if ($('ql2').value) qs.set('q', $('ql2').value);
        for (const p of bd.picks) qs.append('p', p.id);
        for (const s of bd.sel) qs.append('a', s.key + ':' + s.thr);
        if (E.mode === 'lod') qs.set('mode', 'lod');
        if ($('s_diff').value !== '2') qs.set('diff', $('s_diff').value);
      }
      history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs.toString() : ''));
      $('link2').value = bd.type ? location.href : '';
    } catch (e) { /* ignore */ }
  }

  function setType(opt) {
    bd.type = opt; bd.sel = []; bd.picks = [];
    refreshBuilder();
  }
  function refreshBuilder() {
    bd.codes = curCodes();
    bd.stats = new Map(E.builderStats(bd.codes).map((s) => [s.key, s]));
    bd.sel = bd.sel.filter((s) => bd.stats.has(s.key));
    for (const p of bd.picks) p.keys = p.keys.filter((k) => bd.stats.has(k));
    bd.picks = bd.picks.filter((p) => p.keys.length);
    for (const s of bd.sel) addStat(s.key, s.thr);
    bd.farm = null; fitIdx = null;
    renderSel(); requestTable(); changed();
  }
  function onPickRow(r) {
    if (!r) return;
    if (bd.picks.some((p) => p.id === r.id)) { removePick(r.id); return; }   // clicking a picked row takes it out again
    bd.picks.push(pickFromRow(r));
    for (const m of r.mods) {
      const st = bd.stats.get(m.key);
      if (st && !bd.sel.some((s) => s.key === m.key)) addStat(m.key, st.le ? m.max : m.min);
    }
    updateRanges(); renderSel(); refit(true); changed();
  }
  function findTypeOption(w) {
    w = w.toLowerCase();
    const names = TYPEOPTS.filter((o) => o.kind === 'type');
    return names.find((o) => o.name.toLowerCase() === w) || names.find((o) => o.name.toLowerCase().startsWith(w)) || names.find((o) => o.name.toLowerCase().indexOf(w) >= 0) ||
      TYPEOPTS.find((o) => o.kind === 'base' && o.label.toLowerCase().indexOf(w) >= 0) || null;
  }
  function typeOptions() {
    const tys = E.builderTypes().map((t) => ({ kind: 'type', code: t.code, name: t.name, label: typeLabel(t), search: t.name + ' ' + t.code }));
    const ok = new Set(); for (const t of E.builderTypes()) for (const c of t.codes) ok.add(c);
    return tys.concat(INDEX.filter((x) => x.kind === 'base' && ok.has(x.code)));
  }
  function initTab2() {
    T2 = makeTable($('tb2'), cols2, 'ptot', -1);
    TA = makeTable($('tb2a'), colsA, 'omagic', -1);
    TA.limit = 400;
    TA.rowCls = (r) => 'pick' + (r.avail ? '' : ' dim') + (pickIds().has(r.id) ? ' picked' : fitOf(r) ? '' : ' nofit');
    $('odds2').checked = lsGet('d2dc-odds2');
    TA.onRow = onPickRow;
    autocomplete($('q2'), $('ac2'), () => TYPEOPTS, (x) => setType(x));
    $('tr2').addEventListener('change', () => { if (bd.type && bd.type.kind === 'type') refreshBuilder(); });
    $('ilr2').addEventListener('input', () => { $('il2').value = $('ilr2').value; });
    $('ilr2').addEventListener('change', () => { syncUrl(); requestTable(); });
    $('il2').addEventListener('change', () => { effIlvl(); syncUrl(); requestTable(); });
    $('ql2').addEventListener('change', () => { TA.key = 'o' + ($('ql2').value || 'magic'); TA.dir = -1; updateRanges(); renderSel(); syncUrl(); requestTable(); updateAnalysis(); runFarm(); refit(true); });
    $('mc2').addEventListener('change', () => { requestTable(); changed(); });
    $('ar2').addEventListener('change', () => { fillMonsters(); requestTable(); changed(); });
    $('mo2').addEventListener('change', () => { requestTable(); changed(); });
    $('n2').addEventListener('change', () => changed());
    let whyT = null;
    $('tb2a').addEventListener('mouseover', (ev) => {   // per-base odds, built on the first hover of a cell; the reason a row does not fit, after a short pause
      const td = ev.target.closest('td'); if (!td) return;
      const tr = td.parentNode, r = TA.shownRows[tr.sectionRowIndex];
      clearTimeout(whyT);
      if (r && tr.classList.contains('nofit')) whyT = setTimeout(() => { tr.title = $('why2').textContent = noFitWhy(r); }, 120); else $('why2').textContent = '';
      if (td.title) return;
      const c = colsA[td.cellIndex];
      if (c && c.tip && r) td.title = c.tip(r);
    });
    $('tb2a').addEventListener('mouseleave', () => { clearTimeout(whyT); $('why2').textContent = ''; });
    $('f2').addEventListener('input', renderTable);
    $('sd2').addEventListener('change', renderTable);
    $('av2').addEventListener('change', renderTable);
    $('hf2').addEventListener('change', renderTable);
    $('odds2').addEventListener('change', () => {
      lsSet('d2dc-odds2', $('odds2').checked);
      if ($('odds2').checked) { TA.key = 'o' + ($('ql2').value || 'magic'); TA.dir = -1; }
      renderTable();
    });
    $('go2').onclick = () => { updateAnalysis(); runFarm(); };
    $('clr2').onclick = () => { bd.sel = []; bd.picks = []; renderSel(); refit(true); bd.farm = null; changed({ noFarm: true }); };
    $('link2').addEventListener('focus', () => $('link2').select());
    const selbox = $('sel2');
    selbox.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('rmp')) { removePick(ev.target.dataset.id); return; }
      if (ev.target.classList.contains('rm')) removeStat(+ev.target.closest('.selrow').dataset.i);
    });
    selbox.addEventListener('input', (ev) => {
      const row = ev.target.closest('.selrow'); if (!row) return;
      const s = bd.sel[+row.dataset.i], r = rngOf(s);
      let v = parseFloat(ev.target.value); if (isNaN(v)) return;
      v = Math.max(r.lo, Math.min(r.hi, Math.round(v)));
      s.thr = v;
      if (ev.target.classList.contains('thrr')) row.querySelector('.thr').value = v; else row.querySelector('.thrr').value = v;
      row.querySelector('.nm span').textContent = statText(s);
      syncRows(+row.dataset.i);
      changed(); refit();
    });
  }
  /** apply the builder part of the URL (new ?t2/?b2/?a, or the old ?q2=&ql=&c= deep link); true when it set a type */
  function applyUrl2(qs) {
    let opt = null;
    if (qs.get('t2')) opt = TYPEOPTS.find((o) => o.kind === 'type' && o.code === qs.get('t2'));
    else if (qs.get('b2')) opt = TYPEOPTS.find((o) => o.kind === 'base' && o.code === qs.get('b2'));
    else if (qs.get('q2')) opt = findTypeOption(qs.get('q2'));
    if (!opt) return false;
    if (qs.get('tr2')) $('tr2').value = qs.get('tr2');
    if (qs.get('il')) { $('il2').value = qs.get('il'); effIlvl(); }
    const q = qs.get('q') || qs.get('ql'); if (q) $('ql2').value = q;
    $('q2').value = opt.label;
    bd.type = opt; bd.codes = curCodes();
    bd.stats = new Map(E.builderStats(bd.codes).map((s) => [s.key, s]));
    bd.sel = []; bd.picks = []; fitIdx = null;
    const cat = E.builderCatalog(bd.codes);   // ?p=<affix id>: the picked affixes (old links have none: their stats show under "Other stats")
    for (const id of qs.getAll('p')) {
      const r = cat.get(id); if (!r || bd.picks.some((p) => p.id === id)) continue;
      const pk = pickFromRow(r); if (!pk.keys.length) continue;
      bd.picks.push(pk);
      for (const m of r.mods) { const st = bd.stats.get(m.key); if (st && !bd.sel.some((s) => s.key === m.key)) addStat(m.key, st.le ? m.max : m.min); }
    }
    for (const c of qs.getAll('a').concat(qs.getAll('c'))) { const i = c.lastIndexOf(':'); addStat(c.slice(0, i), parseFloat(c.slice(i + 1))); }
    renderSel(); requestTable(); syncUrl(); updateAnalysis(); runFarm();
    document.getElementById('t2').click();
    return true;
  }

  // ---------------- init ----------------
  /** Load (once) and select the engine of a game mode; the page header shows that data's game version. */
  async function useEngine(m) {
    if (!DATAFILE[m]) m = 'rotw';
    if (!ENGINES[m]) {
      const resp = await fetch(DATAFILE[m]);
      if (!resp.ok) throw new Error(DATAFILE[m] + ' missing - run: python build.py');
      ENGINES[m] = Engine.create(await resp.json());
    }
    E = ENGINES[m];
    E.CONFIG.gameMode = E.mode;
    $('s_mode').value = E.mode;
    $('dataInfo').textContent = 'data: D2R ' + E.data.meta.gameVersion + ' (' + (E.mode === 'lod' ? 'Lord of Destruction' : 'Reign of the Warlock') + '), built ' + E.data.meta.built;
    INDEX = E.searchIndex();
    TYPEOPTS = typeOptions();
    const areas = Object.keys(E.data.levels).filter((id) => !E.DUP_OF[id] && (E.data.levels[id].mon.length || E.data.levels[id].nmon.length || E.data.levels[id].pre))
      .map((id) => ({ id, a: E.data.levels[id] })).sort((x, y) => x.a.act - y.a.act || x.id - y.id);
    const cur = $('ar2').value;
    $('ar2').innerHTML = '<option value="">All areas</option>' + areas.map((x) => '<option value="' + x.id + '">Act ' + x.a.act + ' - ' + esc(x.a.name) + (x.a.ho ? ' (Hell only)' : '') + '</option>').join('');
    if (areas.some((x) => x.id === cur)) $('ar2').value = cur;
    fillMonsters();
    $('info1').textContent = 'Ready. ' + INDEX.length + ' items indexed, ' + Object.keys(E.data.levels).length + ' areas, ' + Object.keys(E.data.monsters).length + ' monster types.';
    updTier();
  }
  /** one-line "Your game" summary shown on the collapsed bar */
  function updGame() {
    const v = (id) => $(id).value, n = (id, w) => v(id) + ' ' + w + (v(id) === '1' ? '' : 's');
    $('gsum').textContent = ['Your game: ' + (v('s_mode') === 'lod' ? 'LoD' : 'RotW'), v('s_ladder') === '1' ? 'Ladder' : 'Non-ladder', n('s_players', 'player') + (+v('s_party') > 1 ? ' (party ' + v('s_party') + ')' : ''),
      (+v('s_mf') || 0) + '% MF', 'clvl ' + v('s_clvl')].concat($('s_quest').checked ? ['quest drop'] : [], $('s_tz').checked ? ['terror zone' + (+v('s_tier') ? ' T' + v('s_tier') : '')] : []).join(' · ');
  }
  const sameTarget = (x, y) => x.kind === y.kind && (x.code || x.id) === (y.code || y.id);

  /** Game mode selector: swap engine + data, re-index, drop the old results and re-run the current tab. */
  async function switchMode(m) {
    const had2 = bd.sel.length > 0;
    await useEngine(m);
    if (target1) { target1 = INDEX.find((x) => sameTarget(x, target1)) || null; if (!target1) { $('q1').value = ''; T1.rows = []; T1.render(); } }
    if (bd.type) {
      const o = TYPEOPTS.find((x) => x.kind === bd.type.kind && x.code === bd.type.code) || null;
      bd.type = o; bd.farm = null;
      if (!o) { $('q2').value = ''; bd.sel = []; }
      refreshBuilder();
    }
    T2.rows = []; T2.render();
    if (target1) runTab1();
  }

  async function init() {
    loadSel();
    const qs0 = new URLSearchParams(location.search);
    if (qs0.get('mode')) $('s_mode').value = qs0.get('mode');
    if (qs0.get('tz')) { $('s_tz').checked = true; $('s_clvl').value = qs0.get('tz'); }
    if (qs0.get('tier')) $('s_tier').value = qs0.get('tier');
    if (qs0.get('mf')) $('s_mf').value = qs0.get('mf');
    if (qs0.get('diff')) $('s_diff').value = qs0.get('diff');
    await useEngine($('s_mode').value);

    // tabs
    const tabs = ['t1', 't2', 't3'];
    tabs.forEach((t, i) => $(t).onclick = () => {
      tabs.forEach((x, j) => { $(x).classList.toggle('on', i === j); $('tab' + (j + 1)).classList.toggle('on', i === j); });
      if (i < 2) $('tab' + (i + 1)).querySelector('.row').appendChild($('wh'));   // Difficulty / Act (global) sit with the filters of the open tab
    });
    // "Your game" bar: one-line summary, open state remembered
    $('game').open = lsGet('d2dc-game');
    $('game').addEventListener('toggle', () => lsSet('d2dc-game', $('game').open));
    updGame();
    $('game').addEventListener('change', updGame);
    for (const k of KEYS) $(k).addEventListener('change', () => {
      saveSel(); updGame();
      if (k === 's_mode') { switchMode($('s_mode').value).catch((e) => { $('info1').textContent = 'Could not load data: ' + e; }); return; }
      if (k === 's_diff' && bd.sel.length) { updateRanges(); renderSel(); refit(true); }
      updTier(); if (target1) runTab1(); if (bd.an) { syncUrl(); runFarm(); }
      if (bd.type && $('ar2').value) { fillMonsters(); requestTable(); }
    });
    $('s_act').addEventListener('change', () => { if (target1) runTab1(); });
    // theme: personal preference, kept out of KEYS / share links
    try { $('s_theme').value = localStorage.getItem('d2dc-theme') || ''; } catch (e) {}
    $('s_theme').addEventListener('change', () => {
      const v = $('s_theme').value;
      if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
      try { if (v) localStorage.setItem('d2dc-theme', v); else localStorage.removeItem('d2dc-theme'); } catch (e) {}
    });

    // tab 1
    T1 = makeTable($('tb1'), cols1, 'perrun', -1);
    T1.onSort = () => {};
    $('qb1').checked = lsGet('d2dc-qb1');
    $('qb1').addEventListener('change', () => { lsSet('d2dc-qb1', $('qb1').checked); T1.render(); });
    $('g1').addEventListener('change', () => { T1.key = 'perrun'; T1.dir = -1; runTab1(); });   // both views start sorted by chance per run
    $('bld1').onclick = () => {   // tab 2 on this base
      const o = TYPEOPTS.find((x) => x.kind === 'base' && x.code === target1.code); if (!o) return;
      $('q2').value = o.label; setType(o); $('t2').click();
    };
    $('tb2').addEventListener('click', (ev) => {   // farm row -> tab 1 filtered to that monster / area; the base becomes the target when the builder has exactly one
      if (!ev.target.classList.contains('go1')) return;
      ev.preventDefault();
      const r = T2.shownRows[ev.target.closest('tr').sectionRowIndex]; if (!r) return;
      const t = bd.type && bd.type.kind === 'base' ? INDEX.find((x) => x.kind === 'base' && x.code === bd.type.code) : null;
      if (t) { target1 = t; $('q1').value = t.label; }
      $('f1').value = r.src.rank === 'boss' || r.src.rank === 'super' ? r.src.name : r.src.areaName;
      $('t1').click();
      runTab1();
    });
    autocomplete($('q1'), $('ac1'), () => INDEX, (x) => { target1 = x; runTab1(); });
    $('f1').addEventListener('input', () => { clearTimeout(runTab1.t); runTab1.t = setTimeout(runTab1, 250); });
    $('r1').addEventListener('change', runTab1);
    $('bq1').addEventListener('change', runTab1);
    $('n1').addEventListener('change', runTab1);

    // tab 2
    initTab2();
    // about
    $('about').innerHTML = aboutHtml();
    // deep links: ?q1=Griffon   or the item builder: ?t2=circ&q=magic&a=%2B%23%25%20Faster%20Cast%20Rate:20 (old form ?q2=circlet&ql=magic&c=... still works)
    const qs = new URLSearchParams(location.search);
    if (qs.get('q1')) {
      const w = qs.get('q1').toLowerCase();
      target1 = INDEX.find((x) => (x.search || x.label).toLowerCase().indexOf(w) >= 0);
      if (target1) { $('q1').value = target1.label; runTab1(); }
    }
    applyUrl2(qs);
  }

  function aboutHtml() {
    const C = E.CONFIG;
    return '<p><b>How to read the tables.</b> Probabilities are per kill unless the column says run, and are shown as odds ("1 in N")."P(target)" for a base item equals P(base); for a unique or set item it is the chance of that exact item. ' +
      'Rank tags: champion (+' + C.champOffset + ' mlvl), unique (+' + C.uniqueOffset + '), minion of a unique (+' + C.minionOffset + '), super = super unique, boss = act boss.</p>' +
      '<p><b>Per-run numbers are an estimate of one full clear.</b> The game makes one spawn roll per 3x3 subtiles of every room (about 2.7 per tile; caves: the average number of map cells their generator makes, entrances and exits included, at the real cell size) and spawns a pack with chance MonDen/100000. ' +
      'Not every pack places: each level gets a placement share from its real map layouts (walkable floor of the preset rooms, 20 tries per pack; 1 where the layout is not modelled), times a global factor of ' + C.run.placeFactor + ' (calibrated on a measured Cow Level count, not from the game code). Pack types follow how the game picks from the area monster list and their Rarity; ' +
      'packs include party minions (e.g. the Fallen with a Fallen Shaman, counted as their own monster). Champion/unique packs follow MonUMin/MonUMax (' + C.run.champShare * 100 + '% champion packs of 2-4, else a unique with ' + C.run.uniqueMinions.join('-') + ' minions). ' +
      'Treat the numbers as about +/-50%; they rank areas against each other better than they count them. Bosses and super uniques count as one kill per run. Monsters the map files place at fixed spots (Fallen camps, unique and champion packs in treasure rooms, the Act 5 siege) are added where the level generator fixes which presets appear; they also use up unique slots, so such levels get fewer random champion/unique packs. Super uniques bring their minions (Council members, Baal waves, ...) as minion rows of the same area. Tal Rasha Tomb = the true tomb with the orifice (the staff tomb, about 3x a plain tomb), shown once for all seven tombs. Matron Den, Forgotten Sands, Furnace of Pain and Uber Tristram only open in Hell and are not listed for Normal and Nightmare.</p>' +
      '<p><b>Config in use</b> (Engine.CONFIG in engine.js): <code>' + esc(JSON.stringify(C)) + '</code></p>' +
      '<p><b>Poison in the item builder.</b> The numbers are what the item tooltip shows: total poison damage (the stored per-frame value x frames / 256) over frames / 25 seconds. Poison from several sources adds the damage per frame, but the durations are summed and divided by the number of poison sources at hit time (LoD 1.10-1.14 decompilation, <code>dwPoisLen /= nPoisonCount</code>), while the tooltip shows the summed duration. A Pestilent + of Anthrax charm reads 451 over 12 seconds but, as the only poison source, deals about 225 over 6 seconds. ' +
      'The slider of a multi-number stat names what it filters on: maximum damage, chance to cast, or skill level (charged skills: the level reached at item level 99).</p>' +
      '<p>See README.md for formulas, research sources and limitations.</p>';
  }

  init().catch((e) => { document.body.insertAdjacentHTML('afterbegin', '<pre style="color:var(--err);padding:10px">' + esc(e.stack || e) + '</pre>'); });
})();
