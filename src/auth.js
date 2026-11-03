'use strict';
/* Admin key and webhook secret. Generated on first start when not supplied; compared in constant time; failed admin attempts are throttled per address. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite } = require('./store');

function secret(cfg, fixed, fileName) {
  if (fixed) return { value: fixed, generated: false };
  const f = path.join(cfg.storage.abs, fileName);
  if (fs.existsSync(f)) return { value: fs.readFileSync(f, 'utf8').trim(), generated: false };
  const v = crypto.randomBytes(24).toString('base64url'); atomicWrite(f, v + '\n'); try { fs.chmodSync(f, 0o600); } catch (e) { /* windows */ }
  return { value: v, generated: true };
}
function same(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

class Auth {
  constructor(cfg) {
    this.admin = secret(cfg, cfg.secrets.adminKey, 'admin.key'); this.hook = secret(cfg, cfg.secrets.webhookSecret, 'webhook.secret');
    this.fails = new Map();
  }
  throttled(ip) { const f = this.fails.get(ip); return !!f && f.n >= 8 && Date.now() - f.t < 60000; }
  noteFail(ip) { const f = this.fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 60000) f.n = 0; f.n++; f.t = Date.now(); this.fails.set(ip, f); }
  isAdmin(req) {
    const ip = req.socket.remoteAddress || '?';
    if (this.throttled(ip)) return { ok: false, status: 429, error: 'Too many failed attempts. Wait a minute.' };
    const h = req.headers['x-admin-key'] || (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1] || '';
    if (h && same(h, this.admin.value)) return { ok: true };
    if (h) this.noteFail(ip);
    return { ok: false, status: 401, error: 'Admin key required (X-Admin-Key header).' };
  }
  isHook(req, url) {
    const k = req.headers['x-webhook-secret'] || url.searchParams.get('key') || '';
    return !!k && same(k, this.hook.value);
  }
}
module.exports = { Auth };
