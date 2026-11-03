'use strict';
/* The REDCap -> dashboard pipeline, exercised against a mock REDCap API built from the same dictionary. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, sleep } = require('./helpers');
const { createMock } = require('../scripts/mock-redcap');

async function rig(opts) {
  const mock = createMock({ visible: (opts && opts.visible) || 20 }), port = await mock.listen(0);
  const s = await startApp({ redcap: { url: 'http://127.0.0.1:' + port + '/api/', retries: 0, timeoutMs: 5000, batchSize: 7 } });
  s.app.cfg.secrets.redcapToken = mock.token;
  const ctl = body => fetch('http://127.0.0.1:' + port + '/__control', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
  const live = async () => (await s.get('/api/data?source=live')).json();
  return { s, mock, ctl, live, stop: async () => { await s.stop(); await mock.close(); } };
}

test('first sync pulls records in batches and publishes a live snapshot', async () => {
  const r = await rig();
  try {
    const out = await r.s.app.sync.run('manual');
    assert.equal(out.ok, true); assert.equal(out.changed, true); assert.equal(out.entry.records, 20);
    assert.ok(out.entry.steps.some(x => x.step === 'dictionary' && /matches/.test(x.note)));
    const exp = out.entry.steps.find(x => x.step === 'export'); assert.match(exp.note, /20 record/); assert.match(exp.note, /no personal contact fields/);
    const d = await r.live(); assert.equal(d.meta.source, 'live'); assert.equal(d.meta.recordsUsed, 20); assert.equal(d.datasets.countries.length, 55);
    assert.equal(d.datasets.countries.filter(c => c.overall !== null).length > 10, true);
    assert.equal((await r.s.get('/api/data')).headers.get('etag') !== null, true);
    assert.equal((await (await r.s.get('/api/data')).json()).meta.source, 'live', 'auto now prefers live data');
    const st = await (await r.s.get('/api/status')).json(); assert.ok(st.sync.lastSuccess); assert.equal(st.data.liveAvailable, true);
  } finally { await r.stop(); }
});

test('an unchanged project creates no new snapshot; changes and new records do', async () => {
  const r = await rig();
  try {
    await r.s.app.sync.run('manual');
    const again = await r.s.app.sync.run('manual'); assert.equal(again.ok, true); assert.equal(again.changed, false);
    assert.equal((await (await r.s.aGet('/api/snapshots')).json()).length, 1);
    const before = (await r.live()).datasets.countries.find(c => c.iso3 === 'DZA').overall;
    await r.ctl({ set: { record: 1, field: 'q_a1_1', value: '0' } });
    await sleep(1100);
    const ch = await r.s.app.sync.run('schedule'); assert.equal(ch.changed, true);
    const after = (await r.live()).datasets.countries.find(c => c.iso3 === 'DZA').overall; assert.notEqual(after, before);
    await r.ctl({ visible: 40 }); await sleep(1100);
    const more = await r.s.app.sync.run('schedule'); assert.equal(more.entry.records, 40);
    assert.equal((await r.live()).meta.recordsUsed, 40);
    const hist = await (await r.s.aGet('/api/sync/history')).json(); assert.equal(hist.length, 4); assert.equal(hist[0].reason, 'schedule');
  } finally { await r.stop(); }
});

test('failures keep serving the last good data and say why', async () => {
  const r = await rig();
  try {
    await r.s.app.sync.run('manual');
    const etag = (await r.s.get('/api/data?source=live')).headers.get('etag');
    await r.ctl({ token: 'WRONGTOKEN' });
    const bad = await r.s.app.sync.run('schedule'); assert.equal(bad.ok, false); assert.match(bad.error, /refused|permission/i);
    await r.ctl({ token: r.mock.token, fail: 503 });
    const down = await r.s.app.sync.run('schedule'); assert.equal(down.ok, false); assert.match(down.error, /503/);
    assert.equal((await r.s.get('/api/data?source=live')).headers.get('etag'), etag, 'data unchanged after failed syncs');
    const st = await (await r.s.get('/api/status')).json(); assert.ok(st.sync.lastError); assert.ok(st.sync.lastSuccess);
    await r.ctl({ fail: 0 }); assert.equal((await r.s.app.sync.run('manual')).ok, true);
    assert.equal((await r.s.get('/api/status').then(x => x.json())).sync.lastError, null);
  } finally { await r.stop(); }
});

test('not configured: sync explains what to set; nothing breaks', async () => {
  const s = await startApp();
  try {
    const r = await s.aPost('/api/sync'); assert.equal(r.status, 502); assert.match((await r.json()).error, /not configured/);
    assert.equal((await s.get('/api/data')).status, 200);
  } finally { await s.stop(); }
});

test('the form changing in REDCap is detected and the mapping rebuilds itself', async () => {
  const r = await rig();
  try {
    await r.ctl({ dropField: 'q_a1_1' });
    const out = await r.s.app.sync.run('manual'); assert.equal(out.ok, true);
    const d = out.entry.steps.find(x => x.step === 'dictionary'); assert.equal(d.changed, true); assert.deepEqual(d.removed, ['q_a1_1']);
    assert.equal(r.s.app.model.questions.length, 372);
    assert.equal((await (await r.s.get('/api/data?source=live')).json()).datasets.questions.length, 372);
  } finally { await r.stop(); }
});

test('Data Entry Trigger: secret required, bursts collapse into one sync', async () => {
  const r = await rig();
  try {
    const bad = await r.s.post('/api/webhook/redcap?key=nope', 'project_id=123&record=1'); assert.equal(bad.status, 401);
    const info = await (await r.s.aGet('/api/admin/info')).json(); assert.match(info.webhookUrl, /\/api\/webhook\/redcap\?key=/);
    const url = info.webhookUrl; const before = r.mock.state.calls.length;
    const rs = await Promise.all([1, 2, 3, 4].map(i => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'project_id=123&instrument=adhmat&record=' + i })));
    rs.forEach(x => assert.equal(x.status, 200));
    await sleep(2500);
    const hist = await (await r.s.aGet('/api/sync/history')).json();
    assert.equal(hist.filter(h => h.type === 'webhook').length, 4); assert.equal(hist.filter(h => h.type === 'sync' && h.reason === 'webhook').length, 1);
    assert.equal((await r.live()).meta.recordsUsed, 20);
    assert.ok(r.mock.state.calls.length > before);
    r.s.app.cfg.redcap.projectId = '999';
    const ign = await (await fetch(url, { method: 'POST', body: 'project_id=123&record=1' })).json(); assert.ok(ign.ignored);
  } finally { await r.stop(); }
});

test('scheduler: runs on start and on the interval', async () => {
  const mock = createMock({ visible: 5 }), port = await mock.listen(0);
  const s = await startApp({ redcap: { url: 'http://127.0.0.1:' + port + '/api/', retries: 0 }, sync: { enabled: true, onStart: true, intervalMinutes: 0.02, webhookDebounceSeconds: 0.2 } });
  try {
    s.app.cfg.secrets.redcapToken = mock.token;
    await sleep(3500);
    const hist = await (await s.aGet('/api/sync/history')).json();
    assert.ok(hist.some(h => h.reason === 'startup' && h.ok), 'startup sync');
    const st = await (await s.get('/api/status')).json(); assert.equal(st.sync.enabled, true); assert.ok(st.sync.nextScheduled);
    assert.equal((await s.get('/api/data?source=live')).status, 200);
  } finally { await s.stop(); await mock.close(); }
});

test('admin: connection test against REDCap', async () => {
  const r = await rig();
  try {
    const ok = await (await r.s.aPost('/api/admin/redcap-test')).json(); assert.equal(ok.ok, true); assert.equal(ok.redcapVersion, '14.5.0');
    await r.ctl({ token: 'nope' }); const bad = await r.s.aPost('/api/admin/redcap-test'); assert.equal(bad.status, 502);
  } finally { await r.stop(); }
});
