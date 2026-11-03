'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startApp, testDatasets, model, T, sleep } = require('./helpers');
const csv = require('../src/csv');

function exportCsv(n) {
  const m = model(), recs = T.toRecords(testDatasets(), m).slice(0, n || 55);
  return csv.stringify(m.exportFields.filter(f => recs.some(r => r[f] !== undefined)), recs);
}

test('API: health, status, test data, ETag, gzip, source validation', async () => {
  const s = await startApp();
  try {
    assert.equal((await s.get('/api/health')).status, 200);
    const st = await (await s.get('/api/status')).json();
    assert.equal(st.data.serving, 'test'); assert.equal(st.data.liveAvailable, false); assert.equal(st.dictionary.questions, 373); assert.equal(st.redcap.redcapConfigured, false);
    assert.ok(!JSON.stringify(st).includes(s.adminKey), 'status must not leak the admin key');
    const r = await s.get('/api/data'); assert.equal(r.status, 200);
    const j = await r.json(); assert.equal(j.meta.test, true); assert.equal(j.datasets.countries.length, 55); assert.equal(j.datasets.answers.length, 18589);
    const et = r.headers.get('etag'); assert.ok(et);
    assert.equal((await s.get('/api/data', { 'if-none-match': et })).status, 304);
    assert.equal((await s.get('/api/data?source=live')).status, 404);
    assert.equal((await s.get('/api/data?source=nope')).status, 400);
  } finally { await s.stop(); }
});

test('API: admin routes need the key; wrong keys are throttled', async () => {
  const s = await startApp();
  try {
    for (const [m, p] of [['POST', '/api/ingest'], ['POST', '/api/sync'], ['GET', '/api/snapshots'], ['GET', '/api/sync/history'], ['GET', '/api/admin/info'], ['POST', '/api/dictionary'], ['POST', '/api/source']]) {
      const r = await fetch(s.base + p, { method: m, body: m === 'POST' ? 'x' : undefined }); assert.equal(r.status, 401, m + ' ' + p);
    }
    let last; for (let i = 0; i < 10; i++) last = await s.get('/api/snapshots', { 'x-admin-key': 'wrong' + i });
    assert.equal(last.status, 429);
    assert.equal((await s.aGet('/api/snapshots')).status, 429, 'still throttled for the same address, even with the right key');
  } finally { await s.stop(); }
});

test('upload: validate (dry run), import, switch to live, snapshots, activate, persistence', async () => {
  const s = await startApp();
  try {
    const text = exportCsv(30);
    const dry = await (await s.aPost('/api/ingest?dry=1', text)).json();
    assert.equal(dry.ok, true); assert.equal(dry.dryRun, true); assert.equal(dry.report.recordsUsed, 30);
    assert.equal((await s.get('/api/data?source=live')).status, 404, 'dry run must not store anything');
    const imp = await (await s.aPost('/api/ingest?name=first.csv', text)).json();
    assert.equal(imp.ok, true); assert.ok(imp.snapshot.id);
    const live = await (await s.get('/api/data')).json();
    assert.equal(live.meta.source, 'live'); assert.equal(live.meta.test, false);
    assert.equal(live.meta.recordsUsed, 30);
    assert.ok(live.datasets.module2.filter(m => m.consent).length > 15, 'consent choices are read from the dictionary');
    assert.equal((await (await s.get('/api/data?source=test')).json()).meta.test, true);
    await sleep(1100);
    const imp2 = await (await s.aPost('/api/ingest?name=second.csv', exportCsv(55))).json();
    const list = await (await s.aGet('/api/snapshots')).json();
    assert.equal(list.length, 2); assert.equal(list[0].id, imp2.snapshot.id); assert.equal(list[0].active, true);
    assert.equal((await s.aPost('/api/snapshots/' + imp.snapshot.id + '/activate')).status, 200);
    assert.equal((await (await s.get('/api/data')).json()).meta.recordsUsed, 30);
    assert.equal((await s.aPost('/api/snapshots/20200101T000000Z-abcdef/activate')).status, 404);
    assert.equal((await s.aPost('/api/snapshots/..%2f..%2fx/activate')).status, 404);
    assert.ok(fs.readdirSync(s.dir + '/imports').length === 2, 'raw uploads are archived');
    // preferred source is a server-wide setting changed by admins only
    assert.equal((await s.aPost('/api/source', JSON.stringify({ preferred: 'test' }))).status, 200);
    assert.equal((await (await s.get('/api/data')).json()).meta.test, true);
    assert.equal((await s.aPost('/api/source', JSON.stringify({ preferred: 'bogus' }))).status, 400);
    // restart: state is kept on disk
    const dir = s.dir, app2 = require('../src/app').createApp({ server: { host: '127.0.0.1', port: 0 }, sync: { enabled: false }, storage: { dir } });
    assert.equal(app2.store.list().length, 2); assert.equal(app2.store.state.current, imp.snapshot.id);
  } finally { await s.stop(); }
});

