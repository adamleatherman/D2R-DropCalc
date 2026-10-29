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
  const KEYS = ['s_mode', 's_tier', 's_diff', 's_players', 's_party', 's_mf', 's_quest', 's_tz', 's_clvl', 's_ladder', 's_act', 's_style', 's_tp', 's_map', 's_sunder', 's_ovh'];
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

  /** Ladder tooltip from the data's first/lastLadderSeason (uniques, set items, TCs) and CONFIG.currentSeason: what drops on ladder only right now,
   *  and which ladder windows have ended (those items drop on both). Follows the game mode and a season bump without edits. */
  function ladderTip() {
    const cur = E.CONFIG.currentSeason, now = [], ended = [];
    const add = (x, kind) => { if (!x.fl) return; const win = 'Season ' + x.fl + (x.ll && x.ll !== x.fl ? '-' + x.ll : '');
      if (x.fl <= cur && !(x.ll && x.ll < cur)) now.push(kind + x.n + ' (' + win + ')'); else if (x.ll && x.ll < cur) ended.push(kind + x.n + ' (' + win + ')'); };
    for (const u of E.data.uniques) if (u.sp) add(u, '');
    for (const s of E.data.sets) if (s.sp) add(s, 'set: ');
    for (const n in E.data.tc) { const t = E.data.tc[n]; if (t.fl) add({ n: n + ' (drop table)', fl: t.fl, ll: t.ll }, ''); }
    return 'Ladder-only drops in the game tables (data ' + E.data.meta.gameVersion + ', current season ' + cur + '):\n' + (now.length ? now.map((x) => '  ' + x).join('\n') : '  none in this game mode') +
      (ended.length ? '\nLadder windows that have ended (now drop on both):\n' + ended.map((x) => '  ' + x).join('\n') : '') +
      '\nRunewords are not modelled, so their ladder rules are not covered here.';
  }

  // ---------------- formatting ----------------
  /** css class of an item name in its in-game drop colour: uniques gold, set items green; runes, the Terror / Hate / Destruction keys, the four
   *  essences, Worldstone Shards and the Colossal Ancient statue pieces orange. t = a search index entry ({kind, code, ...}); anything else gets none. */
  const dropCls = (t) => !t ? '' : t.kind === 'unique' ? 'drop-unique' : t.kind === 'set' ? 'drop-set' : t.kind === 'base' && /^(r\d\d|pk[123]|tes|ceh|bet|fed|xa[1-5]|ua[1-5])$/.test(t.code) ? 'drop-orange' : '';
  const itKey = (t) => t.kind + '|' + (t.kind === 'base' ? t.code : t.id);   // a search index entry's key (data-it of item names)
  /** text (escaped) in the drop colour of item t; tip = hovering it shows the item tooltip (itemTipHtml) */
  const dropName = (t, text, tip) => tip && t && t.kind ? '<span class="itn ' + dropCls(t) + '" data-it="' + esc(itKey(t)) + '">' + esc(text) + '</span>'
    : dropCls(t) ? '<span class="' + dropCls(t) + '">' + esc(text) + '</span>' : esc(text);
  /** in-game style tooltip of item t: name (and base) in the drop colour, set, type and tier, required level, quality level, sockets.
   *  No stat lines: data.json has no unique / set item properties (build.py does not export them). */
  function itemTipHtml(t) {
    const u = t.kind === 'unique' ? E.uniqById[t.id] : t.kind === 'set' ? E.setById[t.id] : null, it = E.items[u ? u.code : t.code];
    if (!it) return '';
    const cls = dropCls(t), ln = (txt, c) => '<div' + (c ? ' class="' + c + '"' : '') + '>' + esc(txt) + '</div>';
    const tier = it.tier === 1 ? 'Exceptional' : it.tier === 2 ? 'Elite' : '';
    let h = ln(u ? u.n : it.n, cls);
    if (u) h += ln(it.n, cls);
    if (t.kind === 'set') h += ln(u.sn || u.set, 'tip-dim');
    h += ln(((E.types[it.t] || {}).n || it.t) + (tier ? ' \u00b7 ' + tier : ''), 'tip-dim');
    const req = u ? u.lr : it.lv;
    if (req > 0) h += ln('Required Level: ' + req);
    h += ln('Quality level ' + (u ? u.lvl + ' (base ' + it.q + ')' : it.q), 'tip-dim');
    const st = u ? E.itemStats(t.kind, t.id) : null;   // stat lines as the game lists them (magic blue), ranges in parentheses
    if (st) {
      for (const x of st.mods) h += ln(x, 'tip-stat');
      for (const [n, x] of st.smods) h += ln(x + ' (' + n + ' items)', 'tip-set');   // the item's own set bonuses (green in game)
      if (st.set && (st.set.p.length || st.set.f.length)) {
        h += ln((u.sn || u.set) + ' bonuses', 'tip-dim tip-gap');
        for (const [n, x] of st.set.p) h += ln(x + ' (' + n + ' items)', 'tip-set tip-small');
        for (const x of st.set.f) h += ln(x + ' (full set)', 'tip-full tip-small');
      }
    }
    if (it.gs > 0) h += ln('Max sockets: ' + it.gs, 'tip-gray');   // gray, like a socketed item in game
    return h;
  }
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
      let h = '<thead><tr>' + vcols.map((c) => '<th class="' + (c.l ? 'l' : '') + (c.hcls ? ' ' + c.hcls : '') + (c.cls ? ' ' + c.cls : '') + '" data-k="' + c.k + '"' + (c.note ? ' title="' + esc(c.note) + '"' : '') + '>' + esc(c.label) + (c.k === st.key ? (st.dir < 0 ? ' \u25be' : ' \u25b4') : '') + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of shown) h += '<tr' + (st.rowCls ? ' class="' + st.rowCls(r) + '"' : '') + '>' + vcols.map((c) => '<td class="' + (c.l ? 'l' : '') + (c.cls ? ' ' + c.cls : '') + '"' + (c.rtip ? ' title="' + esc(c.rtip(r)) + '"' : '') + '>' + (c.html ? c.html(r) : esc(c.fmt ? c.fmt(r) : c.get(r))) + '</td>').join('') + '</tr>';
      h += '</tbody>';
      el.innerHTML = h;
      return { total: rows.length, shown: shown.length };
    }
    el.addEventListener('click', (ev) => {
      const th = ev.target.closest('th'); if (!th) return;
      const k = th.dataset.k;
      if (st.key === k) st.dir = -st.dir; else { st.key = k; st.dir = -1; if (cols.find((c) => c.k === k).l) st.dir = 1; }
      const r = render();   // re-render on every header click; onSort (optional) refreshes what depends on the order
      if (st.onSort) st.onSort(r);
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
    { k: 'area', label: 'Area', l: 1, get: (r) => r.src.areaName, html: (r) => (r.src.areas ? '<span title="' + esc(r.src.areas.map((a) => a.name).join(', ')) + '">' + esc(r.src.areaName) + '</span>' : r.src.tombs === 7 ? '<span title="' + esc(TOMBS_TIP) + '">' + esc(r.src.areaName) + '</span>' : esc(r.src.areaName)) + (r.src.tz ? ' <span class="tz">TZ</span>' : '') },
    { k: 'diff', label: 'Diff', l: 1, get: (r) => r.src.diff, fmt: (r) => DIFF[r.src.diff].slice(0, 2) + (r.src.diff == 1 ? 'm' : '') },
    { k: 'act', label: 'Act', get: (r) => r.src.acts ? r.src.acts[0] : r.src.act, fmt: (r) => r.src.acts ? r.src.acts.join(', ') : r.src.act },
    { k: 'mlvl', label: 'mlvl', note: 'Monster level = the item level of its drops (champions and uniques include their bonus; items cap at 99). An area row: its lowest to highest.',
      get: (r) => r.src.mlvl, fmt: (r) => r.src.mlvlLo !== undefined && r.src.mlvlLo !== r.src.mlvl ? r.src.mlvlLo + '-' + r.src.mlvl : r.src.mlvl },
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
      ul.innerHTML = items.map((x, i) => '<li data-i="' + i + '">' + dropName(x, x.label) + '</li>').join('');
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
  /** chance of at least one success in k kills at p each: 1 - (1-p)^k (k may be fractional; log form keeps tiny p exact) */
  const runOf = (p, k) => p >= 1 ? 1 : -Math.expm1(k * Math.log1p(-p));
  const runP = (r) => r.runP !== undefined ? r.runP : r.src.quest ? r.c.target : runOf(r.c.target, r.src.perRun);   // a boss quest row: its run is the one quest kill
  const PCTS = [25, 50, 75, 90, 95, 99];
  const unit1 = () => kills1() ? 'kills' : 'runs';
  const per1 = (r) => kills1() ? r.c.target : runP(r);
  /** kills/run cell: heralds have no per-run chance, a boss quest row is the first kill only */
  const runsTxtOf = (src) => src.herald ? 'n/a' : src.quest ? 'first kill' : src.perRun < 10 ? src.perRun.toFixed(2) : src.perRun.toFixed(0);
  const srcLine = (p) => srcCols[0].html(p) + ' <span class="d">' + (p.src.herald ? 'n/a' : odds(runP(p)) + (p.src.quest ? ' on the quest kill' : ' per run')) + '</span>';
  const cols1 = [
    { k: 'name', get label() { return areaMode() ? 'Sources' : 'Monster'; }, l: 1, cls: 'c-mon', get: (r) => r.src.name,   // fixed width: a long minion list wraps
      html: (r) => r.parts ? '<details class="mem"><summary>' + r.parts.length + ' source' + (r.parts.length > 1 ? 's' : '') + '</summary>' + r.parts.map((p) => '<div>' + srcLine(p) + '</div>').join('') + '</details>' : srcCols[0].html(r),
      rtip: (r) => r.parts ? r.parts.map((p) => p.src.name + ': ' + odds(runP(p)) + ' per run').join('\n') : '' },
    srcCols[1], srcCols[2], srcCols[4],
    Object.assign({}, srcCols[3], { show: showQB }),
    { k: 'sTable', show: isSun, label: 'Sunder: table path', note: 'Data-driven: the Sunder Charms TC. RotW: only inside the Herald Item TCs (herald tier gates the extra item picks). LoD: inside the Hell desecrated champ/unique/super/boss TCs. Incl. player-count NoDrop.', get: (r) => r.sp ? r.sp.table : 0, fmt: (r) => odds(r.sp.table) },
    { k: 'sMf', show: isSun, label: 'Sunder: MF path', note: 'Data-driven: the PreCrafted Sunders are spawnable unique grand charms (rarity 1, lvl 75, DropConditionCalc Hell only), so a unique cm3 roll can pick one.', get: (r) => r.sp ? r.sp.mf : 0, fmt: (r) => odds(r.sp.mf) },
    { k: 'sTotal', show: isSun, label: 'Sunder: total', note: 'Combined chance of both paths.', get: (r) => r.sp ? r.sp.total : 0, fmt: (r) => odds(r.sp.total) },
    { k: 'pbase', show: showQB, label: 'P(base)', get: (r) => r.c.base, fmt: (r) => odds(r.c.base) },
    { k: 'plow', show: isWhiteBase, hcls: 'q-low', label: 'P(low)', note: 'Low quality (crude/cracked/damaged/low quality) base. Boss, champion and unique TCs force Magic=1024, so this is 0 there.', get: (r) => r.c.low, fmt: (r) => odds(r.c.low) },
    { k: 'pnorm', show: isWhiteBase, label: 'P(normal)', note: 'Normal quality base (what is left after unique/set/rare/magic/superior/low).', get: (r) => r.c.normal, fmt: (r) => odds(r.c.normal) },
    { k: 'psup', show: isWhiteBase, label: 'P(superior)', note: 'Superior quality base.', get: (r) => r.c.hq, fmt: (r) => odds(r.c.hq) },
    { k: 'pmag', show: showQB, hcls: 'q-magic', note: QNOTE, label: 'P(magic)', get: (r) => r.c.magic, fmt: (r) => odds(r.c.magic) },
    { k: 'prare', show: showQB, hcls: 'q-rare', note: QNOTE, label: 'P(rare)', get: (r) => r.c.rare, fmt: (r) => odds(r.c.rare) },
    { k: 'pset', show: showQB, hcls: 'q-set', note: QNOTE, label: 'P(set)', get: (r) => r.c.set, fmt: (r) => odds(r.c.set) },
    { k: 'puni', show: showQB, hcls: 'q-unique', note: QNOTE, label: 'P(unique)', get: (r) => r.c.unique, fmt: (r) => odds(r.c.unique) },
    { k: 'ptar', label: 'Chance per kill', get note() { return 'Chance that one kill drops the target (shown as odds; sorts by probability).' + (areaMode() ? ' Area rows: the average over all kills of an area clear.' : ''); }, get: (r) => r.c.target, fmt: (r) => odds(r.c.target) },
    { k: 'runs', label: 'kills/run', get: (r) => r.src.perRun, fmt: (r) => runsTxtOf(r.src) },
    { k: 'perrun', label: 'Chance per run', get note() { return 'Chance of finding the target at least once in one run: 1 - (1 - per-kill chance)^(kills/run) (kills/run is a rough model; shown as odds).' + (areaMode() ? ' Area rows combine all their sources the same way.' : ''); }, get: runP, fmt: (r) => odds(runP(r)) },
    { k: 'n50', get label() { return unit1() + ' for 50%'; }, get note() { return 'Number of ' + unit1() + ' needed to have found the target with 50% probability: ceil(ln(0.5) / ln(1-p)). Counts kills while the table is sorted by a per-kill column, runs otherwise. Hover a cell for 25/50/75/90/95/99%.'; },
      get: per1, fmt: (r) => r.src.quest && !kills1() ? '-' : countFmt(E.trialsFor(per1(r), 0.5)), rtip: (r) => r.src.quest && !kills1() ? 'The quest kill happens once per character and difficulty.' : PCTS.map((q) => q + '%: ' + countFmt(E.trialsFor(per1(r), q / 100)) + ' ' + unit1()).join('\n') },
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
  /** Group by area: one row per area / difficulty / terror-zone flag. Per-run chance = 1 - prod over the sources of (1 - p)^kills (at least one drop
   *  in a full clear). Per-kill values are kill-weighted averages. Herald rows (no per-run) are left out. */
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
      const p = -Math.expm1(parts.reduce((a, r) => a + r.src.perRun * Math.log1p(-Math.min(r.c.target, 1)), 0));
      const c = {}; for (const key in parts[0].c) c[key] = wavg(parts, kills, (r) => r.c[key]);
      const sp = parts[0].sp ? { table: wavg(parts, kills, (r) => r.sp.table), mf: wavg(parts, kills, (r) => r.sp.mf), total: wavg(parts, kills, (r) => r.sp.total) } : null;
      parts.sort((x, y) => runP(y) - runP(x));
      return { src: { name: s0.areaName, areaName: s0.areaName, diff: s0.diff, act: s0.act, tz: s0.tz, rank: 'regular', mlvl: Math.max(...parts.map((r) => r.src.mlvl)), mlvlLo: Math.min(...parts.map((r) => r.src.mlvl)), perRun: kills, tombs: parts.some((r) => r.src.tombs === 7) ? 7 : 0 }, c, sp, runP: p, parts };
    });
  }
  const actsOf = (src) => src.acts || [src.act];
  /** text filter on a source; a merged herald row also matches any covered area name (areaName itself is only the count) */
  const textHit = (src, f) => (src.name + ' ' + (src.members || []).join(' ') + ' ' + src.mon + ' ' + src.areaName + ' ' + (src.areas || []).map((a) => a.name).join(' ')).toLowerCase().indexOf(f) >= 0;
  /** a merged herald row narrowed to the areas the Act and source filters let through (its other fields stay) */
  function narrowHerald(src, act, f) {
    if (!src.areas) return src;
    const own = f && (src.name + ' ' + src.members.join(' ') + ' ' + src.mon).toLowerCase().indexOf(f) >= 0;   // matched by monster: every area stays
    const areas = src.areas.filter((a) => (!act || E.data.levels[a.id].act === act) && (!f || own || a.name.toLowerCase().indexOf(f) >= 0));
    if (areas.length === src.areas.length) return src;
    return Object.assign({}, src, { areas, acts: Array.from(new Set(areas.map((a) => E.data.levels[a.id].act))).sort(), areaName: areas.length + ' of ' + src.areas.length + ' terror-zone areas' });
  }
  const TOMBS_TIP = "All seven tombs in one run: the true (staff) tomb, Ancient Kaa's tomb and five plain tombs, each with its own size. The true tomb alone has about 29% of the kills and 15% of the champion / unique packs (tab 2: Tal Rasha's Tombs: true tomb).";
  const srcWhere = (src) => src.name + ' in ' + src.areaName + ' (' + DIFF[src.diff] + ')';
  const runsTxt = (p) => p >= 1 ? 'always' : odds(p) + ' runs';
  const lowest = (rows) => rows.reduce((a, r) => !a || r.src.mlvl < a.src.mlvl ? r : a, null);
  /** why nothing is listed: which filters exclude it (and what would work), else why no source can drop it at all. fails[i] = the filters row i fails. */
  function whyEmpty(all, fails, ctx, list, sel, it, bq) {
    const act = [];   // active filters: [id, text]
    if (sel.diff >= 0) act.push(['diff', 'Difficulty ' + DIFF[sel.diff]]);
    if (sel.act) act.push(['act', 'Act ' + sel.act]);
    if (ranks1().length) act.push(['rank', 'Rank ' + ranks1().join(' / ')]);
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
        : id === 'act' ? txt + ': it drops in act ' + Array.from(new Set(ok.flatMap((r) => actsOf(r.src)))).sort().join(', ')
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

  /** the ranks ticked in the Rank filter; [] = all */
  const ranks1 = () => Array.from(document.querySelectorAll('#r1 input:checked')).map((i) => i.value);
  function rankSummary1() { const r = ranks1(); $('r1s').textContent = !r.length ? 'All' : r.length <= 2 ? r.join(', ') : r.length + ' ranks'; }
  function runTab1() {
    if (!target1) return;
    const sel = S = readSel(); saveSel();
    const t0 = performance.now();
    const { ctx, list } = getSources(sel);
    const f = $('f1').value.trim().toLowerCase(), rk = ranks1();
    $('l_bq1').hidden = !isWhiteBase();
    const bq = isWhiteBase() ? $('bq1').value : '';
    const all = allRows(sel, ctx, list, bq);
    const fails = all.rows.map((r) => {
      const src = r.src, x = [];
      if (sel.diff >= 0 && src.diff !== sel.diff) x.push('diff');
      if (sel.act && actsOf(src).indexOf(sel.act) < 0) x.push('act');
      if (rk.length && rk.indexOf(src.rank) < 0) x.push('rank');
      if (sel.tz && !src.tz) x.push('tz');
      if (f && !textHit(src, f)) x.push('text');
      return x;
    });
    const mon = all.rows.filter((r, i) => !fails[i].length);
    if (isSun()) for (const r of mon) if (r.sp === undefined) r.sp = E.sunderPaths(ctx, r.src, target1.id, sel.mf);
    const rows = areaMode() ? groupAreas(mon) : mon.map((r) => r.src.areas && (sel.act || f) ? Object.assign({}, r, { src: narrowHerald(r.src, sel.act, f) }) : r);
    T1.rows = rows; T1.limit = parseInt($('n1').value, 10);
    const r = T1.render();
    const it = target1.kind === 'base' ? E.items[target1.code] : E.items[(target1.kind === 'unique' ? E.uniqById : E.setById)[target1.id].code];
    // headline: best per kill (monster rows), best per run (area rows in area mode, else monster rows)
    const best = (rs, g) => rs.reduce((a, x) => !a || g(x) > g(a) ? x : a, null);
    const bk = best(mon, (x) => x.c.target), br = best(areaMode() ? rows : mon.filter((x) => !x.src.herald && !x.src.quest), runP);   // a quest kill is not repeatable
    let hl = '<b>' + dropName(target1, target1.label, true) + '</b>';
    if (bk) hl += ' &middot; best per kill: ' + esc(srcWhere(bk.src)) + ', <b>' + odds(bk.c.target) + '</b>';
    if (br && runP(br) > 0) hl += ' &middot; best per run: ' + esc(areaMode() ? br.src.areaName + ' (' + DIFF[br.src.diff] + ')' : srcWhere(br.src)) + ', <b>' + runsTxt(runP(br)) + '</b>, ~' + countFmt(E.trialsFor(runP(br), 0.5)) + ' runs for 50% / ~' + countFmt(E.trialsFor(runP(br), 0.9)) + ' for 90%';
    $('hl1').innerHTML = hl;
    const bkc = best(mon.filter((x) => !x.src.quest), (x) => x.c.target);   // the charts' per-kill source: a quest kill is not repeatable
    chIn = { sel, ctx, br, bk: bkc, bq }; renderCharts1();
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
      '  MF=' + sel.mf + '%' + (sel.quest ? '  |  boss quest rows shown (first kill only)' : '') + (bq ? '  |  base quality: ' + BQN[bq] : '') + '  |  ' + Math.round(performance.now() - t0) + ' ms. Click a column header to sort.';
  }

  // ---------------- Tab 3: popular farms / what drops here (reverse lookup) ----------------
  // One source -> per-kill chance of everything it drops (E.dropsOf, same numbers as chanceFor); an area clear adds up the sources' per-run chances like Tab 1's Group by Area.
  let T3 = null, c3 = { sig: '', rows: [] };
  let pick3 = null;   // the item picked from the Item filter's suggestions (its itKey): the table shows only it and the charts appear; typing again clears it
  const d3Diff = () => { const d = parseInt($('s_diff').value, 10); return d < 0 ? 2 : d; };   // All difficulties -> Hell
  /** potions (also throwing), arrows, bolts, the plain key and the Town Portal / Identify scrolls and tomes: never listed (the Terror / Hate / Destruction
   *  keys are quest items, type ques; the Scroll of Knowledge stays) */
  const junk3 = (code) => { const it = E.items[code]; return !!it && (it.t === 'key' || /^(tsc|isc|tbk|ibk)$/.test(code) || it.anc.some((a) => a === 'poti' || a === 'tpot' || a === 'bowq' || a === 'xboq')); };
  const kind3 = (t) => t.kind !== 'base' ? t.kind : /^r\d\d$/.test(t.code) ? 'rune' : /^(cm[123]|jew|cjw)$/.test(t.code) ? 'charm' : junk3(t.code) ? 'junk' : 'base';
  const KINDS3 = ['unique', 'set', 'rune', 'charm', 'base'];
  const kinds3 = () => Array.from(document.querySelectorAll('#k3 input:checked')).map((i) => i.value);   // none ticked = all kinds
  function kindSummary3() { const k = kinds3(); $('k3s').textContent = !k.length || k.length === KINDS3.length ? 'All kinds' : k.length <= 2 ? k.map((x) => $('k3').querySelector('input[value="' + x + '"]').parentNode.textContent.trim()).join(', ') : k.length + ' kinds'; }
  const KIND3 = { unique: 'unique', set: 'set item', rune: 'rune', charm: 'charm', base: 'base' };
  const base3 = (r) => r.t.kind === 'base' ? '' : E.items[r.t.code].n;
  const PCT3 = (r) => r.runP;
  // minutes per game of the chosen farm (tab 2): the override typed for it, else Engine.farmMinutes from the "Your game" settings; null = none (Other area without a typed value)
  const FTKEYS = ['s_style', 's_tp', 's_map', 's_sunder', 's_ovh'];
  const ovh3 = () => { const v = parseFloat($('s_ovh').value); return isNaN(v) ? E.CONFIG.farmTime.overhead : Math.max(0, Math.min(10, v)); };
  const farm3 = () => E.CONFIG.farms[parseInt($('pf3').value, 10)];
  const minKey3 = () => { const f = farm3(); return f ? f.name : 'other|' + $('ar3').value + '|' + $('mo3').value; };
  const lsMin = () => { try { return JSON.parse(localStorage.getItem('d2dc-min3')) || {}; } catch (e) { return {}; } };
  const calcMin3 = () => { const f = farm3(); return f ? E.farmMinutes(f, { style: $('s_style').value, teleport: $('s_tp').value, map: $('s_map').value, sunder: $('s_sunder').checked, overhead: ovh3() }) : null; };
  const mins3 = () => { const o = parseFloat($('min3').value); return o > 0 ? o : calcMin3(); };
  const perHour3 = (r) => { const m = mins3(); return m && !c3.quest ? -Math.expm1(Math.log1p(-Math.min(r.runP, 1)) * 60 / m) : 0; };   // 1 - (1 - runP)^(60 / minutes)
  const cols3 = [
    { k: 'name', label: 'Item', l: 1, get: (r) => r.t.name, html: (r) => dropName(r.t, r.t.name, true) + ' <span class="tag ' + r.kind + '">' + (r.kind === 'charm' && /^(jew|cjw)$/.test(r.t.code) ? 'jewel' : KIND3[r.kind]) + '</span>' },   // jewels sit under the "Charms and jewels" filter but keep their own tag
    { k: 'base', label: 'Base', l: 1, cls: 'c-base', get: base3, html: (r) => esc(base3(r)) },
    { k: 'pk', get label() { return c3.one ? 'Chance per kill' : 'Chance per kill (average)'; }, note: 'Chance that one kill drops the item (shown as odds). A whole area clear: the average over all its kills.', get: (r) => r.pk, fmt: (r) => odds(r.pk) },
    { k: 'kills', label: 'kills/run', show: () => c3.one, get: () => c3.kills, fmt: () => c3.quest ? 'first kill' : c3.kills < 10 ? c3.kills.toFixed(2) : c3.kills.toFixed(0) },
    { k: 'perrun', label: 'Chance per run', note: 'Chance of finding the item at least once in one run: 1 - (1 - per-kill chance)^(kills/run), over every source of an area clear (kills/run is a rough model; same numbers as Tab 1).', get: PCT3, fmt: (r) => odds(r.runP) },
    { k: 'n50', label: 'runs for 50%', note: 'Runs needed to have found the item with 50% probability: ceil(ln(0.5) / ln(1-p)). Hover a cell for 25/50/75/90/95/99%.', get: PCT3, fmt: (r) => c3.quest ? '-' : countFmt(E.trialsFor(r.runP, 0.5)), rtip: (r) => c3.quest ? 'The quest kill happens once per character and difficulty.' : PCTS.map((q) => q + '%: ' + countFmt(E.trialsFor(r.runP, q / 100)) + ' runs').join('\n') },
    { k: 'ph', label: 'Chance per hour', show: () => !!mins3(), note: 'Chance of finding the item at least once in an hour of this farm: 1 - (1 - chance per run)^(60 / min per game). Only as good as the minutes.', get: perHour3, fmt: (r) => perHour3(r) ? odds(perHour3(r)) : '-' },
    { k: 'h50', label: 'hours for 50%', show: () => !!mins3(), note: 'Hours of this farm to have found the item with 50% probability: runs for 50% x min per game / 60.', get: (r) => c3.quest || !(r.runP > 0) ? Infinity : E.trialsFor(r.runP, 0.5) * mins3() / 60, fmt: (r) => c3.quest || !(r.runP > 0) ? '-' : (h => h < 10 ? h.toFixed(2) : countFmt(Math.round(h)))(E.trialsFor(r.runP, 0.5) * mins3() / 60) },
  ];
  /** source key of a popular farm (E.CONFIG.farms) at difficulty d: an act boss's key carries the difficulty */
  const farmKey3 = (f, d) => f.src.indexOf('boss|') === 0 ? f.src + '|' + d : f.src;
  let min3Key = null;   // the farm (or area / source) whose override the Minutes/game box shows
  function runTab3() {
    const area = parseInt($('ar3').value || '0', 10);
    const fi = E.CONFIG.farms.findIndex((f) => f.area === area && farmKey3(f, d3Diff()) === $('mo3').value);   // the farm the Area / Source pair matches (a deep link), else Other area
    if ($('pf3').value !== 'other') { if (fi >= 0) $('pf3').value = String(fi); else if (area) $('pf3').value = 'other'; }   // Other stays open while picking there
    $('custom3').hidden = $('pf3').value !== 'other';
    { const k = minKey3(); if (min3Key !== k) { min3Key = k; $('min3').value = lsMin()[k] || ''; } const m = calcMin3(); $('min3').placeholder = m ? m.toFixed(1) : '-'; }   // the override of this farm (area) in the box; the estimate as its placeholder
    if (!area) { T3.rows = []; T3.render(); renderCharts3(); $('info3').textContent = $('pf3').value === 'other' ? 'Choose an area (and optionally one monster) to list what it drops, best first. Click an item to search it in tab 1.' : 'Choose a farm to list what it drops, best first (Other area... for any area or monster). Click an item to search it in tab 1.'; return; }
    const sel = S = readSel(), t0 = performance.now(), diff = d3Diff(), key = $('mo3').value;
    const { ctx, list } = getSources(sel);
    const run = key.indexOf('run|') === 0 ? key.slice(4) : '';   // a named run (E.CONFIG.runs, e.g. the seal pop): its fixed kills instead of one source or the whole clear
    const srcs = run ? E.runSources(ctx, run, diff, list) : list.filter((s) => s.area === area && s.diff === diff && (!sel.tz || s.tz) && !s.herald && (key ? s.key === key : !s.quest));   // a whole area clear leaves out the boss quest rows (first kill only)
    const sig = JSON.stringify([srcCache.sig, area, diff, key, sel.ladder, sel.mf]);
    if (c3.sig !== sig) {
      const acc = new Map(), kills = srcs.reduce((a, s) => a + s.perRun, 0), one = srcs.length === 1, wsum = srcs.reduce((a, s) => a + (one ? 1 : s.perRun), 0);
      for (const src of srcs) {
        const d = E.dropsOf(ctx, src, sel.mf), w = one ? 1 : src.perRun;
        for (const [kind, m] of [['base', d.base], ['unique', d.unique], ['set', d.set]]) for (const [id, p] of m) {
          const a = acc.get(kind + '|' + id) || acc.set(kind + '|' + id, { pw: 0, lm: 0 }).get(kind + '|' + id);
          a.pw += p * w; a.lm += (src.quest ? 1 : src.perRun) * Math.log1p(-Math.min(p, 1));   // log of the chance to miss it all run; a boss quest row: its run is the one quest kill
        }
      }
      const rows = [];
      for (const t of INDEX) {
        const a = acc.get(t.kind + '|' + (t.kind === 'base' ? t.code : t.id));
        if (a && a.pw > 0) rows.push({ t, kind: kind3(t), pk: a.pw / wsum, runP: -Math.expm1(a.lm), text: (t.name + ' ' + (t.kind === 'base' ? '' : E.items[t.code].n)).toLowerCase() });
      }
      c3 = { sig, rows, one, kills, quest: one && !!srcs[0].quest, n: srcs.length, run, ms: 0 };
    }
    const ks = kinds3(), f = $('f3').value.trim().toLowerCase();
    T3.rows = c3.rows.filter((r) => r.kind !== 'junk' && (!ks.length || ks.indexOf(r.kind) >= 0) && (pick3 ? itKey(r.t) === pick3 : !f || r.text.indexOf(f) >= 0));
    T3.limit = parseInt($('n3').value, 10);
    const r = T3.render(), an = c3.run ? E.CONFIG.runs[c3.run].name : $('ar3').selectedOptions[0].textContent.replace(/^Act \d+ - /, '');   // a run can span areas: its own name leads
    $('info3').textContent = an + ' (' + DIFF[diff] + (sel.diff < 0 ? ', difficulty All shows Hell' : '') + '): ' + (c3.one ? srcs[0].name : (c3.run ? '' : 'whole area clear, ') + c3.n + ' source' + (c3.n === 1 ? '' : 's') + ', ' + c3.kills.toFixed(0) + ' kills/run') + '  |  ' +
      r.total.toLocaleString() + ' items (showing ' + r.shown + ')  |  N=' + ctx.N + '  MF=' + sel.mf + '%' + (sel.tz && E.data.tz.herald.length && diff === 2 ? '  |  herald rows are left out (no per-run chance; pick them in tab 1)' : '') + (c3.n ? '' : '  |  no source here with these settings') +
      (mins3() ? '  |  ' + mins3().toFixed(1) + ' min/game' + (parseFloat($('min3').value) > 0 ? ' (your value)' : ' (rough estimate from Your game; type your own next to Farm)') : '') +
      '  |  ' + Math.round(performance.now() - t0) + ' ms. Click a header to sort, a row to search it in tab 1.';
    renderCharts3(); sync3();
  }
  /** ?t3a=<area id>&t3m=<source key>&t3k=<kind> (tab 3 opens when t3a is present) */
  function sync3() {
    try {
      const qs = new URLSearchParams(location.search);
      for (const k of ['t3a', 't3m', 't3k']) qs.delete(k);
      if ($('ar3').value) { qs.set('t3a', $('ar3').value); if ($('mo3').value) qs.set('t3m', $('mo3').value); const ks = kinds3().join(','); if (ks !== 'unique,set,rune,charm') qs.set('t3k', ks || 'all'); }
      history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs.toString() : ''));
    } catch (e) { /* ignore */ }
  }
  const fill3 = () => fillMonsters('ar3', 'mo3', d3Diff());
  function initTab3() {
    T3 = makeTable($('tb3'), cols3, 'perrun', -1);
    T3.rowCls = () => 'clk';
    T3.onRow = (r) => {   // -> tab 1 searching that item
      target1 = r.t; $('q1').value = r.t.label; $('f1').value = '';
      for (const i of document.querySelectorAll('#r1 input')) i.checked = false;
      rankSummary1(); $('t1').click(); runTab1();
    };
    let act = 0, opts = '';   // one group per act (the farms are in act order)
    E.CONFIG.farms.forEach((f, i) => {
      const a = E.data.levels[f.area].act;
      if (a !== act) { opts += (act ? '</optgroup>' : '') + '<optgroup label="Act ' + a + '">'; act = a; }
      opts += '<option value="' + i + '">' + esc(f.name) + '</option>';
    });
    $('pf3').innerHTML = '<option value="">Choose a farm</option>' + opts + '</optgroup><option value="other">Other area...</option>';
    $('pf3').addEventListener('change', () => {   // a farm sets Area and Source (hidden); a source that does not exist with these settings leaves the whole area clear
      const f = E.CONFIG.farms[parseInt($('pf3').value, 10)];
      if (!f) { $('ar3').value = ''; fill3(); runTab3(); return; }   // Choose a farm / Other area...: start from an empty area (Other shows Area and Source)
      $('ar3').value = String(f.area); fill3();
      const k = farmKey3(f, d3Diff());
      if (Array.from($('mo3').options).some((o) => o.value === k)) $('mo3').value = k;
      runTab3();
    });
    $('ar3').addEventListener('change', () => { fill3(); runTab3(); });
    $('mo3').addEventListener('change', runTab3);
    $('min3').addEventListener('input', () => {   // an override of the minutes, remembered per farm
      try { const o = lsMin(), v = parseFloat($('min3').value); if (v > 0) o[minKey3()] = v; else delete o[minKey3()]; localStorage.setItem('d2dc-min3', JSON.stringify(o)); } catch (e) { /* ignore */ }
      runTab3();
    });
    $('k3').addEventListener('change', () => { kindSummary3(); runTab3(); });
    document.addEventListener('click', (ev) => { if (!$('k3').contains(ev.target)) $('k3').open = false; });   // the kind list closes on a click elsewhere
    $('n3').addEventListener('change', runTab3);
    // Item filter: typing narrows the table by text and suggests this farm's items (as tab 1's search); picking one shows only it, with its charts
    autocomplete($('f3'), $('ac3'), () => { const seen = new Set(), ks = kinds3(); return c3.rows.filter((r) => r.kind !== 'junk' && (!ks.length || ks.indexOf(r.kind) >= 0) && !seen.has(itKey(r.t)) && seen.add(itKey(r.t))).map((r) => r.t); }, (x) => { pick3 = itKey(x); runTab3(); });
    $('f3').addEventListener('input', () => { pick3 = null; clearTimeout(runTab3.t); runTab3.t = setTimeout(runTab3, 250); });
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
  let bd = { type: null, codes: [], stats: new Map(), fams: new Map(), tierRows: [], sel: [], picks: [], rows: [], an: null, farm: null, farmQ: [], wts: null, wlabel: '' };
  let tableWorker = null, farmWorker = null, tableId = 0, farmId = 0;
  const OJ = { odds: { id: 0, w: null }, curve: { id: 0, w: null } };   // the card-odds and the best-item-level jobs: one long-lived worker each
  /** remember a checkbox in localStorage (try/catch: storage can be blocked) */
  const lsGet = (k) => { try { return localStorage.getItem(k) === '1'; } catch (e) { return false; } };
  const lsOpen = (k) => { try { return localStorage.getItem(k) !== '0'; } catch (e) { return true; } };   // a section that is open unless the user closed it
  const lsSet = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) { /* ignore */ } };
  const showOdds = () => $('odds2').checked;

  const cols2 = srcCols.concat(QS_ALL.map((q) => ({ k: 'p' + q, hcls: { low: 'q-low', magic: 'q-magic', rare: 'q-rare' }[q] || '', label: 'P(' + (q === 'sup' ? 'superior' : q === 'low' ? 'low' : q) + ')', show: () => bd.farmQ.indexOf(q) >= 0,
    note: 'Chance per kill of a ' + QCOLN[q].toUpperCase() + ' item of the type with the combination (exact).', get: (r) => r.pq[q] || 0, fmt: (r) => odds(r.pq[q] || 0) })), [
    { k: 'ptot', label: 'P per kill', note: 'Chance that one kill drops a matching item (sum over every base of the type and the possible qualities; shown as odds, sorts by probability).', get: (r) => r.pTotal, fmt: (r) => odds(r.pTotal) },
    { k: 'runs', label: 'kills/run', get: (r) => r.src.perRun, fmt: (r) => runsTxtOf(r.src) },
    { k: 'perrun', label: 'P per run', note: 'Chance of at least one matching item from the kills of this row in one run of its area: 1 - (1 - P per kill)^(kills/run) (rough model; shown as odds). The best per run above combines every row of an area the same way.', get: (r) => r.perRun, fmt: (r) => odds(r.perRun) },
    { k: 'go1', label: 'Tab 1', note: 'Open tab 1 filtered to this monster / area (with the base as the target when the builder has a single base)', get: () => 0, html: () => '<a href="#" class="go1">search</a>' },
  ]);
  const typeLabel = (t) => t.name + (t.cls ? ' (' + (CLASSN[t.cls] || t.cls) + ')' : '') + (t.broad ? ' - broad group' : '') + ' - ' + t.codes.length + ' bases';
  const effTier = () => parseInt($('tr2').value, 10);
  const effIlvl = () => { const v = clampInt($('il2'), 1, 99); $('ilr2').value = v; $('av2t').textContent = 'available at item level ' + v; return v; };
  function curCodes() {
    if (!bd.type) return [];
    return bd.type.kind === 'base' ? [bd.type.code] : E.builderBases(bd.type.code, effTier());
  }
  const baseName = (c) => E.items[c].n;
  const tierName = (c) => ['', 'exceptional', 'elite'][E.items[c].tier] || '';
  const condsOf = () => bd.sel.map((s) => { const st = bd.stats.get(s.key); return st && st.le ? { key: s.key, min: s.thr, le: true } : { key: s.key, min: s.thr }; });
  /** the stat line of a row: "+0.5 to Maximum Damage per Character Level (+42 at your level 85) (or more)"; "+40% Faster Run/Walk . fixed" when a single value is allowed */
  const statText = (s) => {
    const st = bd.stats.get(s.key), fx = st && !st.flag ? fixedOf(s) : null, d = E.perLevelDiv(s.key), cl = clampInt($('s_clvl'), 1, 99);
    return E.describeAt(s.key, s.thr, st && st.v) + (d ? ' (+' + E.perLevelAt(s.key, s.thr, cl) + ' at your level ' + cl + ')' : '') +
      (st && st.flag ? '' : fx ? ' \u00b7 fixed' + (fx.squeezed ? ' by your other picks' : '') : st && st.le ? '  (or lower)' : '  (or more)');
  };

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
    if (kind === 'odds' || kind === 'curve') return runOddsJob(kind, msg, onDone, fallback);
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

  /** the card-odds job: one long-lived worker (it keeps the rare sample cache, so a busy one is never terminated); a request that arrives while it works waits as `next`
   *  (only the newest is kept) and only the newest id is delivered */
  function runOddsJob(kind, msg, onDone, fallback) {
    const J = OJ[kind], id = ++J.id;
    const w = J.w || (J.w = newWorker());
    if (!w) { setTimeout(() => { if (id === J.id) onDone(fallback()); }, 20); return id; }
    const send = (job) => { w.busy = true; w.job = job; w.postMessage(Object.assign({ id: job.id, file: DATAFILE[E.mode] }, job.msg)); };
    w.onmessage = (ev) => {
      const m = ev.data, job = w.job; if (!job || m.id !== job.id) return;
      w.busy = false; w.job = null;
      const nx = w.next; w.next = null; if (nx) send(nx);
      if (job.id === J.id) { if (m.type === 'result') job.onDone(m.rows, null, m); else job.onDone(null, m.message); }
    };
    if (w.busy) w.next = { id, msg, onDone }; else send({ id, msg, onDone });
    return id;
  }

  // ----- the affix table (every prefix / suffix / automagic row / staff skill that can roll on the type) -----
  const POIS_TIP = 'Poison damage is the total the item tooltip shows (per-frame value x frames / 256). Poison from several sources adds the damage per frame, but the lengths are summed and divided by the number of poison sources when you hit (LoD 1.10-1.14 decompilation), so with two sources you get (sum of both per-frame values) x (half the summed length), usually well below the summed tooltip total.';
  const sideTag = (r) => '<span class="side ' + r.side + '">' + r.side + '</span>';
  const lvWindow = (r) => r.minIl === null ? '-' : r.maxIl >= 99 ? 'from ilvl ' + r.minIl : 'ilvl ' + r.minIl + ' to ' + r.maxIl;
  /** a stat value as the data keeps it, shown as the game does (per-character-level rates in their units: 4 -> 0.5) */
  const valTxt = (key, v) => { const d = E.perLevelDiv(key); return d ? String(Math.round(v / d * 1000) / 1000) : String(v); };
  const rngTxt = (t) => t.mods.map((m) => m.min === m.max ? valTxt(m.key, m.min) : valTxt(m.key, m.min) + '-' + valTxt(m.key, m.max)).join(' / ');
  /** tiers of a family: "ilvl 28 [2-4]; ilvl 35 [6-12]" (lowest item level at which some base rolls the tier, and its range) */
  const tierText = (f) => f.tiers.map((t) => 'ilvl ' + (t.minIl === null ? '?' : t.minIl) + ' [' + rngTxt(t) + ']').join('; ');
  /** hover of the tiers cell: affix level and level requirement of each tier, and (bases differ: broad types) the tiers each base can roll */
  function tierTip(f) {
    const out = f.tiers.map((t) => 'ilvl ' + t.minIl + (t.maxIl !== null && t.maxIl < 99 ? ' to ' + t.maxIl : '+') + ': ' + rngTxt(t) + ' (affix level ' + t.lvl + ', req. level ' + t.lr + ')'), codes = Array.from(new Set([].concat(...f.tiers.map((t) => t.codes))));
    if (f.tiers.some((t) => t.codes.length !== codes.length)) {
      out.push('', 'Per base:');
      const MAXL = 30;
      for (const c of codes.slice(0, MAXL)) out.push(baseName(c) + ': ' + f.tiers.filter((t) => t.codes.indexOf(c) >= 0).map((t) => '[' + rngTxt(t) + '] from ilvl ' + t.minIl).join('; '));
      if (codes.length > MAXL) out.push('... and ' + (codes.length - MAXL) + ' more');
    }
    out.push('', 'Rows: ' + f.rows.map((r) => r.id).join(', '));
    return out.join('\n');
  }
  /** the other affixes of a row's group on the current bases (same side; prefix and suffix groups are numbered apart): their first stat, or the
   *  affix name when it has the row's own stat (another tier family like of Pacing / of Speed) */
  let matesRows = null, matesMap = new Map();
  const statLabel = (r) => (r.mods.length ? r.mods[0].key.replace(/[+-]?#%?/g, '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim().replace(/^to /, '') : r.name);
  function matesOf(r) {
    if (!r.g) return [];
    if (matesRows !== bd.rows) { matesRows = bd.rows; matesMap = new Map(); }
    let m = matesMap.get(r.id);
    if (!m) {
      const own = statLabel(r);
      m = Array.from(new Set(bd.rows.filter((x) => x.id !== r.id && x.g === r.g && x.side === r.side).map((x) => (statLabel(x) === own ? x.name : statLabel(x)))));
      matesMap.set(r.id, m);
    }
    return m;
  }
  const matesTxt = (r) => { const m = matesOf(r); return m.length > 3 ? m.slice(0, 2).join(', ') + ' +' + (m.length - 2) + ' more' : m.join(', '); };
  const colsA = [
    { k: 'name', label: 'Name', l: 1, get: (r) => r.name.toLowerCase(), html: (r) => esc(r.name) + ' ' + sideTag(r) + (pickIds().has(r.id) ? ' <span class="picked-tag">picked</span>' : fitOf(r) ? '' : ' <span class="nofit-tag">doesn\'t fit</span>') },
    { k: 'desc', label: 'Description (all tiers)', l: 1, get: (r) => r.desc.toLowerCase(), html: (r) => r.desc.indexOf('poison damage over') >= 0 ? '<span title="' + esc(POIS_TIP) + '">' + esc(r.desc) + '</span>' : esc(r.desc) },
    { k: 'il', label: 'Can roll at', note: 'Item levels at which some base of the type can roll this affix: "from ilvl 18" or a window "ilvl 24 to 35" (affix max level, staff skill tiers).', get: (r) => r.minIl === null ? 999 : r.minIl, fmt: lvWindow },
    { k: 'tiers', label: 'Tiers', l: 1, note: 'One entry per tier of the affix: the lowest item level at which some base can roll it and its range. Hover for the affix level and level requirement of each tier (and, for broad types, the tiers each base can roll).', get: (r) => r.tiers.length, html: (r) => esc(tierText(r)), tip: tierTip },
    { k: 'lvl', label: 'Affix lvl', note: 'Affix level (of the lowest tier). Staff skills have a tier instead.', get: (r) => r.lvl === null ? r.tier : r.lvl, fmt: (r) => r.lvl === null ? (r.tier ? 'tier ' + r.tier : '-') : r.lvl },
    { k: 'lr', label: 'Req lvl', note: 'Character level the affix requires (levelreq; of the lowest tier).', get: (r) => r.lr === null ? 0 : r.lr, fmt: (r) => r.lr === null ? '-' : r.lr },
    { k: 'cls', label: 'Class', l: 1, get: (r) => r.cls, fmt: (r) => r.cls ? (CLASSN[r.cls] || r.cls) + ' only' : '' },
    { k: 'grp', label: 'Excludes', l: 1, note: 'The other affixes of its group (same side) on these bases: affixes of one group never appear together on one item. Hover for the full list.', get: (r) => matesTxt(r).toLowerCase(), fmt: matesTxt, rtip: (r) => matesOf(r).join('\n') },
    { k: 'qual', label: 'Quality', l: 1, note: 'Qualities the row can occur on: L low quality, N normal, S superior, M magic, R rare.', get: (r) => r.quals.length * 10 + (r.rare ? 1 : 0), fmt: (r) => r.quals.map((q) => QAB[q]).join(' ') },
  ].concat(QS_ALL.map((q) => ({ k: 'o' + q, show: () => showOdds() && oddsQ().indexOf(q) >= 0, get label() { return 'Odds (' + QCOLN[q] + ', ' + (bd.wts ? 'weighted' : 'avg') + ')'; },
    get note() { return 'Chance that a ' + QCOLN[q] + ' item of the type carries this ' + 'at the item level above. Exact. ' + avgNote() + ' Hover a cell for the per-base odds.'; },
    get: (r) => (r.ap && r.ap[q]) || 0, fmt: (r) => odds((r.ap && r.ap[q]) || 0), tip: (r) => oddsTip(r, q) })));
  /** how the odds columns were averaged over the bases (plain average, or weighted by drop rate in the chosen area / monster) */
  function avgNote() {
    const nd = bd.codes.filter(dropsAt).length, skip = nd < bd.codes.length ? ' Bases above item level ' + bd.tableIl + ' cannot drop there and are left out (' + nd + ' of ' + bd.codes.length + ' can).' : '';
    return (bd.wts ? 'Weighted by drop rate in ' + bd.wlabel + ': each base counts with its share of the type\'s drops there (global difficulty, players, terror zone and mode apply); bases that cannot drop there count 0.'
      : 'Average over the ' + bd.codes.length + ' base' + (bd.codes.length === 1 ? '' : 's') + ' of the selection (each base counted equally; a base that cannot roll the affix counts 0).') + skip;
  }
  /** can the base drop at the item level the table was computed for? (a base never drops above the monster level; E.builderAffixTable skips the others) */
  const dropsAt = (c) => E.items[c].q <= (bd.tableIl || 99);
  /** hover text of an odds cell: the odds on each base (and its weight in weighted mode), best first */
  function oddsTip(r, q) {
    const arr = r.pb && r.pb.q && r.pb.q[q];
    if (!arr) return 'This row cannot occur on a ' + QCOLN[q] + ' item.';
    const L = bd.codes.map((c, i) => ({ n: baseName(c), p: arr[i], w: bd.wts ? bd.wts[i] : 0, c })).filter((x) => dropsAt(x.c));
    if (!L.length) return 'No base of the selection drops at item level ' + bd.tableIl + '.';
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
      f.every((w) => (r.name + ' ' + r.desc + ' ' + r.side + ' ' + (r.cls ? (CLASSN[r.cls] || r.cls) + ' only' : '')).toLowerCase().indexOf(w) >= 0) && (!hf || ids.has(r.id) || fitOf(r) || (nofitHidden++, false)));
  }
  function renderTable() {
    if (!showOdds() && TA.key.charAt(0) === 'o') { TA.key = 'il'; TA.dir = 1; }
    TA.rows = filterRows();
    const r = TA.render(), nd = bd.codes.filter(dropsAt).length;
    $('tinfo2').textContent = bd.codes.length ? r.total + ' of ' + bd.rows.length + ' affixes (showing ' + r.shown + ')' +
      (nd === bd.codes.length ? '' : nd ? '; ' + nd + ' of ' + bd.codes.length + ' bases can drop at item level ' + bd.tableIl + ' (the others only count above their own level)' : '; no base of the selection can drop at item level ' + bd.tableIl + ', so every row is dimmed') + (nofitHidden ? '; ' + nofitHidden + ' hidden because they do not fit your picks' : '') + (showOdds() ? '; odds at item level ' + effIlvl() + ', ' : '. ') +
      (!showOdds() ? '' : bd.wts ? (bd.wts.some((w) => w > 0) ? 'weighted by drop rate in ' + bd.wlabel + ' (bases that cannot drop there count 0)' : 'no base of the selection drops in ' + bd.wlabel + ' with the current selectors, so every odds figure is "-"')
        : 'average over the ' + bd.codes.length + ' base' + (bd.codes.length === 1 ? '' : 's') + ' of the selection (each base counted equally)') +
      (showOdds() ? '. Hover an odds cell for the per-base odds.' : '') + ' Click a row to add or remove it. Dimmed rows cannot roll at item level ' + effIlvl() + ' (set in the card); rows marked "doesn\'t fit" cannot be combined with your picks (hover for why).' : '';
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
  function fillMonsters(aid, mid, d3) {   // tab 3 passes its own selects and a fixed difficulty (the area already fixes the act)
    const mo = $(mid || 'mo2'), area = parseInt($(aid || 'ar2').value || '0', 10), cur = mo.value;
    mo.disabled = !area;
    if (!area) { mo.innerHTML = '<option value="">' + (d3 === undefined ? 'All sources' : 'Whole area clear') + '</option>'; return; }
    const sel = readSel(), { list } = getSources(sel);
    if (d3 !== undefined) sel.diff = d3;
    const rows = list.filter((s) => s.area === area && (sel.diff < 0 || s.diff === sel.diff) && (d3 !== undefined || !sel.act || s.act === sel.act) && (!sel.tz || s.tz) && !s.herald);
    const runs = d3 === undefined ? [] : Object.keys(E.CONFIG.runs).filter((k) => E.CONFIG.runs[k].area === area);   // tab 3 only: named runs of this area (seal pop)
    mo.innerHTML = '<option value="">' + (d3 === undefined ? 'All sources in the area' : 'Whole area clear') + '</option>' + runs.map((k) => '<option value="run|' + esc(k) + '">' + esc(E.CONFIG.runs[k].name) + '</option>').join('') + rows.map((s) => '<option value="' + esc(s.key) + '">' + esc(s.name) + (s.rank === 'regular' || s.members ? '' : ' (' + s.rank + ')') + (sel.diff < 0 ? ' - ' + DIFF[s.diff] : '') + '</option>').join('');
    if (rows.some((s) => s.key === cur) || runs.some((k) => 'run|' + k === cur)) mo.value = cur;
  }
  function requestTable() {
    requestOdds();
    if (!bd.codes.length) { bd.rows = []; renderTable(); return; }
    const ilvl = effIlvl(), codes = bd.codes.slice(), quals = oddsQ(), diff = selDiff();
    $('tinfo2').textContent = 'Computing affix odds...';
    const { sel, ctxS } = pctx(), wopts = weightOpts(sel), wlabel = wopts ? weightLabel() : '';
    const local = () => {   // no worker: the same computation on the main thread
      if (!wopts) return E.builderAffixTable(codes, ilvl, { qualities: quals, diff });
      const w = E.baseDropWeights(E.getCtx(ctxS), codes, wopts), rows = E.builderAffixTable(codes, ilvl, { qualities: quals, diff, weights: w, rare: codes.some((c) => w.get(c) > 0) });
      rows.wts = codes.map((c) => w.get(c) || 0); return rows;
    };
    runJob('table', { type: 'table', codes, ilvl, ctx: ctxS, wopts, qualities: quals, diff }, null, (rows, err, m) => {
      if (!rows) { $('tinfo2').textContent = 'Error: ' + err; return; }
      bd.tierRows = rows; bd.tableIl = ilvl; bd.rows = E.familyTable(rows, bd.fams); bd.wts = wopts ? (m ? m.wts : rows.wts) : null; bd.wlabel = wlabel;
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
  function rowFits(r) {
    let v = fitCache.get(r.id);
    if (v === undefined) { v = E.fitsCombo(fitIndex(), rowConds(r), wantQ(), selDiff()); fitCache.set(r.id, v); }
    return v;
  }
  /** the pick a family cannot appear with: one of the same affix group on the same side (tiers like of Pacing / of Speed); null when none */
  const groupClash = (f) => (f.g ? bd.picks.find((p) => p.id !== f.id && p.g === f.g && p.side === f.side) || null : null);
  /** the pick a prefix / suffix replaces when no wanted quality has room for a second one on that side: magic items (charms, or the quality forced
   *  to magic) carry one prefix and one suffix; only a rare has more. null when none */
  const sideClash = (f) => ((f.side === 'prefix' || f.side === 'suffix') && !(wantQ().indexOf('rare') >= 0 && bd.codes.some((c) => E.data.items[c].cr))
    ? bd.picks.find((p) => p.id !== f.id && p.side === f.side) || null : null);
  /** a family fits when it is in no picked affix's group and some tier fits */
  const fitOf = (f) => !groupClash(f) && !sideClash(f) && (!bd.sel.length || f.rows.some(rowFits));
  /** why a row does not fit: E.explainCombo for the wanted qualities (the qualities the row can occur on first, magic and rare before the white ones). Computed on hover: it sweeps every item level */
  function noFitWhy(r) {
    const gc = groupClash(r);
    if (gc) return "Doesn't fit with your picks: " + r.name + ' and ' + gc.name + ' are affixes of the same group, which never appear together on one item. Click to pick it instead of ' + gc.name + '.';
    const sc = sideClash(r);
    if (sc) return "Doesn't fit with your picks: a magic item has one " + r.side + ' and ' + sc.name + ' is already picked. Click to pick ' + r.name + ' instead.';
    fitSync();
    let w = whyCache.get(r.id);
    if (!w) {
      const cs = rowConds(r.rows.slice().sort((a, b) => (a.lvl || 0) - (b.lvl || 0))[0]), wq = wantQ(), pick = (L) => L.filter((q) => wq.indexOf(q) >= 0);
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

  // ----- picked affix families (bd.picks: {id = family id, name, side, keys}) and their stats (bd.sel) -----
  /** the pick a stat belongs to; null when no pick has it (deep link) or several do */
  const pickOf = (key) => { const ps = bd.picks.filter((p) => p.keys.indexOf(key) >= 0); return ps.length === 1 ? ps[0] : null; };
  const pickFromRow = (r) => ({ id: r.id, name: r.name, side: r.side, g: r.g, keys: r.mods.map((m) => m.key).filter((k) => bd.stats.has(k)) });
  /** the family that owns a picked stat (its block); null for "Stats (any affix that gives them)" (no pick, or several picks share the stat) */
  const famOf = (key) => { const p = pickOf(key); return p ? bd.fams.get(p.id) || null : null; };
  /** the weakest value of a family stat: lowest minimum (ge) or highest maximum (le) over its tiers */
  const weakest = (f, key, le) => { const iv = f && f.vals[key]; return !iv ? undefined : le ? iv[iv.length - 1][1] : iv[0][0]; };
  /** a family and its stats added to the picks (a stat another pick already has keeps its threshold) */
  function addPick(f) {
    bd.picks.push(pickFromRow(f));
    for (const m of f.mods) { const st = bd.stats.get(m.key); if (st && !bd.sel.some((s) => s.key === m.key)) addStat(m.key, weakest(f, m.key, st.le)); }
  }
  /** a pick and the stats only it owns taken out (no redraw) */
  function dropPick(id) {
    const i = bd.picks.findIndex((p) => p.id === id); if (i < 0) return false;
    const [p] = bd.picks.splice(i, 1);
    bd.sel = bd.sel.filter((s) => p.keys.indexOf(s.key) < 0 || bd.picks.some((q) => q.keys.indexOf(s.key) >= 0));
    return true;
  }
  function removePick(id) {
    if (!dropPick(id)) return;
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
  const rngNote = (s) => {
    const st = bd.stats.get(s.key), r = rngOf(s), d = E.perLevelDiv(s.key), v = valsOf(s), lo = v ? v[0] : r.lo, hi = v ? v[v.length - 1] : r.hi;
    const gaps = []; if (v) for (let x = lo; x <= hi && gaps.length < 8; x++) if (v.indexOf(x) < 0) gaps.push(x);
    return lo + ' to ' + hi + (gaps.length ? ' (no ' + gaps.join(', ') + (gaps.length === 8 ? ', ...' : '') + ')' : '') + (st.what ? ' ' + st.what : '') + (d ? ' (units of 1/' + d + ' per level)' : '');
  };
  /** values a picked stat can take: null = any integer of its range (no family owns it); else the values some tier of the owning family rolls inside the conditional range
   *  (the family's whole set when the other picks leave none), ascending */
  function valsOf(s) {
    const f = famOf(s.key), st = bd.stats.get(s.key); if (!f || !f.vals[s.key] || st.flag) return null;
    const r = rngOf(s); return E.allowedValues(f.vals[s.key], r.lo, r.hi);
  }
  /** "fixed" = a single allowed value; squeezed = the family itself has several (the other picks leave one) */
  const fixedOf = (s) => { const v = valsOf(s); if (!v || v.length !== 1) return null; const all = E.allowedValues(famOf(s.key).vals[s.key], -1e9, 1e9); return { squeezed: !!all && all.length > 1 }; };
  /** which tier the threshold needs: "needs the tier at ilvl 35 (req. level 15)", with several bases "from ilvl 35"; '' for one-tier families */
  function tierNote(s) {
    const f = famOf(s.key), st = bd.stats.get(s.key); if (!f || f.tiers.length < 2 || st.flag) return '';
    const t = E.tierFor(f, s.key, s.thr, st.le); if (!t) return '';
    return (st.le ? '<= ' : '>= ') + valTxt(s.key, s.thr) + ': needs the tier ' + (bd.codes.length > 1 ? 'from ' : 'at ') + 'ilvl ' + t.minIl + ' (req. level ' + t.lr + ')';
  }
  /** per picked stat: range achievable while the others hold (E.statRange); clamps the thresholds into it */
  function updateRanges() {
    const cs = condsOf(), o = { qualities: wantQ(), diff: selDiff() };
    bd.sel.forEach((s, i) => {
      const st = bd.stats.get(s.key); if (st.flag) return;
      const r = E.statRange(bd.codes, cs, i, o);
      s.lo = r.min; s.hi = r.max; s.thr = Math.max(s.lo, Math.min(s.hi, s.thr));
      const v = valsOf(s); if (v) s.thr = E.snapValue(v, s.thr, st.le);   // a family stat only takes values some tier rolls
    });
  }
  /** a stat row's slider and number box set to its allowed values / range (family stats: the slider steps through the allowed values by index) */
  function fillCtl(row, s) {
    const vals = valsOf(s), r = rngOf(s), n = row.querySelector('.thr'), sl = row.querySelector('.thrr'); if (!n) return;
    n.value = s.thr;
    if (vals) { n.min = vals[0]; n.max = vals[vals.length - 1]; sl.min = 0; sl.max = vals.length - 1; sl.value = Math.max(0, vals.indexOf(s.thr)); } else { n.min = sl.min = r.lo; n.max = sl.max = r.hi; sl.value = s.thr; }
  }
  /** after a threshold moved: refresh the other rows in place (range, value, text); a row that became fixed (or stopped being) is redrawn */
  function syncRows(j) {
    updateRanges();
    let redraw = false;
    for (const row of Array.from($('sel2').querySelectorAll('.selrow'))) {
      const i = +row.dataset.i, s = bd.sel[i], st = bd.stats.get(s.key); if (i === j || st.flag) continue;
      if (!!fixedOf(s) !== (row.dataset.fx === '1')) { row.outerHTML = rowHtml(s, i); redraw = true; continue; }
      fillCtl(row, s);
      const note = row.querySelector('.rn'); if (note) note.textContent = rngNote(s);
      const tn = row.querySelector('.tn'); if (tn) tn.textContent = tierNote(s);
      row.querySelector('.nm span').textContent = statText(s);
    }
    if (redraw) paintOdds();
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
  /** one stat row: text, (not fixed) number box and slider, tier note, odds slot */
  function rowHtml(s, i) {
    const st = bd.stats.get(s.key), r = rngOf(s), fx = fixedOf(s), vals = valsOf(s);
    const sl = vals ? ' min="0" max="' + (vals.length - 1) + '" value="' + Math.max(0, vals.indexOf(s.thr)) + '" data-idx="1"' : ' min="' + r.lo + '" max="' + r.hi + '" value="' + s.thr + '"';
    const lo = vals ? vals[0] : r.lo, hi = vals ? vals[vals.length - 1] : r.hi;
    return '<div class="selrow" data-i="' + i + '"' + (fx ? ' data-fx="1"' : '') + '><div class="nm"><span>' + esc(statText(s)) + '</span><button class="rm" title="remove this stat">x</button></div>' + (st.flag || fx ? '' :
      '<div class="ctl"><span>' + (st.le ? '&lt;=' : '&gt;=') + '</span><input type="number" class="thr" value="' + s.thr + '" min="' + lo + '" max="' + hi + '">' +
      '<input type="range" class="thrr" step="1"' + sl + '><small class="note rn">' + rngNote(s) + '</small></div>') +
      (vals && !fx ? '<small class="note tn">' + esc(tierNote(s)) + '</small>' : '') + '<div class="od" data-k="c' + i + '"></div></div>';
  }
  /** the item card: base and quality, the slot counter, then one block per picked affix family with the sliders of its stats; stats no pick owns go under "Stats (any affix that gives them)" */
  function renderSel() {
    const box = $('sel2');
    if (!bd.type) { box.className = 'note'; box.textContent = 'Pick an item type or base first.'; $('st2').disabled = true; return; }
    box.className = '';
    const HINT = 'Higher tiers and other affixes with this stat also count.';
    const own = new Set(), blocks = bd.picks.map((p, pi) => {
      const mine = []; bd.sel.forEach((s, i) => { if (pickOf(s.key) === p) { mine.push(rowHtml(s, i)); own.add(i); } });
      const f = bd.fams.get(p.id);
      return '<div class="pk" title="' + esc(HINT) + '"><div class="pkh"><span><b>' + esc(p.name) + '</b> ' + sideTag(p) + (f ? ' &middot; ' + esc(f.desc) : '') + '</span><button class="rmp" data-id="' + esc(p.id) + '" title="remove this affix and its stats">remove</button></div>' +
        (mine.length ? '<div class="od" data-k="g' + pi + '"></div>' : '') + (mine.join('') || '<div class="note">its stats are also picked by another affix (see below)</div>') + '</div>';
    });
    const other = bd.sel.map((s, i) => own.has(i) ? '' : rowHtml(s, i)).join('');
    if (other) blocks.push('<div class="pk"><div class="pkh"><b>Stats (any affix that gives them)</b></div>' + other + '</div>');
    const q = $('ql2').value;
    box.innerHTML = '<div class="card"><div class="chd"><b>' + esc(bd.type.name) + '</b><span>' + (q ? QN[q] : 'Any quality') + '</span></div><div class="slots">' + slotLine() + '</div>' + (bd.sel.length ? '<div class="vd" hidden></div><div class="odt"><b>All picks, per item:</b> <span class="od" data-k="t"></span></div><div class="note odn"></div><div class="ilc"></div>' : '') +
      (blocks.join('') || '<div class="note">Click an affix in the table, or add a stat by name below. Each stat gets a minimum value you can move with the slider.</div>') + '</div>';
    $('st2').disabled = false;
    paintOdds(); requestOdds(); paintVerdict();
  }

  // ----- odds in the item card: per stat, per affix block, all picks (E.cardOdds: magic exact, rare reweighted from recorded samples, done in the worker) -----
  // The last answer stays on screen, dimmed, while a new one is pending. bd.odds = {keys, gsig, list: [{q, ok, why}], res, nb, ilvl, wlabel, wts}.
  let oddsTimer = null, oddsSig = '', oddsBusy = false;
  const pickIdx = (p) => { const r = []; bd.sel.forEach((s, i) => { if (pickOf(s.key) === p) r.push(i); }); return r; };
  /** qualities to show: the forced one, else magic and rare, plus normal / superior / low when a pick makes them possible; ok = the combination can exist at all */
  function oddsList() {
    const f = $('ql2').value, an = bd.an, ok = (q) => !an || an[q].ok, why = (q) => (an && an[q].why) || [];
    return (f ? [f] : ['magic', 'rare'].concat(['normal', 'sup', 'low'].filter((q) => an && an[q].ok))).map((q) => ({ q, ok: ok(q), why: why(q) }));
  }
  const oddsFresh = () => { const o = bd.odds; return o && o.keys === bd.sel.map((s) => s.key).join('|') && o.gsig === JSON.stringify(bd.picks.map(pickIdx)) ? o : null; };
  /** the shown figures of one slot ('t' total, 'c3' stat 3, 'g1' block 1) */
  function oddsLine(o, k) {
    const m = k === 't' ? o.res.total : k[0] === 'c' ? o.res.perCond[+k.slice(1)] : o.res.perGroup[+k.slice(1)];
    if (!m) return '';
    return o.list.map((x) => {
      const p = x.ok ? m[x.q] || 0 : 0, none = o.wts && !o.wts.some((w) => w > 0);
      const tip = p > 0 ? '' : !x.ok ? x.why.join(' ') : none ? 'No base of the selection drops in ' + o.wlabel + ' with the current selectors.' : 'No base of the selection can roll this at this quality and item level.';
      return '<span' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + QCOLN[x.q] + ' ' + odds(p) + '</span>';
    }).join(' &middot; ');
  }
  function paintOdds() {
    const box = $('sel2'), o = oddsFresh(), card = box.querySelector('.card'); if (!card) return;
    card.classList.toggle('odstale', oddsBusy);
    for (const el of box.querySelectorAll('.od')) el.innerHTML = o ? oddsLine(o, el.dataset.k) : '';
    paintCurve();
    const n = box.querySelector('.odn');
    if (n) n.textContent = !o ? (oddsBusy ? 'Computing odds...' : '') : 'Per item, not per kill: of the items of that quality the selection drops at item level ' + o.ilvl + ', the share with these stats (at least the values set). The per-kill odds are in the verdict and the farm search. ' +
      (o.wlabel ? 'Weighted by drop rate in ' + o.wlabel + '.' : 'Average over the ' + o.nb + ' base' + (o.nb === 1 ? '' : 's') + ' of the selection.') + (o.nd < o.nb ? ' Only ' + o.nd + ' of its ' + o.nb + ' bases can drop at item level ' + o.ilvl + '; the others are left out.' : '') + (oddsBusy ? ' Updating...' : '');
  }
  // ----- best item level: odds of all picks at ilvl 1..99 (E.ilvlCurve, own worker; it does not depend on the item level, so moving the level only moves the marker) -----
  const QCOL = { low: 'var(--dim)', normal: 'var(--text)', sup: 'var(--good)', magic: 'var(--side-prefix)', rare: 'var(--side-auto)' };
  let curveSig = '';
  /** inline SVG: x = item level 1..99, y = log odds (one line per series {q, p[99], best}), the item level `cur` marked; 100 px tall, stretched to the width */
  function ilChart(series, cur) {
    const W = 396, H = 100, X = (il) => ((il - 1) / 98 * W).toFixed(1);
    let lo = 0, hi = 0; for (const s of series) for (const p of s.p) if (p > 0) { lo = lo ? Math.min(lo, p) : p; hi = Math.max(hi, p); }
    if (!lo) return '';
    const a = Math.log10(hi) + 0.15, b = Math.min(Math.log10(lo), a - 0.6) - 0.15, Y = (p) => (4 + (a - Math.log10(p)) / (a - b) * (H - 8)).toFixed(1);
    let g = '';
    for (let e = Math.ceil(b); e <= Math.floor(a); e++) g += '<line x1="0" x2="' + W + '" y1="' + Y(Math.pow(10, e)) + '" y2="' + Y(Math.pow(10, e)) + '" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>';
    for (let il = 10; il < 99; il += 10) g += '<line x1="' + X(il) + '" x2="' + X(il) + '" y1="0" y2="' + H + '" stroke="var(--line)" stroke-width="1" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>';
    g += '<line x1="' + X(cur) + '" x2="' + X(cur) + '" y1="0" y2="' + H + '" stroke="var(--text)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>';
    for (const s of series) {
      let d = '', pen = 'M';
      s.p.forEach((p, i) => { if (p > 0) { d += pen + X(i + 1) + ' ' + Y(p) + ' '; pen = 'L'; } else pen = 'M'; });
      g += '<path d="' + d + '" fill="none" stroke="' + QCOL[s.q] + '" stroke-width="2" vector-effect="non-scaling-stroke"/>';
      if (s.best) g += '<circle cx="' + X(s.best) + '" cy="' + Y(s.p[s.best - 1]) + '" r="3" fill="' + QCOL[s.q] + '"/>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" width="100%" height="100" style="display:block;cursor:crosshair;touch-action:manipulation;background:var(--panel);border:1px solid var(--line);border-radius:4px">' + g + '</svg>';
  }
  /** the best-item-level line and chart of the card, from bd.curve */
  function paintCurve() {
    const el = $('sel2').querySelector('.ilc'); if (!el) return;
    const c = bd.curve, cur = effIlvl();
    if (!c || c.sig !== curveSig) { el.innerHTML = ''; return; }
    const qs = Object.keys(c.res).filter((q) => c.res[q].first);
    if (!qs.length) { el.innerHTML = '<div class="note">No item level lets these picks drop.</div>'; return; }
    const parts = qs.map((q) => {
      const r = c.res[q], within = r.lo < r.hi ? ', within 5% from ' + r.lo + (r.hi >= 99 ? '+' : '-' + r.hi) : '';
      return '<span style="color:' + QCOL[q] + '">' + QCOLN[q] + '</span> <b>' + r.best + '</b> (' + odds(r.pBest) + within + ')';
    });
    const at = qs.map((q) => QCOLN[q] + ' ' + odds(c.res[q].p[cur - 1])).join(', ');
    el.innerHTML = '<div class="note ilbest" title="' + esc('Per item of that quality on the selection (average over its bases that can drop at the level), not per kill: the farm table also includes the quality chance, MF and the base mix, so it stays the answer for where to farm. Higher levels add competing affixes and bases, so the best level is often below 99. Click the chart to set the item level.') + '"><b>Best item level:</b> ' +
      parts.join(' &middot; ') + ' &middot; at item level ' + cur + ': ' + at + '</div>' +
      '<div class="ilch" title="Click to set the item level">' + ilChart(qs.map((q) => ({ q, p: c.res[q].p, best: c.res[q].best })), cur) + '</div>' +
      '<div class="note" style="display:flex;justify-content:space-between;gap:8px"><span>ilvl 1</span><span>log odds; first level: ' + qs.map((q) => QCOLN[q] + ' ' + c.res[q].first).join(', ') + '</span><span>99</span></div>';
  }
  const chartIl = (ev, sv) => { const r = sv.getBoundingClientRect(); return Math.max(1, Math.min(99, Math.round(1 + (ev.clientX - r.left) / r.width * 98))); };
  /** click / tap on the chart: that item level */
  function chartClick(ev) {
    const sv = ev.target.closest && ev.target.closest('.ilch svg'); if (!sv) return;
    $('il2').value = chartIl(ev, sv); effIlvl(); syncUrl(); requestTable(); requestOdds(true);
  }
  function chartTip(ev) {
    const sv = ev.target.closest && ev.target.closest('.ilch svg'), c = bd.curve; if (!sv || !c) return;
    const il = chartIl(ev, sv);
    sv.parentNode.title = 'Item level ' + il + ': ' + Object.keys(c.res).filter((q) => c.res[q].first).map((q) => QCOLN[q] + ' ' + odds(c.res[q].p[il - 1])).join(', ') + ' (click to set)';
  }
  function runCurve(codes, conds, quals, wopts, ctxS, diff) {
    const sig = JSON.stringify([E.mode, codes, conds, quals, wopts, wopts ? ctxS : 0, diff]);
    if (sig === curveSig) return;
    curveSig = sig;
    const local = () => E.ilvlCurve(codes, conds, quals, wopts ? E.baseDropWeights(E.getCtx(ctxS), codes, wopts) : null, { diff });
    runJob('curve', { type: 'curve', codes, conds, qualities: quals, ctx: ctxS, wopts, diff }, null, (res) => {
      if (!res) { curveSig = ''; return; }
      bd.curve = { sig, res }; paintCurve();
    }, local);
  }
  /** schedule a recompute (throttled to one per 70 ms while dragging; now = immediately) */
  function requestOdds(now) {
    if (now) { clearTimeout(oddsTimer); oddsTimer = null; runOdds(); return; }
    if (!oddsTimer) oddsTimer = setTimeout(() => { oddsTimer = null; runOdds(); }, 70);
  }
  function runOdds() {
    if (!bd.type || !bd.codes.length || !bd.sel.length) { bd.odds = null; bd.curve = null; curveSig = ''; oddsSig = ''; oddsBusy = false; paintOdds(); return; }
    const list = oddsList(), quals = list.filter((x) => x.ok).map((x) => x.q), { sel, ctxS } = pctx(), wopts = weightOpts(sel), ilvl = effIlvl(), diff = selDiff(), conds = condsOf(), groups = bd.picks.map(pickIdx), codes = bd.codes.slice();
    const sig = JSON.stringify([E.mode, codes, conds, ilvl, quals, wopts, wopts ? ctxS : 0, diff, groups]);
    runCurve(codes, conds, quals, wopts, ctxS, diff);
    if (sig === oddsSig) return;   // nothing changed: keep what is shown
    oddsSig = sig; oddsBusy = true; paintOdds();
    const keys = bd.sel.map((s) => s.key).join('|'), gsig = JSON.stringify(groups), wlabel = wopts ? weightLabel() : '';
    const local = () => {   // no worker: the same computation on the main thread
      const w = wopts ? E.baseDropWeights(E.getCtx(ctxS), codes, wopts) : null;
      return Object.assign(E.cardOdds(codes, conds, ilvl, quals, w, { diff, groups }), { wts: w ? codes.map((c) => w.get(c) || 0) : null });
    };
    runJob('odds', { type: 'odds', codes, conds, ilvl, qualities: quals, ctx: ctxS, wopts, diff, groups }, null, (res, err, m) => {
      oddsBusy = false;
      if (!res) { oddsSig = ''; paintOdds(); return; }
      bd.odds = { keys, gsig, list, res, nb: codes.length, nd: codes.filter((c) => E.items[c].q <= ilvl).length, ilvl, wlabel, wts: res.wts || null };
      paintOdds();
    }, local);
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
    if (!bd.codes.length) { res.innerHTML = '<div class="note">No bases for this type / tier.</div>'; requestOdds(true); return; }
    if (!bd.sel.length) { requestOdds(true); res.innerHTML = '<div class="note">Select at least one affix or stat to see the item levels and farm sources.</div>'; T2.rows = []; T2.render(); $('finfo2').textContent = ''; return; }
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
    requestOdds(true);   // the set of qualities follows bd.an
  }
  /** why no wanted quality works: the explanation of the most permissive one (rare, then magic, ...) */
  const whyNot = (an) => { const q = ['rare', 'magic', 'sup', 'normal', 'low'].filter((x) => wantQ().indexOf(x) >= 0 && an[x].why.length && !/is not possible for this type/.test(an[x].why[0]))[0] || wantQ()[0]; return an[q].why; };
  const killsTxt = (p) => { const o = odds(p); return o.slice(0, 4) === '1 in' ? o + ' kills' : o === 'always' ? 'every kill' : o; };
  const whereTxt = (s) => esc(s.areaName) + ' (' + DIFF[s.diff] + (s.tz ? ', terror zone' : '') + ')';
  /** the one-sentence answer above the tables: quality and type, item level, character level, best farm source (or why it is impossible) */
  function renderHead() {
    const h = $('head2'), an = bd.an; if (!h || !an) return;
    const feas = wantQ().filter((q) => an[q].ok);
    if (!feas.length) { h.className = 'head bad'; h.innerHTML = '<b>Not possible:</b> ' + whyNot(an).map(esc).join(' '); return; }
    const lo = Math.min.apply(null, feas.map((q) => an[q].minIl)), hi = Math.max.apply(null, feas.map((q) => an[q].maxIl)), rq = Math.min.apply(null, feas.map((q) => an[q].reqLv));
    const qn = feas.length >= 4 ? 'Any quality' : feas.map((q) => QCOLN[q]).join(' or ').replace(/^./, (c) => c.toUpperCase()), f = bd.farm;
    const farm = !f ? 'searching farm sources&hellip;' : f.err ? 'farm search failed (' + esc(f.err) + ')' : !f.top ? 'no farm source found (try Difficulty: All)' :
      'best per kill: <b>' + esc(f.top.src.name) + '</b> in ' + whereTxt(f.top.src) + ', ' + killsTxt(f.top.pTotal) +
      (f.topRun ? ' &middot; best per run: <b>' + whereTxt(f.topRun.src) + '</b>, ' + runsTxt(f.topRun.p) : '') +
      (f.topIl ? ' &middot; <span title="Highest per-kill chance among the sources of each item level (the level a drop rolls at = monster level); includes quality chance, MF and the base mix">best monster level per kill: <b>' + f.topIl.il + '</b> (' + esc(f.topIl.x.src.name) + ', ' + killsTxt(f.topIl.x.pTotal) + ')</span>' : '');
    h.className = 'head';
    h.innerHTML = '<b>' + esc(qn + ' ' + bd.type.name) + '</b> &middot; item level ' + ilTxt(lo, hi) + ' &middot; requires character level ' + rq + ' &middot; ' + farm;
    paintVerdict();
  }
  /** the verdict (renderHead's line) repeated at the top of the card, so it shows without scrolling past the affix table */
  function paintVerdict() {
    const v = $('sel2').querySelector('.vd'), h = $('head2'); if (!v) return;
    v.hidden = !(h && bd.an && h.innerHTML);
    if (v.hidden) return;
    v.className = 'vd' + (h.classList.contains('bad') ? ' bad' : '');
    v.innerHTML = h.innerHTML + ' <a href="#res2">details below</a>';
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
    const opts = { codes, conds: condsOf(), mf: sel.mf, diff: sel.diff, act: sel.act, area: parseInt($('ar2').value || '0', 10), srcKey: $('mo2').value || '' };
    bd.farm = null; renderHead();
    $('prog2').hidden = false; $('prog2').value = 0;
    $('finfo2').textContent = 'Searching farm sources...';
    const t0 = performance.now();
    const finish = (rowsByQ, err) => {
      if (bd.an !== an) return;   // the item changed (or was cleared) while the search ran
      $('prog2').hidden = true;
      if (!rowsByQ) { $('finfo2').textContent = 'Error: ' + err; bd.farm = { err: String(err) }; renderHead(); return; }
      const m = new Map();
      for (const q of qs) for (const r of rowsByQ[q]) {
        let x = m.get(r.src.key);
        if (!x) { x = { src: r.src, pq: {}, pTotal: 0, perRun: 0, byBase: {} }; m.set(r.src.key, x); }
        x.pq[q] = r.pTotal;
        x.pTotal += r.pTotal;
        for (const c in r.byBase || {}) x.byBase[c] = (x.byBase[c] || 0) + r.byBase[c];
      }
      let rows = Array.from(m.values());
      for (const x of rows) x.perRun = runOf(x.pTotal, x.src.perRun);   // at least one matching item in a run
      if (sel.tz) rows = rows.filter((r) => r.src.tz);
      T2.rows = rows; T2.limit = parseInt($('n2').value, 10);
      T2.key = opts.area ? 'perrun' : 'ptot'; T2.dir = -1;
      const r = T2.render();
      let top = null; for (const x of rows) if (!top || x.pTotal > top.pTotal) top = x;
      // per run: one full clear of an area = every source row of that area (regular packs, champions, uniques, minions, super uniques, bosses; no heralds), summed
      const byArea = new Map(); let topRun = null;
      for (const x of rows) {
        if (!(x.perRun > 0)) continue;
        const k = x.src.area + '|' + x.src.diff + '|' + (x.src.tz ? 1 : 0), a = byArea.get(k);
        const lm = x.src.perRun * Math.log1p(-Math.min(x.pTotal, 1));   // log of the chance this row's kills all miss
        if (a) a.lm += lm; else byArea.set(k, { src: x.src, lm });
      }
      for (const a of byArea.values()) { a.p = -Math.expm1(a.lm); if (!topRun || a.p > topRun.p) topRun = a; }   // as tab 1's area rows
      // best item level for farming: group the rows by the item level they roll at (the monster level, capped at 99), best per-kill P of each
      const byIl = new Map(); let topIl = null;
      for (const x of rows) { const il = Math.min(x.src.mlvl, 99), a = byIl.get(il); if (!a || x.pTotal > a.x.pTotal) byIl.set(il, { il, x }); }
      for (const a of byIl.values()) if (a.x.pTotal > 0 && (!topIl || a.x.pTotal > topIl.x.pTotal || (a.x.pTotal === topIl.x.pTotal && a.il < topIl.il))) topIl = a;
      bd.farm = { top, topRun, topIl, rows: rows.length };
      showShares(); renderHead();
      $('finfo2').textContent = (r.total ? '' : 'No source found: monsters of the selected difficulty/act may not drop items at these item levels (try Difficulty: All or Normal). ') + r.total.toLocaleString() + ' sources (showing ' + r.shown + ')' + (top ? '; best per kill: ' + top.src.name + ' in ' + top.src.areaName + ' (' + DIFF[top.src.diff] + '), ' + odds(top.pTotal) : '') + (topIl ? '; best monster level per kill: ' + topIl.il + ' (' + topIl.x.src.name + ', ' + odds(topIl.x.pTotal) + ')' : '') + (topRun ? '; best per run: ' + topRun.src.areaName + ' (' + DIFF[topRun.src.diff] + '), ' + odds(topRun.p) : '') + '; ' +
        'odds exact (' + qs.map((q) => QN[q]).join(', ') + ')' + (sel.quest ? '; boss quest rows shown (first kill only)' : '') + '; ' + Math.round(performance.now() - t0) + ' ms. Click a column header to sort.';
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
    bd.stats = new Map(E.builderStats(bd.codes).map((s) => [s.key, s])); bd.fams = E.builderFamilies(bd.codes);
    bd.sel = bd.sel.filter((s) => bd.stats.has(s.key));
    for (const p of bd.picks) p.keys = p.keys.filter((k) => bd.stats.has(k));
    bd.picks = bd.picks.filter((p) => p.keys.length && bd.fams.has(p.id));
    for (const s of bd.sel) addStat(s.key, s.thr);
    bd.farm = null; fitIdx = null;
    renderSel(); requestTable(); changed();
  }
  function onPickRow(r) {
    if (!r) return;
    if (bd.picks.some((p) => p.id === r.id)) { removePick(r.id); return; }   // clicking a picked row takes it out again
    const gc = groupClash(r); if (gc) dropPick(gc.id);   // another tier of a picked group replaces it (an item never has both)
    const sc = sideClash(r); if (sc) dropPick(sc.id);   // a second prefix / suffix on a magic-only item replaces the first
    addPick(r);
    updateRanges(); renderSel(); refit(true); changed();
  }
  function findTypeOption(w) {
    w = w.toLowerCase();
    const names = TYPEOPTS.filter((o) => o.kind === 'type');
    return names.find((o) => o.name.toLowerCase() === w) || names.find((o) => o.name.toLowerCase().startsWith(w)) || names.find((o) => o.name.toLowerCase().indexOf(w) >= 0) ||
      TYPEOPTS.find((o) => o.kind === 'base' && (o.search || o.label).toLowerCase().indexOf(w) >= 0) || null;
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
    // stat-first entry: any affix that gives the stat counts (the stat goes under "Stats (any affix that gives them)" in the card)
    autocomplete($('st2'), $('acst2'), () => bd.type ? Array.from(bd.stats.values()).filter((st) => !bd.sel.some((s) => s.key === st.key)).map((st) => ({ key: st.key, label: st.text, search: st.text + ' ' + st.key })) : [],
      (x) => { $('st2').value = ''; if (addStat(x.key)) { renderSel(); refit(true); changed(); } });
    $('tr2').addEventListener('change', () => { if (bd.type && bd.type.kind === 'type') refreshBuilder(); });
    $('ilr2').addEventListener('input', () => { $('il2').value = $('ilr2').value; });
    $('ilr2').addEventListener('change', () => { syncUrl(); requestTable(); });
    $('il2').addEventListener('change', () => { effIlvl(); syncUrl(); requestTable(); });
    $('sel2').addEventListener('click', chartClick); $('sel2').addEventListener('mousemove', chartTip);
    $('ql2').addEventListener('change', () => { TA.key = 'o' + ($('ql2').value || 'magic'); TA.dir = -1; updateRanges(); renderSel(); syncUrl(); requestTable(); updateAnalysis(); runFarm(); refit(true); });
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
    $('new2').onclick = () => {   // start over: no type, tier All, quality Auto, no picks (item level, area and monster stay)
      clearTimeout(anTimer); clearTimeout(farmTimer);
      $('q2').value = ''; $('tr2').value = '-1'; $('ql2').value = '';
      Object.assign(bd, { type: null, codes: [], stats: new Map(), fams: new Map(), sel: [], picks: [], rows: [], an: null, farm: null, farmQ: [] }); fitIdx = null;
      renderSel(); requestTable();
      $('res2').innerHTML = ''; T2.rows = []; T2.render(); $('finfo2').textContent = ''; $('tinfo2').textContent = '';
      syncUrl();
    };
    $('link2').addEventListener('focus', () => $('link2').select());
    const selbox = $('sel2');
    selbox.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('rmp')) { removePick(ev.target.dataset.id); return; }
      if (ev.target.classList.contains('rm')) removeStat(+ev.target.closest('.selrow').dataset.i);
    });
    selbox.addEventListener('change', (ev) => {   // a typed number shows the value it snapped to
      const row = ev.target.closest('.selrow'); if (row && ev.target.classList.contains('thr')) ev.target.value = bd.sel[+row.dataset.i].thr;
    });
    selbox.addEventListener('input', (ev) => {
      const row = ev.target.closest('.selrow'); if (!row) return;
      const s = bd.sel[+row.dataset.i], r = rngOf(s), vals = valsOf(s), st = bd.stats.get(s.key);
      let v = parseFloat(ev.target.value); if (isNaN(v)) return;
      if (vals && ev.target.classList.contains('thrr')) v = vals[Math.max(0, Math.min(vals.length - 1, Math.round(v)))];   // the slider steps through the allowed values
      else v = Math.max(r.lo, Math.min(r.hi, Math.round(v)));
      if (vals) v = E.snapValue(vals, v, st.le);   // typed values snap to the next value some tier rolls
      s.thr = v;
      if (ev.target.classList.contains('thrr')) row.querySelector('.thr').value = v; else row.querySelector('.thrr').value = vals ? Math.max(0, vals.indexOf(v)) : v;
      row.querySelector('.nm span').textContent = statText(s);
      const tn = row.querySelector('.tn'); if (tn) tn.textContent = tierNote(s);
      syncRows(+row.dataset.i);
      changed(); refit(); requestOdds();
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
    bd.stats = new Map(E.builderStats(bd.codes).map((s) => [s.key, s])); bd.fams = E.builderFamilies(bd.codes);
    bd.sel = []; bd.picks = []; fitIdx = null;
    const byRow = new Map(); for (const f of bd.fams.values()) for (const id of f.ids) byRow.set(id, f);
    for (const id of qs.getAll('p')) {   // ?p=<family id>: the picked affixes; an old link's tier row id (p12) maps to its family; links without p: the stats show under "Stats (any affix that gives them)"
      const f = bd.fams.get(id) || byRow.get(id); if (!f || bd.picks.some((p) => p.id === f.fid) || groupClash(f) || sideClash(f)) continue;
      if (!pickFromRow(f).keys.length) continue;
      addPick(f);
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
      if (!resp.ok) throw new Error('could not load the game data (' + DATAFILE[m] + ')');
      ENGINES[m] = Engine.create(await resp.json());
    }
    E = ENGINES[m];
    E.CONFIG.gameMode = E.mode;
    $('s_mode').value = E.mode;
    $('dataInfo').textContent = 'data: D2R ' + E.data.meta.gameVersion + ' (' + (E.mode === 'lod' ? 'Lord of Destruction' : 'Reign of the Warlock') + '), built ' + E.data.meta.built;
    INDEX = E.searchIndex();
    $('l_ladder').title = ladderTip();
    TYPEOPTS = typeOptions();
    const bossAt = new Set(Object.values(E.data.boss_area).concat(Object.values(E.data.su_area)).map(String));   // The Worldstone Chamber, Colossal Summit: no spawn list, only a boss
    const areas = Object.keys(E.data.levels).filter((id) => !E.DUP_OF[id] && (E.data.levels[id].mon.length || E.data.levels[id].nmon.length || E.data.levels[id].pre || bossAt.has(id)))
      .map((id) => ({ id, a: E.data.levels[id] })).sort((x, y) => x.a.act - y.a.act || x.id - y.id);
    const cur = $('ar2').value;
    $('ar2').innerHTML = '<option value="">All areas</option>' + areas.map((x) => '<option value="' + x.id + '">Act ' + x.a.act + ' - ' + esc(E.areaLabel(x.id)) + (x.a.ho ? ' (Hell only)' : '') + '</option>').join('');
    if (areas.some((x) => x.id === cur)) $('ar2').value = cur;
    fillMonsters();
    const cur3 = $('ar3').value;
    $('ar3').innerHTML = $('ar2').innerHTML.replace('All areas', 'Choose an area');
    if (areas.some((x) => x.id === cur3)) $('ar3').value = cur3;
    fill3();
    $('info1').textContent = 'Ready. ' + INDEX.length + ' items indexed, ' + Object.keys(E.data.levels).length + ' areas, ' + Object.keys(E.data.monsters).length + ' monster types.';
    updTier();
  }
  /** one-line "Your game" summary shown on the collapsed bar */
  function updGame() {
    const v = (id) => $(id).value, n = (id, w) => v(id) + ' ' + w + (v(id) === '1' ? '' : 's');
    $('gsum').textContent = ['Your game: ' + (v('s_mode') === 'lod' ? 'LoD' : 'RotW'), v('s_ladder') === '1' ? 'Ladder' : 'Non-ladder', n('s_players', 'player') + (+v('s_party') > 1 ? ' (party ' + v('s_party') + ')' : ''),
      (+v('s_mf') || 0) + '% MF', 'clvl ' + v('s_clvl')].concat($('s_tz').checked ? ['terror zone' + (+v('s_tier') ? ' T' + v('s_tier') : '')] : []).join(' · ');
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
    c3.sig = ''; if ($('ar3').value) runTab3(); else { T3.rows = []; T3.render(); }
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
    const tabs = ['t1', 't2', 't3', 't4'];
    tabs.forEach((t, i) => $(t).onclick = () => {
      tabs.forEach((x, j) => { $(x).classList.toggle('on', i === j); $('tab' + (j + 1)).classList.toggle('on', i === j); });
      if (i < 3) { const sec = $('tab' + (i + 1)), fr = sec.querySelector('.farmrow'); if (fr) fr.insertBefore($('wh'), fr.children[1]); else sec.querySelector('.row').appendChild($('wh')); }   // Difficulty / Act (global) sit with the filters of the open tab; in the builder with the farm filters
    });
    // "Your game" bar: one-line summary, open state remembered
    $('game').open = lsGet('d2dc-game');
    $('game').addEventListener('toggle', () => lsSet('d2dc-game', $('game').open));
    updGame();
    $('game').addEventListener('change', updGame);
    for (const k of KEYS) $(k).addEventListener('change', () => {
      saveSel(); updGame();
      if (FTKEYS.indexOf(k) >= 0) { if ($('ar3').value) runTab3(); return; }   // the farm-time settings only touch tab 2's minutes
      if (k === 's_mode') { switchMode($('s_mode').value).catch((e) => { $('info1').textContent = 'Could not load data: ' + e; }); return; }
      if (k === 's_diff' && bd.sel.length) { updateRanges(); renderSel(); refit(true); }
      if (k === 's_clvl' && bd.sel.length) renderSel();   // per-level stats show their value at this level
      updTier(); if (target1) runTab1(); if (bd.an) { syncUrl(); runFarm(); }
      if (bd.type && $('ar2').value) { fillMonsters(); requestTable(); }
      if ($('ar3').value) { const f = E.CONFIG.farms[parseInt($('pf3').value, 10)]; fill3(); if (f) { const fk = farmKey3(f, d3Diff()); if (Array.from($('mo3').options).some((o) => o.value === fk)) $('mo3').value = fk; } runTab3(); }   // a chosen farm follows the difficulty (boss keys carry it)
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
    $('charts3').open = lsOpen('d2dc-charts3'); $('charts3').addEventListener('toggle', () => { lsSet('d2dc-charts3', $('charts3').open); renderCharts3(); });   // only computed while open
    $('charts1').open = lsOpen('d2dc-charts1'); $('charts1').addEventListener('toggle', () => { lsSet('d2dc-charts1', chOpen()); if (chOpen() && target1) runTab1(); });   // only computed while open
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
      const hr = !!r.src.herald;   // a merged herald row covers many areas: no area filter, the Rank filter says herald instead
      for (const i of document.querySelectorAll('#r1 input')) i.checked = hr && i.value === 'herald';
      rankSummary1();
      $('f1').value = hr ? '' : r.src.rank === 'boss' || r.src.rank === 'super' ? r.src.name : r.src.areaName;
      $('t1').click();
      runTab1();
    });
    autocomplete($('q1'), $('ac1'), () => INDEX, (x) => { target1 = x; runTab1(); });
    // item tooltip: hovering an item name (data-it) shows itemTipHtml next to the pointer
    const tip = document.createElement('div'); tip.className = 'itip'; tip.hidden = true; document.body.appendChild(tip);
    let tipIdx = null, tipSrc = null;
    const placeTip = (e) => { const w = tip.offsetWidth, h = tip.offsetHeight; let x = e.clientX + 14, y = e.clientY + 18;
      if (x + w > innerWidth - 8) x = Math.max(8, e.clientX - w - 14); if (y + h > innerHeight - 8) y = Math.max(8, e.clientY - h - 12); tip.style.left = x + 'px'; tip.style.top = y + 'px'; };
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest && e.target.closest('[data-it]');
      if (!el) { tip.hidden = true; return; }
      if (tipSrc !== INDEX) { tipIdx = new Map(INDEX.map((x) => [itKey(x), x])); tipSrc = INDEX; }   // rebuilt after a mode switch
      const t = tipIdx.get(el.dataset.it), h = t ? itemTipHtml(t) : '';
      if (!h) { tip.hidden = true; return; }
      tip.innerHTML = h; tip.hidden = false; placeTip(e);
    });
    document.addEventListener('mousemove', (e) => { if (!tip.hidden) placeTip(e); });
    document.documentElement.addEventListener('mouseleave', () => { tip.hidden = true; });   // the pointer left the window
    // clicking into the search with an item chosen empties it for typing (the item stays as the placeholder); leaving it without picking another restores the item
    const ph1 = $('q1').placeholder;
    $('q1').addEventListener('focus', () => { if (target1 && $('q1').value === target1.label) { $('q1').value = ''; $('q1').placeholder = target1.label; $('ac1').hidden = true; } });
    $('q1').addEventListener('blur', () => {   // not while the pointer is on the suggestion list (a pick, or its scrollbar)
      if ($('ac1').matches(':hover')) return;
      $('q1').placeholder = ph1; $('ac1').hidden = true;
      if (target1 && $('q1').value !== target1.label) $('q1').value = target1.label;
    });
    $('f1').addEventListener('input', () => { clearTimeout(runTab1.t); runTab1.t = setTimeout(runTab1, 250); });
    $('r1').addEventListener('change', () => { rankSummary1(); runTab1(); });
    $('r1c').addEventListener('click', () => { for (const i of document.querySelectorAll('#r1 input')) i.checked = false; rankSummary1(); runTab1(); });
    document.addEventListener('click', (ev) => { if (!$('r1').contains(ev.target)) $('r1').open = false; });   // the rank list closes on a click elsewhere
    $('bq1').addEventListener('change', runTab1);
    $('n1').addEventListener('change', runTab1);

    // tab 3
    initTab3();
    // tab 2
    initTab2();
    // about
    $('about').innerHTML = aboutHtml(); initMfChart(); initAboutCharts();
    // deep links: ?q1=Griffon   or the item builder: ?t2=circ&q=magic&a=%2B%23%25%20Faster%20Cast%20Rate:20 (old form ?q2=circlet&ql=magic&c=... still works)
    const qs = new URLSearchParams(location.search);
    if (qs.get('q1')) {
      const w = qs.get('q1').toLowerCase();
      target1 = INDEX.find((x) => (x.search || x.label).toLowerCase().indexOf(w) >= 0);
      if (target1) { $('q1').value = target1.label; runTab1(); }
    }
    applyUrl2(qs);
    const a3 = qs.get('t3a');
    if (a3 && Array.from($('ar3').options).some((o) => o.value === a3)) {
      $('ar3').value = a3; fill3();
      if (qs.get('t3m') && Array.from($('mo3').options).some((o) => o.value === qs.get('t3m'))) $('mo3').value = qs.get('t3m');
      if (qs.get('t3k')) {   // t3k = kinds, comma separated; the old single values: notable (the default), all, or one kind
        const v = qs.get('t3k'), ks = v === 'notable' ? ['unique', 'set', 'rune', 'charm'] : v === 'all' ? KINDS3 : v.split(',');
        for (const i of document.querySelectorAll('#k3 input')) i.checked = ks.indexOf(i.value) >= 0;
        kindSummary3();
      }
      runTab3(); $('t3').click();
    }
  }

  // ----- the two small charts in tab 1 ("Charts" under the headline): MF vs chance per run, and runs vs cumulative chance, both at the best-per-run source -----
  const CH = { w: 640, h: 270, l: 84, r: 24, t: 16, b: 42 };
  let chCache = null;   // { key, mfs, ps, P }
  let ch1Kill = (() => { try { return localStorage.getItem('d2dc-ch1mode') === 'kill'; } catch (e) { return false; } })();   // charts per kill (best per-kill source) instead of per run
  const chOpen = () => $('charts1').open;
  const chNum = (n) => n < 1e3 ? String(n < 10 ? Math.round(n * 100) / 100 : Math.round(n)) : n < 1e4 ? Math.round(n).toLocaleString('en-US') : n < 1e6 ? +(n / 1e3).toPrecision(3) + 'k' : +(n / 1e6).toPrecision(3) + 'M';   // 1 in N, short
  const chOdds = (p) => p >= 1 ? 'always' : '1 in ' + chNum(1 / p);
  /** per-kill chance of the target at a source and MF (white-base filter applied like the table) */
  const chKill = (ctx, src, mf, bq) => { const c = E.chanceFor(ctx, src, target1, mf); return bq ? E.baseQualityChance(c, bq) : c.target; };
  /** chart data for the best-per-run row br: chance per run at MF 0..1000 (area row: its parts combined like groupAreas) */
  const chParts = (br) => (br.parts || [br]).filter((r) => r.src.perRun > 0 && !r.src.quest && !r.src.herald);
  const chRun = (ctx, parts, mf, bq) => -Math.expm1(parts.reduce((a, r) => a + r.src.perRun * Math.log1p(-Math.min(chKill(ctx, r.src, mf, bq), 1)), 0));   // 1 - prod (1 - p_i)^kills_i
  function chartData(sel, ctx, br, bq, kill) {   // kill: br is a single (per-kill) row and the values are per kill
    const parts = kill ? [br] : chParts(br);
    const key = (kill ? 'k|' : 'r|') + target1.kind + (target1.code || target1.id) + '|' + bq + '|' + JSON.stringify(Object.assign({}, sel, { mf: 0 })) + '|' + parts.map((r) => r.src.key).join(',');
    if (chCache && chCache.key === key) return chCache;
    const mfs = [0, 25, 50, 75, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000];
    const ps = mfs.map((mf) => kill ? chKill(ctx, br.src, mf, bq) : chRun(ctx, parts, mf, bq));
    return (chCache = { key, mfs, ps });
  }
  /** hover on a chart: toX(svg x) -> { x: svg x of the crosshair, html } or null; crosshair + readout box like the About chart */
  function chartHover(box, toX) {
    const svg = box.querySelector('svg'), xh = svg.querySelector('.xh'), hit = svg.querySelector('.hit'), tip = box.querySelector('.mftip');
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect(), v = toX((e.clientX - r.left) * CH.w / r.width); if (!v) return;
      xh.setAttribute('x1', v.x); xh.setAttribute('x2', v.x); xh.setAttribute('visibility', 'visible'); tip.innerHTML = v.html;
      tip.hidden = false; const bx = box.getBoundingClientRect(); let left = e.clientX - bx.left + 12; if (left + 190 > bx.width) left -= 210; tip.style.left = left + 'px'; tip.style.top = (e.clientY - bx.top - 10) + 'px';
    });
    hit.addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  }
  const chFrame = (title, aria, g, x0, x1, y0, y1, note, legend, id) => '<div class="mfchart"' + (id === undefined ? '' : ' data-ab="' + id + '"') + '><div class="ct">' + title + '</div>' + (legend || '') + '<svg viewBox="0 0 ' + CH.w + ' ' + CH.h + '" role="img" aria-label="' + aria + '">' + g +
    '<line class="xh" y1="' + y1 + '" y2="' + y0 + '" x1="0" x2="0" visibility="hidden"/><rect class="hit" x="' + x0 + '" y="' + y1 + '" width="' + (x1 - x0) + '" height="' + (y0 - y1) + '"/></svg><div class="mftip" hidden></div>' + (note ? '<div class="note">' + note + '</div>' : '') + '</div>';
  /** direct end labels, nudged apart: ends = [{ k: quality class, y, t: text }], x = where the labels start */
  function chEnds(ends, x) {
    ends.sort((a, b) => a.y - b.y); for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 14);
    return ends.map((e) => '<text class="lab" x="' + x + '" y="' + (e.y + 4).toFixed(1) + '"><tspan class="sw mf-' + e.k + '">\u25cf</tspan> ' + e.t + '</text>').join('');
  }
  const chLegend = (qs) => '<div class="mfleg">' + qs.map((q) => '<span><i class="mf-' + q.k + '"></i>' + q.n + '</span>').join('') + '</div>';
  const chDot = (x, y) => '<circle class="dot" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4.5"/>';
  /** chart 1: chance per run against MF (x linear 0-1000, y log in odds so equal steps are equal improvements) */
  function mfRunChart(d, mfNow, pNow, u) {   // u: 'run' or 'kill'
    u = u || 'run';
    const x0 = CH.l, x1 = CH.w - CH.r, y0 = CH.h - CH.b, y1 = CH.t, xs = (mf) => x0 + mf / 1000 * (x1 - x0);
    const pos = d.ps.filter((p) => p > 0); if (!pos.length) return '';
    let lo = Math.log10(Math.min(...pos)), hi = Math.log10(Math.max(...pos));
    const flat = hi - lo < 1e-9; if (flat) { lo -= .3; hi += .3; } else { lo -= .12; hi += .12; }
    const ys = (p) => y0 - (Math.log10(Math.max(p, 1e-300)) - lo) / (hi - lo) * (y0 - y1);
    let tk = []; for (let k = Math.floor(-hi) - 1; k <= Math.ceil(-lo) + 1; k++) for (const m of [1, 1.5, 2, 3, 5, 7]) tk.push(1 / (m * Math.pow(10, k)));   // p = 1 / (m x 10^k)
    tk = tk.filter((p) => Math.log10(p) >= lo && Math.log10(p) <= hi && p < 1);
    if (tk.length > 5) tk = tk.filter((p, i) => i % Math.ceil(tk.length / 5) === 0);
    if (flat || tk.length < 2) tk = flat ? [d.ps[0]] : [Math.min(...pos), Math.max(...pos)];
    let g = '';
    for (const mf of [0, 200, 400, 600, 800, 1000]) g += '<line class="grid" x1="' + xs(mf) + '" x2="' + xs(mf) + '" y1="' + y1 + '" y2="' + y0 + '"/><text class="ax" x="' + xs(mf) + '" y="' + (y0 + 16) + '" text-anchor="middle">' + mf + '%</text>';
    for (const p of tk) g += '<line class="grid" x1="' + x0 + '" x2="' + x1 + '" y1="' + ys(p).toFixed(1) + '" y2="' + ys(p).toFixed(1) + '"/><text class="ax" x="' + (x0 - 6) + '" y="' + (ys(p) + 4).toFixed(1) + '" text-anchor="end">' + chOdds(p) + '</text>';
    g += '<text class="ax" x="' + (x0 + x1) / 2 + '" y="' + (CH.h - 6) + '" text-anchor="middle">Your magic find</text><text class="ax" transform="translate(12,' + (y0 + y1) / 2 + ') rotate(-90)" text-anchor="middle">Chance per ' + u + ' (odds, log scale)</text>';
    g += '<polyline class="mfl chart-1" points="' + d.mfs.map((mf, i) => xs(mf).toFixed(1) + ',' + ys(d.ps[i]).toFixed(1)).join(' ') + '"/>';
    const m = Math.max(0, Math.min(1000, mfNow)), pm = pNow;
    g += '<line class="ref" x1="' + xs(m) + '" x2="' + xs(m) + '" y1="' + ys(pm).toFixed(1) + '" y2="' + y0 + '"/>' + chDot(xs(m), ys(pm)) +
      '<text class="lab" x="' + (xs(m) + (m > 800 ? -9 : 9)).toFixed(1) + '" y="' + (ys(pm) + (flat ? -10 : 18)).toFixed(1) + '" text-anchor="' + (m > 800 ? 'end' : 'start') + '">you: ' + mfNow + '% MF, ' + chOdds(pm) + '</text>';
    return chFrame('Does magic find help this item?', 'Chance per ' + u + ' of this item against your magic find, at the best source per ' + u, g, x0, x1, y0, y1, flat ? 'Magic find does not change this item\'s chance.' : '');
  }
  /** cumulative chance of having found it after n runs, 0 to the runs for 99%; o (optional) puts the x axis in other units: { u: units per run, title, aria, xl, ax(x), lab(n, x), tip(n, x) } */
  function runsChart(P, o) {
    o = Object.assign({ u: 1, title: 'How many runs until you find it?', aria: 'Chance of having found the item after a number of runs at the best source per run', xl: 'Runs', ax: countFmt, lab: (n) => countFmt(n) + ' runs', tip: (n) => countFmt(n) + ' runs' }, o);
    const n99 = E.trialsFor(P, 0.99), X = n99 * o.u, x0 = CH.l, x1 = CH.w - CH.r - 10, y0 = CH.h - CH.b, y1 = CH.t, xs = (x) => x0 + x / X * (x1 - x0), ys = (c) => y0 - c * (y0 - y1);
    const raw = X / 5, mag = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw * (1 - 1e-9)), st = o.u === 1 ? Math.max(1, step) : step;
    let g = '';
    for (let i = 0; i * st <= X * (1 + 1e-9); i++) g += '<line class="grid" x1="' + xs(i * st).toFixed(1) + '" x2="' + xs(i * st).toFixed(1) + '" y1="' + y1 + '" y2="' + y0 + '"/><text class="ax" x="' + xs(i * st).toFixed(1) + '" y="' + (y0 + 16) + '" text-anchor="middle">' + o.ax(+(i * st).toPrecision(6)) + '</text>';
    for (const c of [0, .25, .5, .75, 1]) g += '<line class="grid" x1="' + x0 + '" x2="' + x1 + '" y1="' + ys(c) + '" y2="' + ys(c) + '"/><text class="ax" x="' + (x0 - 6) + '" y="' + (ys(c) + 4) + '" text-anchor="end">' + c * 100 + '%</text>';
    g += '<text class="ax" x="' + (x0 + x1) / 2 + '" y="' + (CH.h - 6) + '" text-anchor="middle">' + o.xl + '</text><text class="ax" transform="translate(12,' + (y0 + y1) / 2 + ') rotate(-90)" text-anchor="middle">Chance of having found it</text>';
    const cum = (n) => -Math.expm1(n * Math.log1p(-Math.min(P, 1)));
    g += '<polyline class="mfl chart-1" points="' + Array.from({ length: 101 }, (_, i) => xs(X * i / 100).toFixed(1) + ',' + ys(cum(n99 * i / 100)).toFixed(1)).join(' ') + '"/>';
    for (const q of [.5, .9, .99]) {
      const n = E.trialsFor(P, q), x = xs(n * o.u), y = ys(cum(n)), end = n > n99 * .6;
      g += '<line class="ref" x1="' + x0 + '" x2="' + x.toFixed(1) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/><line class="ref" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + y.toFixed(1) + '" y2="' + y0 + '"/>' + chDot(x, y) +
        '<text class="lab" x="' + (x + (end ? -9 : 9)).toFixed(1) + '" y="' + (y + (end ? 16 : 18)).toFixed(1) + '" text-anchor="' + (end ? 'end' : 'start') + '">' + q * 100 + '%: ' + o.lab(n, n * o.u) + '</text>';
    }
    return [chFrame(o.title, o.aria, g, x0, x1, y0, y1), (sx) => {
      const n = Math.max(0, Math.min(n99, Math.round((sx - x0) / (x1 - x0) * X / o.u))); return { x: xs(n * o.u), html: '<b>' + o.tip(n, n * o.u) + '</b><div>' + (cum(n) * 100).toFixed(cum(n) < .1 ? 2 : 1) + '% chance of having found it</div>' };
    }];
  }
  /** (re)draw the charts of the current headline row; only while the Charts section is open */
  let chIn = null;   // the inputs of the last runTab1: { sel, ctx, br, bq }
  function renderCharts1() {
    const box = $('ch1'); if (!chOpen()) return;
    const c = chIn, kill = ch1Kill, row = c && (kill ? c.bk : c.br), u = kill ? 'kill' : 'run';
    const seg = '<div class="seg" role="group" aria-label="Chart per run or per kill"><button type="button" data-m="run"' + (kill ? '' : ' class="on"') + '>Per run (best source per run)</button><button type="button" data-m="kill"' + (kill ? ' class="on"' : '') + '>Per kill (best source per kill)</button></div>';
    const P = row ? (kill ? chKill(c.ctx, row.src, c.sel.mf, c.bq) : runP(row)) : 0;
    if (!row || !(P > 0)) { box.innerHTML = seg + '<div class="note">No source with a chance per ' + u + ' to chart.</div>'; chSeg(box); return; }
    const where = kill || !areaMode() ? srcWhere(row.src) : row.src.areaName + ' (' + DIFF[row.src.diff] + ', whole area clear)';
    const d = chartData(c.sel, c.ctx, row, c.bq, kill);
    const h1 = mfRunChart(d, c.sel.mf, kill ? chKill(c.ctx, row.src, Math.min(c.sel.mf, 1000), c.bq) : chRun(c.ctx, chParts(row), Math.min(c.sel.mf, 1000), c.bq), u);
    let h2 = '', hv = null;
    if (P >= 1) h2 = '<div class="note">This drops on every ' + u + ' at this source.</div>';
    else { const r = kill ? runsChart(P, { title: 'How many kills until you find it?', aria: 'Chance of having found the item after a number of kills at the best source per kill', xl: 'Kills', lab: (n) => countFmt(n) + ' kills', tip: (n) => countFmt(n) + ' kills' }) : runsChart(P); h2 = r[0]; hv = r[1]; }
    box.innerHTML = seg + '<div class="note">At ' + esc(where) + '.</div><div class="charts">' + h1 + h2 + '</div>';
    chSeg(box);
    const bs = box.querySelectorAll('.mfchart');
    if (bs[0]) chartHover(bs[0], (sx) => {
      const v = (sx - CH.l) / (CH.w - CH.l - CH.r) * 1000, i = d.mfs.reduce((a, mf, k) => Math.abs(mf - v) < Math.abs(d.mfs[a] - v) ? k : a, 0), mf = d.mfs[i], p = d.ps[i];   // snaps to the computed MF values
      return { x: CH.l + mf / 1000 * (CH.w - CH.l - CH.r), html: '<b>' + mf + '% MF</b><div>' + chOdds(p) + ' per ' + u + ' (' + (p * 100).toPrecision(3) + '%)</div>' };
    });
    if (hv && bs[1]) chartHover(bs[1], hv);
  }
  /** the per run / per kill toggle above the tab 1 charts (remembered) */
  function chSeg(box) {
    for (const b of box.querySelectorAll('.seg button')) b.onclick = () => { ch1Kill = b.dataset.m === 'kill'; try { localStorage.setItem('d2dc-ch1mode', ch1Kill ? 'kill' : 'run'); } catch (e) { /* ignore */ } renderCharts1(); };
  }


  // ----- tab 2 charts: the top row of the filtered table, cumulative chance against runs and against hours (runs x minutes per game / 60) -----
  const hrsTxt = (h) => h < 1 ? Math.round(h * 60) + ' min' : (h < 10 ? +h.toFixed(2) : countFmt(Math.round(h))) + ' h';
  function renderCharts3() {
    const box = $('ch3'), det = $('charts3'), r = pick3 && $('ar3').value && T3.shownRows && T3.shownRows.find((x) => itKey(x.t) === pick3);
    det.hidden = !r; if (!r || !det.open) return;   // no item picked from the suggestions (or this farm does not drop it): no charts
    if (c3.quest) { box.innerHTML = '<div class="note">A boss quest kill happens once per character and difficulty, so there is no run count to chart.</div>'; return; }
    const P = r.runP, m = mins3(), nm = esc(r.t.name);
    if (!(P > 0)) { box.innerHTML = '<div class="note">No chance per run to chart.</div>'; return; }
    if (P >= 1) { box.innerHTML = '<div class="note">' + nm + ' drops on every run here.</div>'; return; }
    const a = runsChart(P, { title: 'How many runs until you find ' + nm + '?', aria: 'Chance of having found ' + nm + ' after a number of runs' });
    let b = null; if (m) b = runsChart(P, { u: m / 60, title: 'How many hours until you find ' + nm + '?', aria: 'Chance of having found ' + nm + ' after a number of hours', xl: 'Hours (' + +m.toFixed(1) + ' min per game)', ax: (x) => String(+x.toPrecision(3)), lab: (k, h) => h < 1 ? +h.toFixed(2) + ' h (' + hrsTxt(h) + ')' : hrsTxt(h), tip: (k, h) => hrsTxt(h) + ' (' + countFmt(k) + ' runs)' });
    box.innerHTML = '<div class="charts">' + a[0] + (b ? b[0] : '') + '</div>' + (b ? '' : '<div class="note">Type your minutes per game next to Farm to see the chance against hours.</div>');
    const bs = box.querySelectorAll('.mfchart'); chartHover(bs[0], a[1]); if (b) chartHover(bs[1], b[1]);
  }

  // ----- the "MF that counts" chart on the About page: log-log lines per quality, direct labels, legend, hover readout -----
  const MFQ = [{ k: 'magic', n: 'Magic', d: 0 }, { k: 'unique', n: 'Unique', d: 250 }, { k: 'set', n: 'Set', d: 500 }, { k: 'rare', n: 'Rare', d: 600 }];   // d = cap; magic has none
  const mfEff = (mf, d, smooth) => d ? (smooth ? mf * d / (mf + d) : Math.floor(mf * d / (mf + d))) : mf;   // smooth: unrounded, for drawing (the game rounds down)
  const MFC = { w: 640, h: 300, l: 60, r: 120, t: 12, b: 40, lo: 10, hi: 1000 };   // plot box and the MF range (log axes)
  const mfX = (v) => MFC.l + (Math.log10(v) - Math.log10(MFC.lo)) / (Math.log10(MFC.hi) - Math.log10(MFC.lo)) * (MFC.w - MFC.l - MFC.r);
  const mfY = (v) => MFC.h - MFC.b - (Math.log10(Math.max(v, 1)) - Math.log10(MFC.lo)) / (Math.log10(MFC.hi) - Math.log10(MFC.lo)) * (MFC.h - MFC.t - MFC.b);
  function mfChartHtml() {
    const ticks = [10, 30, 100, 300, 1000], x0 = mfX(MFC.lo), x1 = mfX(MFC.hi), y0 = mfY(MFC.lo), y1 = mfY(MFC.hi);
    let g = '';
    for (const t of ticks) g += '<line class="grid" x1="' + mfX(t) + '" x2="' + mfX(t) + '" y1="' + y1 + '" y2="' + y0 + '"/><line class="grid" x1="' + x0 + '" x2="' + x1 + '" y1="' + mfY(t) + '" y2="' + mfY(t) + '"/>' +
      '<text class="ax" x="' + mfX(t) + '" y="' + (y0 + 16) + '" text-anchor="middle">' + t + '%</text><text class="ax" x="' + (x0 - 6) + '" y="' + (mfY(t) + 4) + '" text-anchor="end">' + t + '%</text>';
    g += '<text class="ax" x="' + (x0 + x1) / 2 + '" y="' + (MFC.h - 6) + '" text-anchor="middle">Your MF (log scale)</text>' +
      '<text class="ax" transform="translate(12,' + (y0 + y1) / 2 + ') rotate(-90)" text-anchor="middle">MF that counts (log scale)</text>';
    let lines = '';
    const ends = [];
    for (const q of MFQ) {
      const pts = []; for (let i = 0; i <= 80; i++) { const v = MFC.lo * Math.pow(MFC.hi / MFC.lo, i / 80); pts.push(mfX(v).toFixed(1) + ',' + mfY(mfEff(v, q.d, true)).toFixed(1)); }
      lines += '<polyline class="mfl mf-' + q.k + '" points="' + pts.join(' ') + '"/>';
      ends.push({ k: q.k, y: mfY(mfEff(MFC.hi, q.d, true)), t: q.n + (q.d ? ' (cap ' + q.d + ')' : ' (no cap)') });
    }
    lines += chEnds(ends, x1 + 8);   // keeps the end labels apart
    return '<div class="mfchart">' + chLegend(MFQ) + '<svg viewBox="0 0 ' + MFC.w + ' ' + MFC.h + '" role="img" aria-label="The MF that counts for each item quality against your MF, on log scales">' + g + lines +
      '<line class="xh" y1="' + y1 + '" y2="' + y0 + '" x1="0" x2="0" visibility="hidden"/><rect class="hit" x="' + x0 + '" y="' + y1 + '" width="' + (x1 - x0) + '" height="' + (y0 - y1) + '"/></svg><div class="mftip" hidden></div></div>';
  }
  function initMfChart() {   // hover: a crosshair at the pointer's MF and a readout of every quality
    const box = document.querySelector('#about .mfchart:not([data-ab])'); if (!box) return;
    const svg = box.querySelector('svg'), xh = svg.querySelector('.xh'), hit = svg.querySelector('.hit'), tip = box.querySelector('.mftip');
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) * MFC.w / r.width;
      const mf = Math.round(Math.pow(10, Math.log10(MFC.lo) + (sx - mfX(MFC.lo)) / (mfX(MFC.hi) - mfX(MFC.lo)) * (Math.log10(MFC.hi) - Math.log10(MFC.lo))));
      xh.setAttribute('x1', mfX(mf)); xh.setAttribute('x2', mfX(mf)); xh.setAttribute('visibility', 'visible');
      tip.innerHTML = '<b>' + mf + '% MF</b>' + MFQ.map((q) => '<div><i class="mf-' + q.k + '"></i>' + q.n + ': ' + mfEff(mf, q.d) + '%</div>').join('');
      tip.hidden = false; const bx = box.getBoundingClientRect(); let left = e.clientX - bx.left + 12; if (left + 150 > bx.width) left -= 170; tip.style.left = left + 'px'; tip.style.top = (e.clientY - bx.top - 10) + 'px';
    });
    hit.addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  }

  // ----- three explanatory charts in the About text: same frame, grid, hover and colours as the Tab 1 charts; each returns [html, hover] and aboutHtml files the hover under its data-ab index -----
  const abHov = [];
  const abXT = (x, label) => '<line class="grid" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + CH.t + '" y2="' + (CH.h - CH.b) + '"/><text class="ax" x="' + x.toFixed(1) + '" y="' + (CH.h - CH.b + 16) + '" text-anchor="middle">' + label + '</text>';   // vertical grid line + x tick label
  const abAxT = (xl, yl, x0, x1, y0, y1) => '<text class="ax" x="' + (x0 + x1) / 2 + '" y="' + (CH.h - 6) + '" text-anchor="middle">' + xl + '</text><text class="ax" transform="translate(12,' + (y0 + y1) / 2 + ') rotate(-90)" text-anchor="middle">' + yl + '</text>';
  const abYPct = (ys, x0, x1) => [0, .25, .5, .75, 1].map((c) => '<line class="grid" x1="' + x0 + '" x2="' + x1 + '" y1="' + ys(c) + '" y2="' + ys(c) + '"/><text class="ax" x="' + (x0 - 6) + '" y="' + (ys(c) + 4) + '" text-anchor="end">' + c * 100 + '%</text>').join('');   // y grid 0-100%
  /** chart A: chance of having found a 1-in-N item after x x N tries, 1 - e^-x (the large-N limit of 1 - (1 - 1/N)^(xN)) */
  function triesChart(id, note) {
    const X = 5, x0 = CH.l, x1 = CH.w - CH.r - 10, y0 = CH.h - CH.b, y1 = CH.t, xs = (x) => x0 + x / X * (x1 - x0), ys = (c) => y0 - c * (y0 - y1), cum = (x) => -Math.expm1(-x);
    let g = ''; for (let i = 0; i <= X; i++) g += abXT(xs(i), i ? i + ' × N' : '0');
    g += abYPct(ys, x0, x1) + abAxT('Tries, as a multiple of N', 'Chance of having found it', x0, x1, y0, y1);
    g += '<polyline class="mfl chart-1" points="' + Array.from({ length: 101 }, (_, i) => xs(X * i / 100).toFixed(1) + ',' + ys(cum(X * i / 100)).toFixed(1)).join(' ') + '"/>';
    for (const [x, t] of [[Math.LN2, '0.69'], [1, '1'], [Math.LN10, '2.3'], [2 * Math.LN10, '4.6']]) {
      const px = xs(x), py = ys(cum(x)), end = x > 4;
      g += '<line class="ref" x1="' + x0 + '" x2="' + px.toFixed(1) + '" y1="' + py.toFixed(1) + '" y2="' + py.toFixed(1) + '"/><line class="ref" x1="' + px.toFixed(1) + '" x2="' + px.toFixed(1) + '" y1="' + py.toFixed(1) + '" y2="' + y0 + '"/>' + chDot(px, py) +
        '<text class="lab" x="' + (px + (end ? -9 : 9)).toFixed(1) + '" y="' + (py + 18).toFixed(1) + '" text-anchor="' + (end ? 'end' : 'start') + '">' + Math.round(cum(x) * 100) + '%: ' + t + ' × N</text>';
    }
    return [chFrame('1 in N does not mean N tries', 'Chance of having found a 1 in N item against the number of tries as a multiple of N', g, x0, x1, y0, y1, note, '', id), (sx) => {
      const x = Math.max(0, Math.min(X, Math.round((sx - x0) / (x1 - x0) * X * 100) / 100)); return { x: xs(x), html: '<b>' + x.toFixed(2) + ' × N tries</b><div>' + (cum(x) * 100).toFixed(1) + '% chance of having found it</div>' };
    }];
  }
  const ABQ = [{ k: 'unique', n: 'Unique', a: 'u' }, { k: 'set', n: 'Set', a: 's' }, { k: 'rare', n: 'Rare', a: 'r' }, { k: 'magic', n: 'Magic', a: 'm' }];
  /** chart B: chance per check at 0% MF against the level gap, from the ordinary-base row of the quality table: X = max(Ratio - floor(gap / Divisor), Min / 128) */
  function gapChart(id) {
    const row = E.data.ratio.find((r) => r.ver === E.CONFIG.itemRatioVersion && !r.uber && !r.cls), G = 80, lo = 7, hi = 480;
    const x0 = CH.l, x1 = CH.w - 110, y0 = CH.h - CH.b, y1 = CH.t, xs = (v) => x0 + v / G * (x1 - x0), ys = (X) => y1 + (Math.log10(X) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (y0 - y1);   // a smaller X is a better chance: it sits higher
    const X = (q, v) => { const a = row[q.a]; return Math.max(a[0] - Math.floor(v / a[1]), a[2] / 128); };
    let g = ''; for (let v = 0; v <= G; v += 20) g += abXT(xs(v), v);
    for (const n of [10, 20, 50, 100, 200, 400]) g += '<line class="grid" x1="' + x0 + '" x2="' + x1 + '" y1="' + ys(n).toFixed(1) + '" y2="' + ys(n).toFixed(1) + '"/><text class="ax" x="' + (x0 - 6) + '" y="' + (ys(n) + 4).toFixed(1) + '" text-anchor="end">1 in ' + n + '</text>';
    g += abAxT('Level gap (monster level − base item level)', 'Chance per check at 0% MF (odds, log scale)', x0, x1, y0, y1);
    const ends = [];
    for (const q of ABQ) { g += '<polyline class="mfl mf-' + q.k + '" points="' + Array.from({ length: G + 1 }, (_, v) => xs(v).toFixed(1) + ',' + ys(X(q, v)).toFixed(1)).join(' ') + '"/>'; ends.push({ k: q.k, y: ys(X(q, G)), t: q.n }); }
    g += chEnds(ends, x1 + 8);
    return [chFrame('Level gap and quality', 'Chance per quality check at zero magic find against the level gap, for unique, set, rare and magic items, on a log scale', g, x0, x1, y0, y1, '', chLegend(ABQ), id), (sx) => {
      const v = Math.max(0, Math.min(G, Math.round((sx - x0) / (x1 - x0) * G))); return { x: xs(v), html: '<b>Level gap ' + v + '</b>' + ABQ.map((q) => '<div><i class="mf-' + q.k + '"></i>' + q.n + ': 1 in ' + chNum(X(q, v)) + '</div>').join('') };
    }];
  }
  /** the two real tables of chart C: NoDrop and the weight of everything else (the game's own table values) */
  const ABTC = [{ k: 'magic', n: 'Boss', tc: 'Mephisto (H)', d: 'Mephisto (Hell)' }, { k: 'unique', n: 'Regular monster', tc: 'Act 5 (H) H2H C', d: 'Act 5 (Hell) H2H C' }];
  const abTcInfo = (t) => { const tc = E.data.tc[t.tc]; return { nd: tc.nd, w: tc.e.reduce((a, e) => a + Math.max(0, e[1]), 0) }; };
  /** chart C: chance that one pick drops something (not NoDrop) against the players count N, with the engine's own NoDrop adjustment */
  function playersChart(id) {
    const x0 = CH.l, x1 = CH.w - 150, y0 = CH.h - CH.b, y1 = CH.t, xs = (n) => x0 + (n - 1) / 7 * (x1 - x0), ys = (c) => y0 - c * (y0 - y1);
    const inf = ABTC.map(abTcInfo), pk = (i, n) => inf[i].w / (inf[i].w + E.adjNoDrop(inf[i].nd, inf[i].w, n));
    let g = ''; for (let n = 1; n <= 8; n++) g += abXT(xs(n), n);
    g += abYPct(ys, x0, x1) + abAxT('Players (N)', 'Chance one pick drops something', x0, x1, y0, y1);
    const ends = [];
    ABTC.forEach((t, i) => {
      g += '<polyline class="mfl mf-' + t.k + '" points="' + Array.from({ length: 8 }, (_, j) => xs(j + 1).toFixed(1) + ',' + ys(pk(i, j + 1)).toFixed(1)).join(' ') + '"/>';
      for (let n = 1; n <= 8; n++) g += '<circle class="mk mf-' + t.k + '" cx="' + xs(n).toFixed(1) + '" cy="' + ys(pk(i, n)).toFixed(1) + '" r="4.5"/>';
      ends.push({ k: t.k, y: ys(pk(i, 8)), t: t.n });
    });
    g += chEnds(ends, x1 + 12);
    return [chFrame('More players, fewer empty drops', 'Chance that one pick of a treasure class drops something against the number of players, for a boss and a regular monster', g, x0, x1, y0, y1, '', chLegend(ABTC), id), (sx) => {
      const n = Math.max(1, Math.min(8, Math.round((sx - x0) / (x1 - x0) * 7 + 1))); return { x: xs(n), html: '<b>N = ' + n + '</b>' + ABTC.map((t, i) => '<div><i class="mf-' + t.k + '"></i>' + t.n + ': ' + (pk(i, n) * 100).toFixed(1) + '%</div>').join('') };
    }];
  }
  function initAboutCharts() {   // hover for the charts above that sit in the About text
    document.querySelectorAll('#about .mfchart[data-ab]').forEach((b) => chartHover(b, abHov[+b.dataset.ab]));
  }

  function aboutHtml() {
    const C = E.CONFIG, R = C.run, h = (t) => '<h2>' + t + '</h2>', li = (xs) => '<ul>' + xs.map((x) => '<li>' + x + '</li>').join('') + '</ul>';
    const M = (x) => '<span class="math">' + x + '</span>';   // a formula, set in the math font (x is trusted markup: <i> variables, <sup> powers)
    const V = (x) => '<span class="math v"><i>' + x + '</i></span>';   // one variable in running text
    abHov.length = 0; const ab = (f, note) => { const c = f(abHov.length, note); abHov.push(c[1]); return c[0]; };   // build a chart and file its hover under its data-ab index
    return h('What this is') +
      '<p>A drop calculator for Diablo II: Resurrected, built straight from the game\'s own data tables (game data ' + esc(E.data.meta.gameVersion) + ', ' + (E.mode === 'lod' ? 'Lord of Destruction' : 'Reign of the Warlock') + ' mode). ' +
      'It answers two questions: <i>where does an item drop, and how often</i> (tab 1), and <i>what does a farm drop</i> (tab 2). The item builder (tab 3) works out the odds of a base rolling the affixes you want.</p>' +
      h('Reading the numbers') + li([
        'All chances are shown as odds: "1 in 250" means once every 250 tries on average. Smaller numbers are better.',
        'Tab 1 has a "Charts" section: how the chance per run changes with your magic find, and how many runs it takes to find the item.',
        '<b>Per kill</b>: the chance one kill of that monster drops the item.',
        '<b>Per run</b>: the chance of at least one drop in one run (a whole area cleared, or a farm\'s fixed set of kills): ' + M('<i>P</i> = 1 &minus; (1 &minus; <i>p</i>)<sup><i>k</i></sup>') + ', with ' + V('p') + ' the chance per kill and ' + V('k') + ' the kills per run. With several kinds of monster in a run, each kind keeps its own chance and kills: ' + M('<i>P</i> = 1 &minus; (1 &minus; <i>p</i><sub>1</sub>)<sup><i>k</i><sub>1</sub></sup> &times; (1 &minus; <i>p</i><sub>2</sub>)<sup><i>k</i><sub>2</sub></sup> &times; &hellip;') + '.',
        '<b>Runs for 50%</b>: how many runs until you have even odds of having found it: ' + M('<i>n</i> = &lceil;ln 0.5 / ln(1 &minus; <i>P</i>)&rceil;') + '. Hover the cell for other percentages.',
        '<b>Per hour</b> (tab 2): ' + M('1 &minus; (1 &minus; <i>P</i>)<sup>60 / <i>m</i></sup>') + ', with ' + V('m') + ' the minutes per game from the Farming settings in Your game, or your own value.',
        '<b>mlvl</b> is the monster level, which is also the item level of what it drops. Champions add ' + C.champOffset + ', uniques ' + C.uniqueOffset + ', minions of uniques ' + C.minionOffset + '.']) +
      '<p>A "1 in ' + V('N') + '" chance does not mean you will find it within ' + V('N') + ' tries. After as many tries as the odds say (500 runs at 1 in 500) you have only about 63%; even odds take about 0.7 &times; ' + V('N') + ', and 90% about 2.3 &times; ' + V('N') + '.</p>' +
      ab(triesChart, 'The curve is ' + M('1 &minus; e<sup>&minus;<i>x</i></sup>') + ', the large-' + V('N') + ' limit of ' + M('1 &minus; (1 &minus; 1 / <i>N</i>)<sup><i>xN</i></sup>') + ', with ' + V('x') + ' the tries in multiples of ' + V('N') + '. It is the same for every item.') +
      h('How much to trust them') + li([
        '<b>Per kill: high.</b> These come straight from the drop tables and are checked against an independent calculation and published figures.',
        '<b>Bosses and fixed farms: high.</b> Bosses, super uniques and their minions are counted exactly (seal pop, council, Pindleskin, ...).',
        '<b>Whole-area clears: rough, about +/-50%.</b> Kills per run is an estimate. It ranks areas against each other better than it counts them. Caves are the most reliable (their size comes from re-running the game\'s cave generator, see below); special layouts (Chaos Sanctuary, Arcane Sanctuary) the least.',
        '<b>Minutes per game: rough guesses</b> from community experience, not measurements. Type your own times next to the farm.']) +
      h('Good to know') + li([
        '<b>Tal Rasha\'s Tomb</b> means the true tomb (the one with the orifice), which is about three times the size of a plain tomb.',
        '<b>Heralds</b> (terror zones) show per-kill odds only: how often a herald appears is not modelled.',
        '<b>Ladder</b>: hover the Ladder setting to see which items drop on ladder only right now.',
        'Matron\'s Den, Forgotten Sands, Furnace of Pain and Uber Tristram exist in Hell only.',
        '<b>Poison in the item builder</b>: the numbers match the item\'s tooltip, but with only one poison source the real effect is about half the damage over half the time (the game divides the duration by the number of poison sources).']) +
      h('How the odds are calculated') +
      '<p><b>Drop tables.</b> Every monster has a <i>treasure class</i>: a list of possible drops, each with a weight, plus a weight for dropping nothing (NoDrop). One pick takes an entry with chance ' +
        M('<i>w</i> / (<i>W</i> + NoDrop)') + ', where ' + V('w') + ' is its weight and ' + V('W') + ' the total of all weights. A table rolled ' + V('k') + ' times gives an entry at least once with ' + M('1 &minus; (1 &minus; <i>s</i>)<sup><i>k</i></sup>') +
        ', ' + V('s') + ' being its chance per pick. Tables can contain other tables; their chances multiply. A monster\'s table is upgraded to the best one of its group that its level allows (bosses keep theirs, except in a terror zone). One kill drops at most ' + C.dropCap + ' items, which matters for bosses that drop a lot (Duriel most of all).</p>' +
      '<p><b>Players.</b> More players lower the chance of dropping nothing. The game counts ' + M('<i>N</i> = party nearby + &lfloor;(other players) / 2&rfloor;') + ' and replaces NoDrop with ' +
        M('&lfloor;<i>Items</i> / (1 / (NoDrop / (NoDrop + <i>Items</i>))<sup><i>N</i></sup> &minus; 1)&rfloor;') + ', where ' + V('Items') + ' is the weight of everything else.</p>' +
      ab(playersChart, 'Real tables: ' + ABTC.map((t) => { const i = abTcInfo(t); return t.d + ' (NoDrop ' + i.nd + ', everything else ' + i.w + ')'; }).join(' and ') + '. ' + V('N') + ' counts party members nearby fully and the other players in the game at half.') +
      '<p><b>Item quality.</b> When a base drops, the game tries unique, then set, rare, magic, superior and normal; the first that succeeds is what you get (if none does, low quality). Each try succeeds with a chance of 1 in ' + V('X') + ', where ' + V('X') + ' is built in three steps:</p><ol>' +
        '<li><b>Start</b> from the quality\'s base number: unique 400, set 160, rare 100, magic 34 for an ordinary base (class-specific bases use other values).</li>' +
        '<li><b>Subtract the level gap</b>: ' + M('(mlvl &minus; qlvl) / Divisor') + ', with Divisor 1 for unique, 2 for set and rare, 3 for magic. So a monster far above the item\'s base level gives better odds.' +
          '<p>The level gap alone, at 0% MF: uniques gain one step per level of gap, magic one per three levels (set and rare one per two). The monster\'s own quality bonus is not included.</p>' +
          ab(gapChart) + '</li>' +
        '<li><b>Apply magic find</b>: the chance is multiplied by ' + M('1 + MF / 100') + ', so 100% MF doubles it. For unique, set and rare items the game first shrinks your MF with a cap for that quality: ' +
          '<b>250 for unique, 500 for set, 600 for rare</b>. The MF that counts gets closer to the cap the more MF you have but never reaches it, and is exactly half the cap when your MF equals the cap (' + M('MF &times; cap / (MF + cap)') + '). Magic items use your full MF.</li></ol>' +
        '<table class="mft"><caption>The MF that counts</caption><tr><th>Your MF</th><th>Unique</th><th>Set</th><th>Rare</th><th>Magic</th></tr>' +
        '<tr><td>100%</td><td>71%</td><td>83%</td><td>85%</td><td>100%</td></tr>' +
        '<tr><td>200%</td><td>111%</td><td>142%</td><td>150%</td><td>200%</td></tr>' +
        '<tr><td>300%</td><td>136%</td><td>187%</td><td>200%</td><td>300%</td></tr>' +
        '<tr><td>500%</td><td>166%</td><td>250%</td><td>272%</td><td>500%</td></tr>' +
        '<tr><td>1000%</td><td>200%</td><td>333%</td><td>375%</td><td>1000%</td></tr>' + '</table>' +
        '<p><b>In short, this is diminishing returns on magic find.</b> Each extra point of MF adds less than the one before for uniques, sets and rares, and their curves flatten toward the cap; magic items keep the full value. On log scales:</p>' +
        mfChartHtml() +
        '<p>' + V('X') + ' never goes below a floor (unique 50, set about 44, rare 25), so even huge magic find cannot beat 1 in 50 for a unique; a monster\'s own quality bonus (bosses, champions) then improves the chance further. ' +
        'Example, unique, monster 27 levels above the base: ' + M('400 &minus; 27 = 373') + ', so 1 in 373 at 0 MF; with 300% MF, 136% counts for uniques (table above), so the chance is multiplied by 2.36: ' + M('373 / 2.36 &asymp; 158') + ', 1 in 158. ' +
        'A unique or set item with no candidate at that item level drops as rare or magic instead. The game\'s integer arithmetic is reproduced exactly.</p>' +
      '<p><b>Monster level.</b> In Normal it is the monster\'s own level; in Nightmare and Hell it is the area\'s level. Act bosses have fixed levels (Hell: Andariel 75, Mephisto 87, Diablo 94, Baal 99). Champions add ' + C.champOffset + ', uniques and super uniques ' + C.uniqueOffset + '. In a terror zone the level follows your character level, within the zone\'s limits.</p>' +
      '<p><b>Item builder.</b> An affix can roll when the item\'s affix level reaches it: ' + M('alvl = ilvl &minus; &lfloor;qlvl / 2&rfloor;') + ' for most bases (bases with a magic level add it instead). Magic items get a prefix and a suffix 25% of the time, only a prefix 25%, only a suffix 50%. ' +
        'Rare items get 3, 4, 5 or 6 affixes with chances 12.5 / 25 / 37.5 / 25% (rare jewels: 3 or 4, 50% each), at most 3 of each side, never two from the same group. Normal and superior white items have a 33% chance of sockets, and any item that can be ethereal a 5% chance of being so. Rare and magic odds are computed exactly, not simulated.</p>' +
      h('Limitations') + li([
        'Kills per run assumes you clear the whole area and ignores route length, shrines and monsters you skip.',
        'Super unique and boss locations are not in the game data; they were mapped by hand from the community references below.',
        'Runewords, crafting and the game\'s quest conditions are not modelled.',
        'The rules come from a decompilation of the original game (versions 1.10-1.14) plus D2R\'s own data tables; where D2R changed code without changing the tables, the calculator cannot know.']) +
      h('Sources') + li([
        '<a href="https://github.com/ThePhrozenKeep/D2MOO" target="_blank" rel="noopener">D2MOO</a>: community decompilation of the game code (drop, quality, affix and spawn rules)',
        '<a href="https://gist.github.com/SeanSullivan86/e912b40bb85f9822b9ef507d91534c88" target="_blank" rel="noopener">Decompiled drop routine</a> (treasure classes, the item cap, player count)',
        '<a href="https://www.purediablo.com/diablo-2/item-generation" target="_blank" rel="noopener">PureDiablo: Item Generation</a> and <a href="https://www.purediablo.com/?p=6422" target="_blank" rel="noopener">Players X Overview</a>',
        '<a href="http://classic.battle.net/diablo2exp/" target="_blank" rel="noopener">The Arreat Summit</a> (super unique locations)',
        '<a href="https://diablo2.io/post4136083.html" target="_blank" rel="noopener">diablo2.io datamine thread</a>, <a href="https://www.icy-veins.com/d2/reign-of-the-warlock-endgame-changes-for-diablo-ii-resurrected" target="_blank" rel="noopener">Icy Veins on Reign of the Warlock</a> and <a href="https://news.blizzard.com/en-us/article/24266710/diablo-ii-resurrected-ptr-3-2-now-live" target="_blank" rel="noopener">Blizzard\'s patch notes</a> (heralds, Sunder charms)']) +
      '<details class="tech"><summary>How kills per run are estimated (technical)</summary>' +
      '<p>The game makes one spawn roll for every ' + M('3 &times; 3') + ' subtiles of each room (about 2.7 per tile) and spawns a pack with chance ' + M('MonDen / 100&#8239;000') + '. Walkable floor comes from the real map files (20 placement tries per pack).</p>' +
      '<p><b>The cave generator.</b> Caves, dungeons and tombs are not drawn by hand: every game builds them at random from pre-made room pieces, so their size changes from game to game. ' +
      'This calculator re-runs that building step the way the game does it (rebuilt from the community decompilation of the game code), 2,000 times per level, and uses the average number of rooms that can hold monsters as the cave\'s size.</p><p>' +
      'On top of that, one global factor of ' + R.placeFactor + ' is applied, fitted to a measured Cow Level count (it is not from the game code). Packs are picked from the area\'s monster list by rarity and include party minions. ' +
      'Champion and unique packs follow MonUMin / MonUMax: ' + R.champShare * 100 + '% are champion packs of 2-4, the rest a unique with ' + R.uniqueMinions.join('-') + ' minions. Monsters placed at fixed spots by the map files are added and use up unique slots.</p></details>' +
      '<details class="tech"><summary>Settings in use (the calculator\'s constants)</summary><pre>' + esc(JSON.stringify(C, null, 2)) + '</pre></details>' +
      '<p class="note">Diablo II: Resurrected and its game data belong to Blizzard Entertainment. This is an unofficial fan tool.</p>';
  }


  init().catch((e) => { document.body.insertAdjacentHTML('afterbegin', '<pre style="color:var(--err);padding:10px">' + esc(e.stack || e) + '</pre>'); });
})();
