'use strict';
/* File-based storage: snapshots of imported datasets (gzip JSON), state, sync log. All writes are atomic (temp file + rename). */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const T = require('./transform');

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file);
}

class Store {
  constructor(cfg) {
    this.cfg = cfg; this.dir = cfg.storage.abs;
    this.snapDir = path.join(this.dir, 'snapshots'); this.importDir = path.join(this.dir, 'imports');
    this.stateFile = path.join(this.dir, 'state.json'); this.logFile = path.join(this.dir, 'sync-log.jsonl');
    this.testFile = path.join(cfg.root, 'data', 'test', 'test-datasets.json');
    this.state = { current: null, preferred: 'auto' };
    this.cache = {}; this.listeners = [];
  }
  init() {
    [this.dir, this.snapDir, this.importDir].forEach(d => fs.mkdirSync(d, { recursive: true }));
    if (fs.existsSync(this.stateFile)) { try { this.state = Object.assign(this.state, JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))); } catch (e) { /* keep defaults */ } }
    if (this.state.current && !fs.existsSync(this.snapPath(this.state.current))) this.state.current = null;
    if (!this.state.current) { const l = this.list(); if (l.length) this.state.current = l[0].id; }
  }
  snapPath(id) { return path.join(this.snapDir, id + '.json.gz'); }
  saveState() { atomicWrite(this.stateFile, JSON.stringify(this.state, null, 1)); }
  onChange(fn) { this.listeners.push(fn); }
  emit(ev) { this.listeners.forEach(f => { try { f(ev); } catch (e) { /* ignore */ } }); }

  /* ---- snapshots ---- */
  list() {
    if (!fs.existsSync(this.snapDir)) return [];
    return fs.readdirSync(this.snapDir).filter(f => f.endsWith('.json.gz')).map(f => {
      const id = f.slice(0, -8), mp = path.join(this.snapDir, id + '.meta.json'); let meta = {};
      try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (e) { /* no meta */ }
      return Object.assign({ id, bytes: fs.statSync(path.join(this.snapDir, f)).size, active: id === this.state.current }, meta);
    }).sort((a, b) => (a.id < b.id ? 1 : -1));
  }
  save(datasets, meta) {
    const hash = T.hashDatasets(datasets);
    const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + hash.slice(0, 6);
    const full = Object.assign({}, meta, { id, hash, createdAt: new Date().toISOString() });
    atomicWrite(this.snapPath(id), zlib.gzipSync(JSON.stringify({ meta: full, datasets }), { level: 6 }));
    atomicWrite(path.join(this.snapDir, id + '.meta.json'), JSON.stringify(full, null, 1));
    this.state.current = id; this.saveState(); this.cache = {};
    this.prune(); this.emit({ type: 'data', id, hash });
    return full;
  }
  get(id) {
    if (!/^[0-9TZ]{16}-[0-9a-f]{6}$/.test(id)) return null;
    const p = this.snapPath(id); if (!fs.existsSync(p)) return null;
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
  }
  activate(id) {
    if (!fs.existsSync(this.snapPath(id))) return false;
    this.state.current = id; this.saveState(); this.cache = {};
    this.emit({ type: 'data', id }); return true;
  }
  prune() {
    const keep = this.cfg.storage.keepSnapshots || 40, l = this.list();
    l.slice(keep).forEach(s => { if (s.id === this.state.current) return; [this.snapPath(s.id), path.join(this.snapDir, s.id + '.meta.json')].forEach(f => { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }); });
  }
  archiveImport(name, text) {
    const f = path.join(this.importDir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60));
    atomicWrite(f, text); return path.basename(f);
  }

  /* ---- what the dashboard reads ---- */
  testPayload() {
    if (this.cache.test) return this.cache.test;
    const j = JSON.parse(fs.readFileSync(this.testFile, 'utf8'));
    const meta = { source: 'test', test: true, id: 'test', label: 'Test data', generatedAt: j.meta && j.meta.generatedAt || null, note: 'Generated test data for all 55 Member States. Not real assessment results.' };
    return (this.cache.test = this.pack(meta, j.datasets));
  }
  livePayload() {
    if (!this.state.current) return null;
    if (this.cache.live && this.cache.live.id === this.state.current) return this.cache.live;
    const s = this.get(this.state.current); if (!s) return null;
    const meta = Object.assign({}, s.meta, { source: 'live', test: false, label: 'REDCap data', generatedAt: s.meta.createdAt });
    this.cache.live = this.pack(meta, s.datasets); this.cache.live.id = this.state.current; return this.cache.live;
  }
  /* source: 'live' | 'test' | 'auto' (live when a snapshot exists, otherwise test) */
  payload(source) {
    const pref = source && source !== 'auto' ? source : (this.state.preferred && this.state.preferred !== 'auto' ? this.state.preferred : 'auto');
    if (pref === 'test') return this.testPayload();
    const live = this.livePayload();
    if (pref === 'live') return live;
    return live || this.testPayload();
  }
  pack(meta, datasets) {
    const body = JSON.stringify({ meta, datasets });
    const etag = '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 20) + '"';
    return { meta, body: Buffer.from(body), gz: zlib.gzipSync(body, { level: 6 }), etag };
  }

  /* ---- sync log ---- */
  log(entry) {
    entry = Object.assign({ at: new Date().toISOString() }, entry);
    fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    try { // keep the log bounded
      const st = fs.statSync(this.logFile);
      if (st.size > 1.5e6) { const lines = fs.readFileSync(this.logFile, 'utf8').trim().split('\n'); atomicWrite(this.logFile, lines.slice(-800).join('\n') + '\n'); }
    } catch (e) { /* ignore */ }
    return entry;
  }
  history(n) {
    if (!fs.existsSync(this.logFile)) return [];
    return fs.readFileSync(this.logFile, 'utf8').trim().split('\n').filter(Boolean).slice(-(n || 100)).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
  }
  setPreferred(p) { this.state.preferred = p; this.saveState(); this.cache = {}; this.emit({ type: 'data', id: 'preferred' }); }
}
module.exports = { Store, atomicWrite };