test('upload: bad input is explained, not stored', async () => {
  const s = await startApp();
  try {
    let r = await s.aPost('/api/ingest', 'foo,bar\n1,2\n'); assert.equal(r.status, 400); assert.match((await r.json()).error, /None of the column names match/);
    r = await s.aPost('/api/ingest', '[not json'); assert.equal(r.status, 400);
    const m = model(); r = await s.aPost('/api/ingest', 'record_id,country,' + m.questions.slice(0, 5).map(q => q.q).join(',') + '\n1,53,1,1,1,1,1\n');
    assert.equal(r.status, 422); assert.match((await r.json()).report.errors[0], /question columns/);
    assert.equal((await s.get('/api/data?source=live')).status, 404);
    const big = await fetch(s.base + '/api/ingest', { method: 'POST', headers: { 'x-admin-key': s.adminKey }, body: 'x'.repeat(41e6) }).catch(e => ({ status: 'aborted' }));
    assert.ok(big.status === 413 || big.status === 'aborted');
  } finally { await s.stop(); }
});

test('test export from the server validates cleanly against the same dictionary', async () => {
  const s = await startApp();
  try {
    const r = await s.get('/api/test/redcap-export.csv'); assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /attachment/);
    const text = await r.text(); assert.ok(!/@|focal_person/.test(text.split('\n')[0]), 'no personal fields in the template');
    const dry = await (await s.aPost('/api/ingest?dry=1', text)).json(); assert.equal(dry.ok, true); assert.equal(dry.report.recordsUsed, 55); assert.deepEqual(dry.report.warnings, []);
  } finally { await s.stop(); }
});

test('dictionary upload: validate, adopt, and reject non-ADHMAT dictionaries', async () => {
  const s = await startApp();
  try {
    const text = fs.readFileSync(require('./helpers').DICT, 'utf8');
    const dry = await (await s.aPost('/api/dictionary?dry=1', text)).json(); assert.equal(dry.ok, true); assert.equal(dry.summary.questions, 373); assert.equal(dry.diff.added.length, 0);
    const lines = text.split('\n').filter(l => !/^q_a1_1,/.test(l));
    const dropped = await (await s.aPost('/api/dictionary?dry=1', lines.join('\n'))).json(); assert.equal(dropped.summary.questions, 372); assert.deepEqual(dropped.diff.removed, ['q_a1_1']);
    const bad = await s.aPost('/api/dictionary', 'Variable / Field Name,Field Type,Field Label,"Choices, Calculations, OR Slider Labels"\nfoo,text,Foo,\n');
    assert.equal(bad.status, 422);
    assert.equal(s.app.model.questions.length, 373, 'a rejected dictionary must not replace the loaded one');
    assert.equal((await s.aPost('/api/dictionary', text)).status, 200);
    assert.ok(fs.existsSync(s.dir + '/dictionary/current.csv'));
  } finally { await s.stop(); }
});

test('security: static files cannot escape the public folder; unknown routes; methods', async () => {
  const s = await startApp();
  try {
    for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/.env.example', '/..%2fserver.js', '/dashboard/..%2f..%2fconfig%2fadhmat.config.json']) {
      const r = await s.get(p); assert.ok([403, 404].includes(r.status), p + ' -> ' + r.status); assert.ok(!(await r.text()).includes('"name": "adhmat-platform"'));
    }
    assert.equal((await s.get('/%00')).status, 400);
    assert.equal((await s.get('/api/nope')).status, 404);
    assert.equal((await fetch(s.base + '/index.html', { method: 'POST' })).status, 405);
    const h = (await s.get('/api/health')).headers; assert.equal(h.get('x-content-type-options'), 'nosniff'); assert.match(h.get('content-security-policy'), /default-src 'self'/);
    for (const p of ['/data/', '/data/test/test-datasets.json', '/src/app.js', '/dictionary/']) assert.equal((await s.get(p)).status, 404, p);
  } finally { await s.stop(); }
});

test('server-sent events: open dashboards are told when data changes', async () => {
  const s = await startApp();
  try {
    const ctl = new AbortController(), res = await fetch(s.base + '/api/events', { signal: ctl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader(); let seen = '';
    const got = (async () => { const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) return; seen += dec.decode(value); if (/event: data/.test(seen)) return; } })();
    await sleep(100); await s.aPost('/api/ingest', exportCsv(10));
    await Promise.race([got, sleep(3000)]); ctl.abort();
    assert.match(seen, /event: data/);
  } finally { await s.stop(); }
});
