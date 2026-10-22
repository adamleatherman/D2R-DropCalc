/* UI for the D2R drop calculator. All math lives in engine.js. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DIFF = ['Normal', 'Nightmare', 'Hell'];
  let E = null, S = null, INDEX = [], BASEOPTS = [];
  // one data file and one engine per game mode, loaded on first use and kept
  const DATAFILE = { rotw: 'data.json', lod: 'data-lod.json' };
  const ENGINES = {};
  let worker = null, reqId = 0;

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
      mode: E.mode, tier: parseInt($('s_tier').value, 10) || 1,
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
      const shown = rows.slice(0, st.limit);
      let h = '<thead><tr>' + vcols.map((c) => '<th class="' + (c.l ? 'l' : '') + '" data-k="' + c.k + '"' + (c.note ? ' title="' + esc(c.note) + '"' : '') + '>' + esc(c.label) + (c.k === st.key ? (st.dir < 0 ? ' v' : ' ^') : '') + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of shown) h += '<tr>' + vcols.map((c) => '<td class="' + (c.l ? 'l' : '') + '">' + (c.html ? c.html(r) : esc(c.fmt ? c.fmt(r) : c.get(r))) + '</td>').join('') + '</tr>';
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
    st.render = render;
    return st;
  }

  const HERALD_TIP = 'Drop table: monstats TreasureClassHerald(H), group-upgraded at mlvl + herald tier boost (group 41: Act N (H) Herald A-C).';
  const rankTag = (r) => r === 'regular' ? '' : r === 'herald' ? ' <span class="tag herald" title="' + esc(HERALD_TIP) + '">herald</span>' : ' <span class="tag ' + r + '">' + r + '</span>';
  const srcCols = [
    { k: 'name', label: 'Monster', l: 1, get: (r) => r.src.name, html: (r) => esc(r.src.name) + rankTag(r.src.rank) },
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
      items = source().filter((x) => { const t = x.label.toLowerCase(); return words.every((w) => t.indexOf(w) >= 0); })
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
    if (srcCache.sig !== sig) srcCache = { sig, list: E.sources(ctx) };
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
      if (f && (src.name + ' ' + src.areaName).toLowerCase().indexOf(f) < 0) continue;
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

  // ---------------- Tab 2 ----------------
  let T2 = null, conds = [], statCodes = [];
  const cols2 = srcCols.concat([
    { k: 'alvl', label: 'alvl', get: (r) => r.alvl },
    { k: 'pbase', label: 'P(base)', get: (r) => r.pBase, fmt: (r) => odds(r.pBase) },
    { k: 'pq', label: 'P(base x quality)', get: (r) => r.pQual, fmt: (r) => odds(r.pQual) },
    { k: 'paff', label: 'P(affixes | quality)', get: (r) => r.pAff, fmt: (r) => odds(r.pAff) },
    { k: 'ptot', label: 'P per kill', note: 'Chance that one kill drops a matching item (shown as odds; sorts by probability).', get: (r) => r.pTotal, fmt: (r) => odds(r.pTotal) },
    { k: 'runs', label: 'kills/run', get: (r) => r.src.perRun, fmt: (r) => r.src.herald ? 'n/a' : r.src.perRun < 10 ? r.src.perRun.toFixed(2) : r.src.perRun.toFixed(0) },
    { k: 'perrun', label: 'P per run', note: 'Chance of a matching item in one run (rough model; shown as odds).', get: (r) => r.perRun, fmt: (r) => odds(r.perRun) },
  ]);
  let base2 = null;

  function baseCodes(b) {
    if (!b) return [];
    if (b.kind === 'base') return [b.code];
    return b.codes.filter((c) => E.items[c].sp);
  }
  function refreshStats() {
    const codes = baseCodes(base2);
    if (!codes.length) return;
    const stats = E.statList(codes, $('ql2').value);
    statCodes = stats;
    $('statlist').innerHTML = stats.map((s) => '<option value="' + esc(s.key) + '">max ' + s.max + '</option>').join('');
  }
  function addCond(key, min) {
    const div = document.createElement('div');
    div.className = 'cond';
    div.innerHTML = '<input list="statlist" class="ck" placeholder="stat (type to search, e.g. Faster Cast, Sorceress, Life)"> &gt;= <input type="number" class="cm" value="' + (min || 1) + '" min="1"> <button class="rm">x</button>';
    if (key) div.querySelector('.ck').value = key;
    div.querySelector('.rm').onclick = () => div.remove();
    $('conds').appendChild(div);
  }
  function readConds() {
    const out = [];
    for (const d of $('conds').children) {
      const key = d.querySelector('.ck').value.trim();
      const min = parseFloat(d.querySelector('.cm').value);
      if (key) out.push({ key, min: isNaN(min) ? 1 : min });
    }
    return out;
  }

  function runTab2() {
    if (!base2) { $('info2').textContent = 'Pick a base or base type first.'; return; }
    const cs = readConds();
    if (!cs.length) { $('info2').textContent = 'Add at least one condition.'; return; }
    const known = new Set(statCodes.map((s) => s.key));
    const bad = cs.find((c) => !known.has(c.key));
    if (bad) { $('info2').textContent = 'Unknown stat "' + bad.key + '" for this base/quality - choose from the list.'; return; }
    const sel = S = readSel(); saveSel();
    const opts = { codes: baseCodes(base2), quality: $('ql2').value, conds: cs, mf: sel.mf, diff: sel.diff, act: sel.act,
      area: parseInt($('ar2').value || '0', 10), rolls: parseInt($('mc2').value, 10) };
    const ctxS = { players: sel.players, party: sel.party, ladder: sel.ladder, tz: sel.tz, quest: sel.quest, clvl: sel.clvl, mf: sel.mf, tier: sel.tier };
    const id = ++reqId;
    $('prog2').hidden = false; $('prog2').value = 0; $('info2').textContent = 'Working...'; $('go2').disabled = true;
    const t0 = performance.now();
    const finish = (res) => {
      $('go2').disabled = false; $('prog2').hidden = true;
      let rows = res.rows;
      if (sel.tz) rows = rows.filter((r) => r.src.tz);
      T2.rows = rows; T2.limit = parseInt($('n2').value, 10);
      // rank by per-run when an area is selected, otherwise by per-kill
      T2.key = opts.area ? 'perrun' : 'ptot'; T2.dir = -1;
      const r = T2.render();
      $('info2').textContent = r.total.toLocaleString() + ' sources (showing ' + r.shown + '); ' + res.pools + ' distinct (base, affix level) pools; ' +
        (opts.quality === 'rare' ? 'Monte Carlo ' + opts.rolls.toLocaleString() + ' rolls/pool' : 'exact enumeration') + (sel.quest ? '; quest drop (act bosses)' : '') + '; ' + Math.round(performance.now() - t0) + ' ms';
      const lines = [];
      cs.forEach((c, i) => {
        let best = null;
        for (const m of res.minLv) { const x = m[i]; if (x && x.alvl !== null && (!best || x.alvl < best.alvl)) best = x; }
        lines.push(esc(c.key) + ' >= ' + c.min + ': ' + (best ? 'needs affix level ' + best.alvl + ' (monster/item level ' + best.mlvl + '+)' : 'no affix can reach this'));
      });
      $('min2').innerHTML = 'Minimum levels (per condition on its own): ' + lines.join(' &nbsp;|&nbsp; ');
    };
    if (worker) {
      worker.onmessage = (ev) => {
        const m = ev.data; if (m.id !== id) return;
        if (m.type === 'progress') $('prog2').value = m.done / m.total;
        else if (m.type === 'result') finish(m);
        else if (m.type === 'error') { $('go2').disabled = false; $('prog2').hidden = true; $('info2').textContent = 'Error: ' + m.message; }
      };
      worker.postMessage({ type: 'search', id, ctx: ctxS, opts, file: DATAFILE[sel.mode] });
    } else {
      // fallback (no Worker support): run on the main thread
      setTimeout(() => {
        const res = E.affixSearch(E.getCtx(ctxS), opts, null);
        finish(res);
      }, 20);
    }
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
    const typeOpts = [];
    for (const [code, list] of E.baseTypes()) {
      if (!list.some((c) => E.items[c].sp)) continue;
      if (!list.some((c) => E.items[c].cr || E.items[c].am)) continue;
      typeOpts.push({ kind: 'type', code, codes: list, label: 'Any ' + E.types[code].n.toLowerCase() + ' (' + list.length + ' bases, type ' + code + ')' });
    }
    BASEOPTS = typeOpts.concat(INDEX.filter((x) => x.kind === 'base' && E.items[x.code].sp && !E.items[x.code].an));
    const areas = Object.keys(E.data.levels).filter((id) => E.data.levels[id].mon.length || E.data.levels[id].nmon.length)
      .map((id) => ({ id, a: E.data.levels[id] })).sort((x, y) => x.a.act - y.a.act || x.id - y.id);
    const cur = $('ar2').value;
    $('ar2').innerHTML = '<option value="">All areas</option>' + areas.map((x) => '<option value="' + x.id + '">Act ' + x.a.act + ' - ' + esc(x.a.name) + '</option>').join('');
    if (areas.some((x) => x.id === cur)) $('ar2').value = cur;
    $('info1').textContent = 'Ready. ' + INDEX.length + ' items indexed, ' + Object.keys(E.data.levels).length + ' areas, ' + Object.keys(E.data.monsters).length + ' monster types.';
    updTier();
  }
  const sameTarget = (x, y) => x.kind === y.kind && (x.code || x.id) === (y.code || y.id);

  /** Game mode selector: swap engine + data, re-index, drop the old results and re-run the current tab. */
  async function switchMode(m) {
    const had2 = T2 && T2.rows.length > 0;
    await useEngine(m);
    if (target1) { target1 = INDEX.find((x) => sameTarget(x, target1)) || null; if (!target1) { $('q1').value = ''; T1.rows = []; T1.render(); } }
    if (base2) { base2 = BASEOPTS.find((x) => sameTarget(x, base2)) || null; if (!base2) { $('q2').value = ''; $('conds').innerHTML = ''; } }
    if (base2) refreshStats();
    T2.rows = []; T2.render();
    if (target1) runTab1();
    if (had2 && base2) runTab2();
  }

  async function init() {
    loadSel();
    const qs0 = new URLSearchParams(location.search);
    if (qs0.get('mode')) $('s_mode').value = qs0.get('mode');
    if (qs0.get('tz')) { $('s_tz').checked = true; $('s_clvl').value = qs0.get('tz'); }
    if (qs0.get('tier')) $('s_tier').value = qs0.get('tier');
    if (qs0.get('mf')) $('s_mf').value = qs0.get('mf');
    await useEngine($('s_mode').value);
    const noWorker = new URLSearchParams(location.search).has('noworker');
    try { if (noWorker) throw new Error('worker disabled'); worker = new Worker('worker.js'); worker.onerror = () => { worker = null; }; } catch (e) { worker = null; }

    // tabs
    const tabs = ['t1', 't2', 't3'];
    tabs.forEach((t, i) => $(t).onclick = () => {
      tabs.forEach((x, j) => { $(x).classList.toggle('on', i === j); $('tab' + (j + 1)).classList.toggle('on', i === j); });
    });
    for (const k of KEYS) $(k).addEventListener('change', () => {
      saveSel();
      if (k === 's_mode') { switchMode($('s_mode').value).catch((e) => { $('info1').textContent = 'Could not load data: ' + e; }); return; }
      updTier(); if (target1) runTab1();
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
    T2 = makeTable($('tb2'), cols2, 'ptot', -1);
    autocomplete($('q2'), $('ac2'), () => BASEOPTS, (x) => {
      base2 = x;
      const q = $('ql2');
      refreshStats();
      $('conds').innerHTML = ''; addCond();
    });
    $('ql2').addEventListener('change', () => { refreshStats(); });
    $('addcond').onclick = () => addCond();
    $('go2').onclick = runTab2;
    // about
    $('about').innerHTML = aboutHtml();
    // optional deep links for smoke tests: ?q1=Griffon   or   ?q2=circlet&ql=magic&c=Faster%20Cast%20Rate:20
    const qs = new URLSearchParams(location.search);
    if (qs.get('q1')) {
      const w = qs.get('q1').toLowerCase();
      target1 = INDEX.find((x) => x.label.toLowerCase().indexOf(w) >= 0);
      if (target1) { $('q1').value = target1.label; runTab1(); }
    }
    if (qs.get('q2')) {
      const w = qs.get('q2').toLowerCase();
      base2 = BASEOPTS.find((x) => x.label.toLowerCase().indexOf(w) >= 0);
      if (base2) {
        $('q2').value = base2.label; if (qs.get('ql')) $('ql2').value = qs.get('ql');
        refreshStats(); $('conds').innerHTML = '';
        for (const c of qs.getAll('c')) { const i = c.lastIndexOf(':'); addCond(c.slice(0, i), parseFloat(c.slice(i + 1))); }
        document.getElementById('t2').click();
        runTab2();
      }
    }
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
