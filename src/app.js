'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const CFG = require('./config');
const csv = require('./csv');
const D = require('./dictionary');
const T = require('./transform');
const redcap = require('./redcap');
const { Store, atomicWrite } = require('./store');
const { Auth } = require('./auth');
const { Syncer } = require('./sync');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
};

function createApp(overrides) {
  const cfg = CFG.load(overrides);
  const store = new Store(cfg); store.init();
  const auth = new Auth(cfg);
  const publicDir = path.join(cfg.root, 'public');

  /* ---- dictionary: a copy uploaded or fetched earlier wins over the file shipped with the app ---- */
  const dictDir = path.join(cfg.storage.abs, 'dictionary'), dictCurrent = path.join(dictDir, 'current.csv');
  let model = D.load(fs.existsSync(dictCurrent) ? dictCurrent : cfg.dictionary.abs);
  model.source = fs.existsSync(dictCurrent) ? 'uploaded copy (data/dictionary/current.csv)' : path.relative(cfg.root, cfg.dictionary.abs);
  const setModel = m => { model = m; model.source = model.source || 'REDCap API metadata'; if (m.source === undefined) m.source = 'REDCap API metadata'; };
  const sync = new Syncer({ cfg, store, getModel: () => model, setModel: m => { m.source = 'REDCap API metadata (live)'; model = m; } });

  /* ---- server-sent events: tell open dashboards that new data is available ---- */
  const clients = new Set();
  store.onChange(ev => { const msg = 'event: data\ndata: ' + JSON.stringify(ev) + '\n\n'; clients.forEach(res => { try { res.write(msg); } catch (e) { clients.delete(res); } }); });
  const beat = setInterval(() => clients.forEach(res => { try { res.write(': keep-alive\n\n'); } catch (e) { clients.delete(res); } }), 25000); beat.unref();

  const send = (res, status, body, headers) => {
    const h = Object.assign({}, SEC, headers || {});
    if (typeof body === 'object' && !Buffer.isBuffer(body)) { body = JSON.stringify(body, null, 0); h['content-type'] = 'application/json; charset=utf-8'; h['cache-control'] = h['cache-control'] || 'no-store'; }
    res.writeHead(status, h); res.end(body);
  };
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
  const admin = (req, res) => { const a = auth.isAdmin(req); if (!a.ok) { send(res, a.status, { error: a.error }); return false; } return true; };
  const origin = req => 'http://' + (req.headers.host || 'localhost');

  function status() {
    const cur = store.list().find(s => s.active) || null, p = store.payload('auto');
    return {
      app: 'adhmat-platform', time: new Date().toISOString(),
      data: { serving: p && p.meta.source, preferred: store.state.preferred, liveAvailable: !!cur, current: cur && { id: cur.id, createdAt: cur.createdAt, source: cur.source, recordsUsed: cur.recordsUsed, completeM1: cur.completeM1, completeBoth: cur.completeBoth } },
      sync: sync.summary(), redcap: CFG.publicView(cfg),
      dictionary: { file: model.source, sha256: model.sha256.slice(0, 12), questions: model.questions.length, countries: model.countries.length, structuredModule2: model.structuredModule2, warnings: model.warnings.length }
    };
  }

  function ingestText(text, name, dry) {
    let records;
    const t = text.trim();
    if (t[0] === '[') { try { records = JSON.parse(t); } catch (e) { return { status: 400, body: { ok: false, error: 'The JSON could not be read: ' + e.message } }; } }
    else {
      const parsed = csv.parseObjects(text); records = parsed.records;
      if (parsed.headers.length && !parsed.headers.some(h => model.fields[h])) return { status: 400, body: { ok: false, error: 'None of the column names match fields in the ADHMAT dictionary. Export the data as "CSV / Microsoft Excel (raw data)" from REDCap, not with labels.' } };
    }
    const out = T.buildDatasets(records, model);
    if (!out.report.ok || dry) return { status: out.report.ok ? 200 : 422, body: { ok: out.report.ok, dryRun: !!dry, report: out.report } };
    const file = store.archiveImport(name || 'upload.csv', text);
    const snap = store.save(out.datasets, { source: 'upload', file, trigger: 'upload', recordsUsed: out.report.recordsUsed, completeM1: out.report.completeM1, completeBoth: out.report.completeBoth, warnings: out.report.warnings.length, dictionary: model.sha256.slice(0, 12) });
    store.log({ type: 'upload', ok: true, file, records: out.report.recordsUsed, completeM1: out.report.completeM1, completeBoth: out.report.completeBoth, warningCount: out.report.warnings.length, snapshot: snap.id });
    return { status: 200, body: { ok: true, snapshot: snap, report: out.report } };
  }

  async function api(req, res, url) {
    const p = url.pathname, m = req.method;
    if (p === '/api/health') return send(res, 200, { ok: true, time: new Date().toISOString() });
    if (p === '/api/status' && m === 'GET') return send(res, 200, status());
    if (p === '/api/data' && m === 'GET') {
      const src = url.searchParams.get('source') || 'auto';
      if (['auto', 'live', 'test'].indexOf(src) < 0) return send(res, 400, { error: 'source must be auto, live or test' });
      const pl = store.payload(src);
      if (!pl) return send(res, 404, { error: 'No live data has been imported yet.', hint: 'Use ?source=test, run a sync, or upload a REDCap export on the Data page.' });
      const h = { etag: pl.etag, 'cache-control': 'no-cache', 'content-type': 'application/json; charset=utf-8', vary: 'accept-encoding' };
      if (req.headers['if-none-match'] === pl.etag) return send(res, 304, '', h);
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['content-encoding'] = 'gzip'; return send(res, 200, pl.gz, h); }
      return send(res, 200, pl.body, h);
    }
    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }, SEC));
      res.write('retry: 5000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (p === '/api/dictionary/summary') return send(res, 200, Object.assign({ source: model.source }, model.summary()));
    if (p === '/api/dictionary/questions') return send(res, 200, model.questions);
    if (p === '/api/dictionary/countries') return send(res, 200, model.countries);
    if (p === '/api/test/redcap-export.csv') {
      const recs = T.toRecords(store.testPayload() && JSON.parse(store.testPayload().body).datasets, model);
      const heads = model.exportFields.filter(f => recs.some(r => r[f] !== undefined));
      return send(res, 200, csv.stringify(heads, recs), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="ADHMAT_TEST_REDCap_export_2026-11-03.csv"' });
    }
    if (p === '/api/ingest' && m === 'POST') {
      if (!admin(req, res)) return;
      const text = await readBody(req, 40e6), r = ingestText(text, url.searchParams.get('name'), url.searchParams.get('dry') === '1');
      return send(res, r.status, r.body);
    }
    if (p === '/api/sync' && m === 'POST') { if (!admin(req, res)) return; const r = await sync.run('manual'); return send(res, r.ok ? 200 : (r.skipped ? 409 : 502), r); }
    if (p === '/api/sync/history' && m === 'GET') { if (!admin(req, res)) return; return send(res, 200, store.history(Number(url.searchParams.get('n')) || 100)); }
    if (p === '/api/snapshots' && m === 'GET') { if (!admin(req, res)) return; return send(res, 200, store.list()); }
    const act = /^\/api\/snapshots\/([^/]+)\/activate$/.exec(p);
    if (act && m === 'POST') { if (!admin(req, res)) return; const ok = store.activate(act[1]); if (ok) store.log({ type: 'activate', ok: true, snapshot: act[1] }); return send(res, ok ? 200 : 404, { ok }); }
    if (p === '/api/source' && m === 'POST') {
      if (!admin(req, res)) return; const b = JSON.parse((await readBody(req, 4096)) || '{}');
      if (['auto', 'live', 'test'].indexOf(b.preferred) < 0) return send(res, 400, { error: 'preferred must be auto, live or test' });
      store.setPreferred(b.preferred); return send(res, 200, { ok: true, preferred: b.preferred });
    }
    if (p === '/api/admin/info' && m === 'GET') {
      if (!admin(req, res)) return;
      return send(res, 200, { webhookUrl: origin(req) + '/api/webhook/redcap?key=' + auth.hook.value, config: CFG.publicView(cfg), dataDir: cfg.storage.abs, host: cfg.server.host, port: cfg.server.port, dictionaryWarnings: model.warnings });
    }
    if (p === '/api/admin/redcap-test' && m === 'POST') {
      if (!admin(req, res)) return;
      try { const v = await redcap.version(cfg); let pr = null; try { pr = await redcap.project(cfg); } catch (e) { /* project export may be restricted */ } return send(res, 200, { ok: true, redcapVersion: v, project: pr && { id: pr.project_id, title: pr.project_title, records: undefined } }); }
      catch (e) { return send(res, 502, { ok: false, error: e.message }); }
    }
    if (p === '/api/dictionary' && m === 'POST') {
      if (!admin(req, res)) return;
      const text = await readBody(req, 20e6), dry = url.searchParams.get('dry') === '1';
      let fresh; try { fresh = D.load(Buffer.from(text, 'utf8')); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      const sum = fresh.summary(), d = D.diff(model, fresh);
      if (fresh.errors.length) return send(res, 422, { ok: false, summary: sum, errors: fresh.errors });
      if (!dry) { atomicWrite(dictCurrent, text); fresh.source = 'uploaded copy (data/dictionary/current.csv)'; model = fresh; store.log({ type: 'dictionary', ok: true, questions: fresh.questions.length, added: d.added.length, removed: d.removed.length }); }
      return send(res, 200, { ok: true, dryRun: dry, summary: sum, diff: { added: d.added.slice(0, 50), removed: d.removed.slice(0, 50), changedChoices: d.changedChoices } });
    }
    if (p === '/api/webhook/redcap' && m === 'POST') {
      if (!auth.isHook(req, url)) return send(res, 401, { error: 'Bad or missing webhook key.' });
      const body = await readBody(req, 100e3), info = {}; new URLSearchParams(body).forEach((v, k) => { info[k] = v; });
      if (cfg.redcap.projectId && info.project_id && String(info.project_id) !== String(cfg.redcap.projectId)) return send(res, 200, { ignored: 'different project' });
      return send(res, 200, sync.trigger(info));
    }
    return send(res, 404, { error: 'Unknown API route.' });
  }

  function serveStatic(req, res, url) {
    let p; try { p = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'Bad request'); }
    if (p.indexOf('\0') >= 0) return send(res, 400, 'Bad request');
    if (p.endsWith('/')) p += 'index.html';
    let f = path.join(publicDir, p);
    if (!f.startsWith(publicDir + path.sep) && f !== publicDir) return send(res, 403, 'Forbidden');
    if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { const nf = path.join(publicDir, '404.html'); return send(res, 404, fs.existsSync(nf) ? fs.readFileSync(nf) : 'Not found', { 'content-type': MIME['.html'] }); }
    const ext = path.extname(f).toLowerCase(), st = fs.statSync(f), etag = '"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
    const h = { 'content-type': MIME[ext] || 'application/octet-stream', etag, 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' };
    if (req.headers['if-none-match'] === etag) return send(res, 304, '', h);
    let data = fs.readFileSync(f);
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && /^\.(html|css|js|json|svg|csv|txt)$/.test(ext) && data.length > 1024) { data = zlib.gzipSync(data); h['content-encoding'] = 'gzip'; h.vary = 'accept-encoding'; }
    return send(res, 200, req.method === 'HEAD' ? '' : data, h);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url);
    } catch (e) {
      const st = e.status || 500; if (st === 500) console.error('[error]', e);
      if (!res.headersSent) send(res, st, { error: st === 500 ? 'Internal error' : e.message });
    }
  });

  function start() {
    return new Promise(resolve => {
      server.listen(cfg.server.port, cfg.server.host, () => {
        const addr = server.address(); cfg.server.port = addr.port; sync.start(); resolve(addr);
      });
    });
  }
  function stop() { sync.stop(); clearInterval(beat); clients.forEach(r => { try { r.end(); } catch (e) { /* */ } }); return new Promise(r => server.close(() => r())); }
  return { cfg, server, store, auth, sync, start, stop, get model() { return model; }, setModel };
}
module.exports = { createApp };
