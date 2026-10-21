/* Web Worker: runs the affix search (exact for magic, Monte Carlo for rare) off the UI thread. */
importScripts('engine.js');
let E = null;
let ready = null;

async function init() {
  const data = await (await fetch('data.json')).json();
  E = Engine.create(data);
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (!ready) ready = init();
    await ready;
    if (m.type === 'search') {
      if (m.mode) E.setMode(m.mode);
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
