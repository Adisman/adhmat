'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const D = require('../src/dictionary');
const T = require('../src/transform');
const ROOT = path.resolve(__dirname, '..');
const DICT = path.join(ROOT, 'dictionary', 'AfricaDigitalHealthMaturityAss_DataDictionary_2026-11-03.csv');
const testDatasets = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'test', 'test-datasets.json'), 'utf8')).datasets;
const model = () => D.load(DICT);
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'adhmat-test-')); }
async function startApp(extra) {
  const dir = tmp();
  const app = createApp(Object.assign({ server: { host: '127.0.0.1', port: 0 }, sync: { enabled: false, webhookDebounceSeconds: 0.2 }, storage: { dir, keepSnapshots: 5 } }, extra || {}));
  const addr = await app.start();
  const base = 'http://127.0.0.1:' + addr.port;
  const adminKey = app.auth.admin.value;
  const get = (p, h) => fetch(base + p, { headers: h });
  const post = (p, body, h) => fetch(base + p, { method: 'POST', body, headers: h });
  const aPost = (p, body, h) => post(p, body, Object.assign({ 'x-admin-key': adminKey }, h || {}));
  const aGet = p => get(p, { 'x-admin-key': adminKey });
  return { app, base, adminKey, get, post, aPost, aGet, dir, stop: () => app.stop() };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { ROOT, DICT, testDatasets, model, startApp, sleep, D, T };
