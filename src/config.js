'use strict';
/* Configuration: config/adhmat.config.json, overridden by .env and real environment variables. Secrets are never stored in the JSON file. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function readEnvFile(file) {
  const out = {}; if (!fs.existsSync(file)) return out;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (!m || line.trim().startsWith('#')) return;
    let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); out[m[1]] = v;
  });
  return out;
}
function deepMerge(a, b) { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] || {}, b[k]); else a[k] = b[k]; } return a; }

function load(overrides) {
  const defFile = path.join(ROOT, 'config', 'adhmat.config.json');
  let cfg = JSON.parse(fs.readFileSync(defFile, 'utf8'));
  const local = path.join(ROOT, 'config', 'local.config.json');
  if (fs.existsSync(local)) cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(local, 'utf8')));
  const env = Object.assign({}, readEnvFile(path.join(ROOT, '.env')), process.env);
  if (env.PORT) cfg.server.port = Number(env.PORT);
  if (env.HOST) cfg.server.host = env.HOST;
  if (env.REDCAP_API_URL) cfg.redcap.url = env.REDCAP_API_URL;
  if (env.SYNC_INTERVAL_MINUTES) cfg.sync.intervalMinutes = Number(env.SYNC_INTERVAL_MINUTES);
  if (env.SYNC_ENABLED) cfg.sync.enabled = /^(1|true|yes)$/i.test(env.SYNC_ENABLED);
  if (env.ADHMAT_DATA_DIR) cfg.storage.dir = env.ADHMAT_DATA_DIR;
  if (overrides) cfg = deepMerge(cfg, overrides);
  cfg.secrets = { redcapToken: env.REDCAP_API_TOKEN || '', adminKey: env.ADHMAT_ADMIN_KEY || '', webhookSecret: env.ADHMAT_WEBHOOK_SECRET || '' };
  cfg.root = ROOT;
  cfg.storage.abs = path.isAbsolute(cfg.storage.dir) ? cfg.storage.dir : path.join(ROOT, cfg.storage.dir);
  cfg.dictionary.abs = path.isAbsolute(cfg.dictionary.path) ? cfg.dictionary.path : path.join(ROOT, cfg.dictionary.path);
  return cfg;
}
/* What the browser may see: never tokens or keys. */
function publicView(cfg) {
  return {
    redcapConfigured: !!(cfg.redcap.url && cfg.secrets.redcapToken), redcapUrl: cfg.redcap.url ? cfg.redcap.url.replace(/\/\/([^/]+).*/, '//$1/…') : '',
    sync: { enabled: cfg.sync.enabled, intervalMinutes: cfg.sync.intervalMinutes, atTimes: cfg.sync.atTimes, onStart: cfg.sync.onStart },
    client: cfg.client
  };
}
module.exports = { load, publicView, ROOT };
