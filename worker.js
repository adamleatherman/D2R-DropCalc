/* Web Worker: runs the item builder's heavy parts (farm search, affix appearance table; exact for magic, Monte Carlo for rare) off the UI thread. */
importScripts('engine.js');
const engines = {};   // one engine per data file (data.json = RotW, data-lod.json = LoD), loaded on first use

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
      self.postMessage({ type: 'result', id: m.id, rows: E.builderAffixTable(m.codes, m.ilvl, { rolls: m.rolls }) });
    } else if (m.type === 'stats') {
      self.postMessage({ type: 'stats', id: m.id, stats: E.statList(m.codes, m.quality) });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String(e && e.stack || e) });
  }
};
