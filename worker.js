/* Web Worker: runs the affix search (exact for magic, Monte Carlo for rare) off the UI thread. */
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
    if (m.type === 'search') {
      const ctx = E.getCtx(m.ctx);
      const res = E.affixSearch(ctx, m.opts, (done, total) => self.postMessage({ type: 'progress', done, total, id: m.id }));
      // strip heavy objects: keep serialisable row summaries
      const rows = res.rows.map((r) => ({ src: r.src, pBase: r.pBase, pQual: r.pQual, pAff: r.pAff, pTotal: r.pTotal, perRun: r.perRun, alvl: r.alvl }));
      self.postMessage({ type: 'result', id: m.id, rows, minLv: res.minLv, pools: res.pools });
    } else if (m.type === 'stats') {
      self.postMessage({ type: 'stats', id: m.id, stats: E.statList(m.codes, m.quality) });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String(e && e.stack || e) });
  }
};
