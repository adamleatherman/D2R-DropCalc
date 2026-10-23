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
  const KEYS = ['s_mode', 's_tier', 's_diff', 's_players', 's_party', 's_mf', 's_quest', 's_tz', 's_clvl', 's_ladder', 's_act', 's_pct'];
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
      for (const r of shown) h += '<tr' + (st.rowCls ? ' class="' + st.rowCls(r) + '"' : '') + '>' + vcols.map((c) => '<td class="' + (c.l ? 'l' : '') + '">' + (c.html ? c.html(r) : esc(c.fmt ? c.fmt(r) : c.get(r))) + '</td>').join('') + '</tr>';
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
  const cols1 = srcCols.concat([
    { k: 'sTable', show: isSun, label: 'Sunder: table path', note: 'Data-driven: the Sunder Charms TC inside desecrated champ/unique/boss TCs and the Herald Item TCs (herald tier gates the extra item picks), incl. player-count NoDrop.', get: (r) => r.sp ? r.sp.table : 0, fmt: (r) => odds(r.sp.table) },
    { k: 'sMf', show: isSun, label: 'Sunder: MF path', note: 'Data-driven: the PreCrafted Sunders are spawnable unique grand charms (rarity 1, lvl 75, DropConditionCalc Hell only), so a unique cm3 roll can pick one.', get: (r) => r.sp ? r.sp.mf : 0, fmt: (r) => odds(r.sp.mf) },
    { k: 'sTotal', show: isSun, label: 'Sunder: total', note: 'Combined chance of both paths.', get: (r) => r.sp ? r.sp.total : 0, fmt: (r) => odds(r.sp.total) },
    { k: 'pbase', label: 'P(base)', get: (r) => r.c.base, fmt: (r) => odds(r.c.base) },
    { k: 'plow', show: isWhiteBase, label: 'P(low)', note: 'Low quality (crude/cracked/damaged/low quality) base. Boss, champion and unique TCs force Magic=1024, so this is 0 there.', get: (r) => r.c.low, fmt: (r) => odds(r.c.low) },
    { k: 'pnorm', show: isWhiteBase, label: 'P(normal)', note: 'Normal quality base (what is left after unique/set/rare/magic/superior/low).', get: (r) => r.c.normal, fmt: (r) => odds(r.c.normal) },
    { k: 'psup', show: isWhiteBase, label: 'P(superior)', note: 'Superior quality base.', get: (r) => r.c.hq, fmt: (r) => odds(r.c.hq) },
    { k: 'pmag', note: QNOTE, label: 'P(magic)', get: (r) => r.c.magic, fmt: (r) => odds(r.c.magic) },
    { k: 'prare', note: QNOTE, label: 'P(rare)', get: (r) => r.c.rare, fmt: (r) => odds(r.c.rare) },
    { k: 'pset', note: QNOTE, label: 'P(set)', get: (r) => r.c.set, fmt: (r) => odds(r.c.set) },
    { k: 'puni', note: QNOTE, label: 'P(unique)', get: (r) => r.c.unique, fmt: (r) => odds(r.c.unique) },
    { k: 'ptar', label: 'P(target) per kill', note: 'Chance that one kill drops the target (shown as odds; sorts by probability).', get: (r) => r.c.target, fmt: (r) => odds(r.c.target) },
    { k: 'runs', label: 'kills/run', get: (r) => r.src.perRun, fmt: (r) => r.src.herald ? 'n/a' : r.src.perRun < 10 ? r.src.perRun.toFixed(2) : r.src.perRun.toFixed(0) },
    { k: 'perrun', label: 'P(target) per run', note: 'Chance of finding the target in one run (kills/run x per-kill chance, rough model; shown as odds).', get: (r) => r.c.target * r.src.perRun, fmt: (r) => odds(r.c.target * r.src.perRun) },
  ]);

  // percentile columns: kills (or runs) needed to have found the target with probability q; selector s_pct = off / kills / runs
  const PCTS = [25, 50, 75, 90, 95, 99];
  const pctCols = PCTS.map((q) => {
    const per = (r) => $('s_pct').value === 'runs' ? r.c.target * r.src.perRun : r.c.target;
    const n = (r) => E.trialsFor(per(r), q / 100);
    const unit = () => $('s_pct').value === 'runs' ? 'runs' : 'kills';
    return { k: 'pc' + q, show: () => $('s_pct').value !== 'off', get label() { return q + '% ' + unit(); }, get note() { return 'Number of ' + unit() + ' needed to have found the target with ' + q + '% probability: ceil(ln(1-' + q / 100 + ') / ln(1-p)).'; }, get: per, fmt: (r) => countFmt(n(r)) };
  });
  cols1.push(...pctCols);

  let srcCache = { sig: '', list: null };
  function getSources(sel) {
    const ctx = E.getCtx({ players: sel.players, party: sel.party, ladder: sel.ladder, tz: sel.tz, quest: sel.quest, clvl: sel.clvl, mf: sel.mf, tier: sel.tier });
    const sig = JSON.stringify([sel.quest, sel.tz, sel.clvl, sel.mode, sel.tier, sel.players, sel.party]);
    if (srcCache.sig !== sig) srcCache = { sig, list: E.areaSources(ctx) };   // champions / uniques / minions / heralds merged per area
    return { ctx, list: srcCache.list };
  }

  function runTab1() {
    if (!target1) return;
    const sel = S = readSel(); saveSel();
    const t0 = performance.now();
    const { ctx, list } = getSources(sel);
    const f = $('f1').value.trim().toLowerCase(), rk = $('r1').value;
    $('l_bq1').hidden = !isWhiteBase();
    const bq = isWhiteBase() ? $('bq1').value : '';
    const rows = [];
    for (const src of list) {
      if (sel.diff >= 0 && src.diff !== sel.diff) continue;
      if (sel.act && src.act !== sel.act) continue;
      if (rk && src.rank !== rk) continue;
      if (sel.tz && !src.tz) continue;
      if (f && (src.name + ' ' + (src.members || []).join(' ') + ' ' + src.mon + ' ' + src.areaName).toLowerCase().indexOf(f) < 0) continue;
      const c = E.chanceFor(ctx, src, target1, sel.mf);
      if (bq) c.target = E.baseQualityChance(c, bq);
      if (c.target > 0) rows.push({ src, c, sp: isSun() ? E.sunderPaths(ctx, src, target1.id, sel.mf) : null });
    }
    T1.rows = rows; T1.limit = parseInt($('n1').value, 10);
    const r = T1.render();
    const it = target1.kind === 'base' ? E.items[target1.code] : E.items[(target1.kind === 'unique' ? E.uniqById : E.setById)[target1.id].code];
    $('info1').textContent = target1.label + '  |  base qlvl ' + it.q + '  |  ' + r.total.toLocaleString() + ' sources can drop it (showing ' + r.shown + ')  |  N=' + ctx.N +
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
  let bd = { type: null, codes: [], stats: new Map(), sel: [], rows: [], an: null, farm: null, farmQ: [], wts: null, wlabel: '' };
  let tableWorker = null, farmWorker = null, tableId = 0, farmId = 0;

  const cols2 = srcCols.concat(QS_ALL.map((q) => ({ k: 'p' + q, label: 'P(' + (q === 'sup' ? 'superior' : q === 'low' ? 'low' : q) + ')', show: () => bd.farmQ.indexOf(q) >= 0,
    note: 'Chance per kill of a ' + QCOLN[q].toUpperCase() + ' item of the type with the combination (' + (q === 'rare' ? 'Monte Carlo' : 'exact') + ').', get: (r) => r.pq[q] || 0, fmt: (r) => odds(r.pq[q] || 0) })), [
    { k: 'ptot', label: 'P per kill', note: 'Chance that one kill drops a matching item (sum over every base of the type and the possible qualities; shown as odds, sorts by probability).', get: (r) => r.pTotal, fmt: (r) => odds(r.pTotal) },
    { k: 'runs', label: 'kills/run', get: (r) => r.src.perRun, fmt: (r) => r.src.herald ? 'n/a' : r.src.perRun < 10 ? r.src.perRun.toFixed(2) : r.src.perRun.toFixed(0) },
    { k: 'perrun', label: 'P per run', note: 'Chance of a matching item in one run (rough model; shown as odds).', get: (r) => r.perRun, fmt: (r) => odds(r.perRun) },
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
  const statText = (s) => { const st = bd.stats.get(s.key); return E.describe(s.key, s.thr, s.thr) + (st && st.flag ? '' : st && st.le ? '  (or lower)' : '  (or more)'); };

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
  const sideTag = (r) => '<span class="side ' + r.side + '">' + r.side + '</span>';
  const lvWindow = (r) => r.minIl === null ? '-' : r.maxIl >= 99 ? r.minIl + '+' : r.minIl + ' to ' + r.maxIl;
  const colsA = [
    { k: 'name', label: 'Name', l: 1, get: (r) => r.name.toLowerCase(), html: (r) => esc(r.name) + ' ' + sideTag(r) },
    { k: 'desc', label: 'Description (all tiers)', l: 1, get: (r) => r.desc.toLowerCase(), html: (r) => esc(r.desc) },
    { k: 'lvl', label: 'Affix lvl', note: 'Affix level. Staff skills have a tier instead.', get: (r) => r.lvl === null ? r.tier : r.lvl, fmt: (r) => r.lvl === null ? (r.tier ? 'tier ' + r.tier : '-') : r.lvl },
    { k: 'lr', label: 'Req lvl', note: 'Character level the affix requires (levelreq).', get: (r) => r.lr === null ? 0 : r.lr, fmt: (r) => r.lr === null ? '-' : r.lr },
    { k: 'il', label: 'Item level', note: 'Item levels at which some base of the type can roll it: "20+" or a window "24 to 35" (affix max level, staff skill tiers).', get: (r) => r.minIl === null ? 999 : r.minIl, fmt: lvWindow },
    { k: 'cls', label: 'Class', l: 1, get: (r) => r.cls, fmt: (r) => r.cls ? (CLASSN[r.cls] || r.cls) + ' only' : '' },
    { k: 'grp', label: 'Excludes', l: 1, note: 'Affixes of the same group never appear together on one item. The group is named after its first stat.', get: (r) => r.groupName, fmt: (r) => r.g ? r.groupName : '' },
    { k: 'qual', label: 'Quality', l: 1, note: 'Qualities the row can occur on: L low quality, N normal, S superior, M magic, R rare.', get: (r) => r.quals.length * 10 + (r.rare ? 1 : 0), fmt: (r) => r.quals.map((q) => QAB[q]).join(' ') },
  ].concat(QS_ALL.map((q) => ({ k: 'o' + q, show: () => oddsQ().indexOf(q) >= 0, get label() { return 'Odds (' + QCOLN[q] + ', ' + (bd.wts ? 'weighted' : 'avg') + ')'; },
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
    const wq = wantQ();
    return bd.rows.filter((r) => (!sd || r.side === sd) && (!av || r.avail) && r.quals.some((q) => wq.indexOf(q) >= 0) &&
      f.every((w) => (r.name + ' ' + r.desc + ' ' + r.side + ' ' + (r.cls ? (CLASSN[r.cls] || r.cls) + ' only' : '') + ' ' + r.groupName).toLowerCase().indexOf(w) >= 0));
  }
  function renderTable() {
    TA.rows = filterRows();
    const r = TA.render();
    $('tinfo2').textContent = bd.codes.length ? r.total + ' of ' + bd.rows.length + ' affixes (showing ' + r.shown + '); odds at item level ' + effIlvl() + ', ' +
      (bd.wts ? (bd.wts.some((w) => w > 0) ? 'weighted by drop rate in ' + bd.wlabel + ' (bases that cannot drop there count 0)' : 'no base of the selection drops in ' + bd.wlabel + ' with the current selectors, so every odds figure is "-"')
        : 'average over the ' + bd.codes.length + ' base' + (bd.codes.length === 1 ? '' : 's') + ' of the selection (each base counted equally)') +
      '. Hover an odds cell for the per-base odds. Click a row to add it. Dimmed rows cannot roll at this item level.' : '';
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

  // ----- selected stats with sliders -----
  function addStat(key, thr) {
    const st = bd.stats.get(key); if (!st) return false;
    let e = bd.sel.find((s) => s.key === key);
    if (!e) { e = { key, thr: 0 }; bd.sel.push(e); }
    if (thr === undefined || isNaN(thr)) thr = st.le ? st.max : st.min;
    e.thr = Math.max(st.min, Math.min(st.max, thr));
    return true;
  }
  function renderSel() {
    const box = $('sel2');
    if (!bd.sel.length) { box.className = 'note'; box.textContent = 'Click an affix in the table to add its stat. Each stat gets a minimum value you can move with the slider.'; return; }
    box.className = '';
    box.innerHTML = bd.sel.map((s, i) => {
      const st = bd.stats.get(s.key);
      return '<div class="selrow" data-i="' + i + '"><div class="nm"><span>' + esc(statText(s)) + '</span><button class="rm" title="remove">x</button></div>' + (st.flag ? '' :
        '<div class="ctl"><span>' + (st.le ? '&lt;=' : '&gt;=') + '</span><input type="number" class="thr" value="' + s.thr + '" min="' + st.min + '" max="' + st.max + '">' +
        '<input type="range" class="thrr" min="' + st.min + '" max="' + st.max + '" step="1" value="' + s.thr + '"><small class="note">' + st.min + ' to ' + st.max + '</small></div>') + '</div>';
    }).join('');
  }
  let anTimer = null, farmTimer = null;
  function changed(opt) {
    opt = opt || {};
    syncUrl();
    clearTimeout(anTimer); anTimer = setTimeout(updateAnalysis, 120);
    clearTimeout(farmTimer);
    if (opt.noFarm) return;
    farmTimer = setTimeout(runFarm, 900);
  }

  // ----- results: item levels / character level / conflicts (cheap, main thread) -----
  const ilTxt = (lo, hi) => hi >= 99 ? lo + '+' : lo + ' to ' + hi;
  function updateAnalysis() {
    clearTimeout(anTimer);
    const res = $('res2'), conf = $('conf2');
    bd.an = null; bd.farmQ = [];
    if (!bd.codes.length) { res.innerHTML = '<div class="note">No bases for this type / tier.</div>'; conf.innerHTML = ''; return; }
    if (!bd.sel.length) { res.innerHTML = '<div class="note">Select at least one affix to see the item levels and farm sources.</div>'; conf.innerHTML = ''; T2.rows = []; T2.render(); $('finfo2').textContent = ''; return; }
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
    conf.innerHTML = msgs.join('');
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
    res.innerHTML = '<div class="tbl"><table><thead><tr><th class="l">Quality</th><th title="Lowest item level at which some base of the type can roll the whole combination">Lowest item level</th><th title="Item levels that work (a window with an upper bound exists when staff skills are involved: their tier depends on the item level)">Item level window</th><th class="l" title="max(base requirement, requirements of the cheapest affix tiers that satisfy the sliders)">Required character level</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
      '<details><summary>Per base (' + bd.codes.length + ')</summary><div class="tbl small"><table id="tbbase"><thead><tr><th class="l">Base</th><th>qlvl</th><th class="l">Tier</th>' + pq.map((q) => '<th>' + QN[q] + ': item level</th><th>' + QN[q] + ': req lvl</th>').join('') + '<th title="Share of the best farm source (per kill) that comes from this base">Best source: share</th></tr></thead><tbody>' +
      perRows.map((x) => '<tr data-c="' + x.c + '"><td class="l">' + esc(baseName(x.c)) + '</td><td>' + E.items[x.c].q + '</td><td class="l">' + tierName(x.c) + '</td>' + pq.map((q) => '<td>' + cell(x[q]) + '</td><td>' + rl(x[q]) + '</td>').join('') + '<td class="sh">-</td></tr>').join('') +
      '</tbody></table></div></details>';
    if (!bd.farmQ.length) { T2.rows = []; T2.render(); $('finfo2').textContent = ''; }
    showShares();
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
    $('prog2').hidden = false; $('prog2').value = 0;
    $('finfo2').textContent = 'Searching farm sources...';
    const t0 = performance.now();
    const finish = (rowsByQ, err) => {
      $('prog2').hidden = true;
      if (!rowsByQ) { $('finfo2').textContent = 'Error: ' + err; return; }
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
      showShares();
      $('finfo2').textContent = (r.total ? '' : 'No source found: monsters of the selected difficulty/act may not drop items at these item levels (try Difficulty: All or Normal). ') + r.total.toLocaleString() + ' sources (showing ' + r.shown + ')' + (top ? '; best per kill: ' + top.src.name + ' in ' + top.src.areaName + ' (' + DIFF[top.src.diff] + '), ' + odds(top.pTotal) : '') + '; ' +
        qs.map((q) => QN[q] + (q === 'rare' ? ' = Monte Carlo ' + opts.rolls.toLocaleString() + ' rolls/pool' : ' = exact')).join(', ') + (sel.quest ? '; quest drop (act bosses)' : '') + '; ' + Math.round(performance.now() - t0) + ' ms. Click a column header to sort.';
    };
    runJob('farm', { type: 'farm', ctx: ctxS, opts, qualities: qs }, (f) => { $('prog2').value = f; }, finish, () => {
      const out = {}; for (const q of qs) out[q] = E.affixSearch(E.getCtx(ctxS), Object.assign({}, opts, { quality: q, prune: true, byBase: true }), null).rows; return out;
    });
  }

  // ----- URL state: ?t2=boot (or &b2=<base code>)&tr2=-1&il=85&q=&a=<stat key>:<min> (repeatable); the old ?q2=&ql=&c= link is still read -----
  function syncUrl() {
    try {
      const qs = new URLSearchParams(location.search);
      for (const k of ['q2', 'ql', 'c', 't2', 'b2', 'tr2', 'il', 'q', 'a', 'diff']) qs.delete(k);
      if (bd.type) {
        qs.set(bd.type.kind === 'base' ? 'b2' : 't2', bd.type.code);
        if (bd.type.kind === 'type' && effTier() >= 0) qs.set('tr2', effTier());
        if ($('il2').value !== '85') qs.set('il', $('il2').value);
        if ($('ql2').value) qs.set('q', $('ql2').value);
        for (const s of bd.sel) qs.append('a', s.key + ':' + s.thr);
        if (E.mode === 'lod') qs.set('mode', 'lod');
        if ($('s_diff').value !== '2') qs.set('diff', $('s_diff').value);
      }
      history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs.toString() : ''));
      $('link2').value = bd.type ? location.href : '';
    } catch (e) { /* ignore */ }
  }

  function setType(opt) {
    bd.type = opt; bd.sel = [];
    refreshBuilder();
  }
  function refreshBuilder() {
    bd.codes = curCodes();
    bd.stats = new Map(E.builderStats(bd.codes).map((s) => [s.key, s]));
    bd.sel = bd.sel.filter((s) => bd.stats.has(s.key));
    for (const s of bd.sel) addStat(s.key, s.thr);
    bd.farm = null;
    renderSel(); requestTable(); changed();
  }
  function onPickRow(r) {
    if (!r) return;
    for (const m of r.mods) {
      const st = bd.stats.get(m.key);
      if (st) addStat(m.key, st.le ? m.max : m.min);
    }
    renderSel(); changed();
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
    TA.rowCls = (r) => 'pick' + (r.avail ? '' : ' dim');
    TA.onRow = onPickRow;
    autocomplete($('q2'), $('ac2'), () => TYPEOPTS, (x) => setType(x));
    $('tr2').addEventListener('change', () => { if (bd.type && bd.type.kind === 'type') refreshBuilder(); });
    $('ilr2').addEventListener('input', () => { $('il2').value = $('ilr2').value; });
    $('ilr2').addEventListener('change', () => { syncUrl(); requestTable(); });
    $('il2').addEventListener('change', () => { effIlvl(); syncUrl(); requestTable(); });
    $('ql2').addEventListener('change', () => { TA.key = 'o' + ($('ql2').value || 'magic'); TA.dir = -1; syncUrl(); requestTable(); updateAnalysis(); runFarm(); });
    $('mc2').addEventListener('change', () => { requestTable(); changed(); });
    $('ar2').addEventListener('change', () => { fillMonsters(); requestTable(); changed(); });
    $('mo2').addEventListener('change', () => { requestTable(); changed(); });
    $('n2').addEventListener('change', () => changed());
    $('tb2a').addEventListener('mouseover', (ev) => {   // per-base odds, built on the first hover of a cell
      const td = ev.target.closest('td'); if (!td || td.title) return;
      const c = colsA[td.cellIndex], r = TA.shownRows[td.parentNode.sectionRowIndex];
      if (c && c.tip && r) td.title = c.tip(r);
    });
    $('f2').addEventListener('input', renderTable);
    $('sd2').addEventListener('change', renderTable);
    $('av2').addEventListener('change', renderTable);
    $('go2').onclick = () => { updateAnalysis(); runFarm(); };
    $('clr2').onclick = () => { bd.sel = []; renderSel(); bd.farm = null; changed({ noFarm: true }); };
    $('link2').addEventListener('focus', () => $('link2').select());
    const selbox = $('sel2');
    selbox.addEventListener('click', (ev) => {
      if (!ev.target.classList.contains('rm')) return;
      bd.sel.splice(+ev.target.closest('.selrow').dataset.i, 1); renderSel(); changed();
    });
    selbox.addEventListener('input', (ev) => {
      const row = ev.target.closest('.selrow'); if (!row) return;
      const s = bd.sel[+row.dataset.i], st = bd.stats.get(s.key);
      let v = parseFloat(ev.target.value); if (isNaN(v)) return;
      v = Math.max(st.min, Math.min(st.max, Math.round(v)));
      s.thr = v;
      if (ev.target.classList.contains('thrr')) row.querySelector('.thr').value = v; else row.querySelector('.thrr').value = v;
      row.querySelector('.nm span').textContent = statText(s);
      changed();
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
    bd.sel = [];
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
    const areas = Object.keys(E.data.levels).filter((id) => E.data.levels[id].mon.length || E.data.levels[id].nmon.length)
      .map((id) => ({ id, a: E.data.levels[id] })).sort((x, y) => x.a.act - y.a.act || x.id - y.id);
    const cur = $('ar2').value;
    $('ar2').innerHTML = '<option value="">All areas</option>' + areas.map((x) => '<option value="' + x.id + '">Act ' + x.a.act + ' - ' + esc(x.a.name) + '</option>').join('');
    if (areas.some((x) => x.id === cur)) $('ar2').value = cur;
    fillMonsters();
    $('info1').textContent = 'Ready. ' + INDEX.length + ' items indexed, ' + Object.keys(E.data.levels).length + ' areas, ' + Object.keys(E.data.monsters).length + ' monster types.';
    updTier();
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
    });
    for (const k of KEYS) $(k).addEventListener('change', () => {
      saveSel();
      if (k === 's_mode') { switchMode($('s_mode').value).catch((e) => { $('info1').textContent = 'Could not load data: ' + e; }); return; }
      updTier(); if (target1) runTab1(); if (bd.an) { syncUrl(); runFarm(); }
      if (bd.type && $('ar2').value) { fillMonsters(); requestTable(); }
    });
    $('s_act').addEventListener('change', () => { if (target1) runTab1(); });

    // tab 1
    T1 = makeTable($('tb1'), cols1, 'ptar', -1);
    T1.onSort = () => {};
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
      '<p><b>Per-run numbers are a rough estimate.</b> kills/run = area tiles x ' + C.run.areaFill + ' x MonDen/100000 packs x rarity share x average pack size, plus unique/champion packs from MonUMin/MonUMax ' +
      '(champion share ' + C.run.champShare + ', champion pack ' + C.run.champPackSize + ' monsters). Bosses and super uniques count as one kill per run.</p>' +
      '<p><b>Config in use</b> (Engine.CONFIG in engine.js): <code>' + esc(JSON.stringify(C)) + '</code></p>' +
      '<p>See README.md for formulas, research sources and limitations.</p>';
  }

  init().catch((e) => { document.body.insertAdjacentHTML('afterbegin', '<pre style="color:#e07a6a;padding:10px">' + esc(e.stack || e) + '</pre>'); });
})();
