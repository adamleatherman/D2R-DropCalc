/* Web Worker: runs the item builder's heavy parts (farm search, affix appearance table; exact for magic, Monte Carlo for rare) off the UI thread. */
importScripts('engine.js');
const engines = {}, wcache = new Map();   // one engine per data file (data.json = RotW, data-lod.json = LoD), loaded on first use

async function engineFor(file) {
  file = file || 'data.json';
  if (!engines[file]) engines[file] = fetch(file).then((r) => r.json()).then((d) => Engine.create(d));
  return engines[file];
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    const E = await engineFor(m.file);
    if (m.type === 'farm') {
      // item builder: farm sources of a combination, one affix search per possible quality
      const ctx = E.getCtx(m.ctx), out = {};
      m.qualities.forEach((q, qi) => {
        const res = E.affixSearch(ctx, Object.assign({}, m.opts, { quality: q, prune: true, byBase: true }), (done, total) => self.postMessage({ type: 'progress', done: (qi + done / total) / m.qualities.length, total: 1, id: m.id }));
        // strip heavy objects: keep serialisable row summaries
        out[q] = res.rows.map((r) => ({ src: r.src, pBase: r.pBase, pQual: r.pQual, pAff: r.pAff, pTotal: r.pTotal, perRun: r.perRun, alvl: r.alvl, byBase: r.byBase }));
      });
      self.postMessage({ type: 'result', id: m.id, rows: out });
    } else if (m.type === 'table') {
      // plain average over the bases, or (an area chosen) weighted by how often each base drops there
      const w = m.wopts ? E.baseDropWeights(E.getCtx(m.ctx), m.codes, m.wopts) : null;
      const rows = E.builderAffixTable(m.codes, m.ilvl, { rolls: m.rolls, qualities: m.qualities, diff: m.diff, weights: w, rare: w ? m.codes.some((c) => w.get(c) > 0) : true });
      self.postMessage({ type: 'result', id: m.id, rows, wts: w ? m.codes.map((c) => w.get(c) || 0) : null });
    } else if (m.type === 'odds') {
      // item card odds: area weights are remembered, the rare samples stay in this engine's cache between requests
      let w = null;
      if (m.wopts) { const k = m.file + JSON.stringify([m.ctx, m.wopts, m.codes]); w = wcache.get(k); if (!w) { w = E.baseDropWeights(E.getCtx(m.ctx), m.codes, m.wopts); if (wcache.size > 20) wcache.clear(); wcache.set(k, w); } }
      const rows = E.cardOdds(m.codes, m.conds, m.ilvl, m.qualities, w, { diff: m.diff, groups: m.groups });
      rows.wts = w ? m.codes.map((c) => w.get(c) || 0) : null;
      self.postMessage({ type: 'result', id: m.id, rows });
    } else if (m.type === 'stats') {
      self.postMessage({ type: 'stats', id: m.id, stats: E.statList(m.codes, m.quality) });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String(e && e.stack || e) });
  }
};
