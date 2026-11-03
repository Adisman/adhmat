'use strict';
/* The pipeline: REDCap API -> dictionary-driven transform -> snapshot -> dashboard.
 * Runs on a schedule (interval and/or fixed daily times), on demand, and when REDCap's Data Entry Trigger calls the webhook. */
const redcap = require('./redcap');
const D = require('./dictionary');
const T = require('./transform');

class Syncer {
  constructor(o) { Object.assign(this, o); this.running = false; this.timer = null; this.lastRun = null; this.lastOk = null; this.lastError = null; this.nextRun = null; this.pending = null; this.firedToday = {}; }

  summary() {
    return {
      running: this.running, lastRun: this.lastRun, lastSuccess: this.lastOk, lastError: this.lastError, nextScheduled: this.nextRun,
      enabled: this.cfg.sync.enabled, intervalMinutes: this.cfg.sync.intervalMinutes, atTimes: this.cfg.sync.atTimes,
      configured: !!(this.cfg.redcap.url && this.cfg.secrets.redcapToken)
    };
  }

  /* Re-read the form structure from REDCap; adopt it when it is valid and different, so new fields need no manual work. */
  async refreshDictionary(steps) {
    if (!this.cfg.sync.refreshDictionaryFromRedcap) return;
    const meta = await redcap.metadata(this.cfg);
    const fresh = D.load(D.metadataToCsv(meta));
    const cur = this.getModel();
    if (fresh.errors.length) { steps.push({ step: 'dictionary', ok: false, note: 'REDCap form could not be read as an ADHMAT form: ' + fresh.errors[0] + ' Keeping the loaded dictionary.' }); return; }
    if (fresh.signature === cur.signature) { steps.push({ step: 'dictionary', ok: true, note: 'REDCap form matches the loaded dictionary (' + fresh.questions.length + ' questions).' }); return; }
    const d = D.diff(cur, fresh);
    this.setModel(fresh);
    steps.push({ step: 'dictionary', ok: true, changed: true, note: 'REDCap form changed: ' + d.added.length + ' field(s) added, ' + d.removed.length + ' removed, ' + d.changedChoices.length + ' with changed choices. The mapping was rebuilt automatically (' + fresh.questions.length + ' questions).', added: d.added.slice(0, 30), removed: d.removed.slice(0, 30) });
  }

  async run(reason) {
    if (this.running) return { ok: false, skipped: true, error: 'A sync is already running.' };
    if (!this.cfg.redcap.url || !this.cfg.secrets.redcapToken) {
      const e = this.store.log({ type: 'sync', reason, ok: false, error: 'REDCap is not configured (set REDCAP_API_URL and REDCAP_API_TOKEN in .env).' });
      this.lastRun = e.at; this.lastError = e.error; return { ok: false, error: e.error };
    }
    this.running = true; const t0 = Date.now(), steps = []; this.lastRun = new Date().toISOString();
    try {
      await this.refreshDictionary(steps);
      const model = this.getModel();
      const got = await redcap.exportRecords(this.cfg, model.exportFields);
      steps.push({ step: 'export', ok: true, note: got.ids + ' record(s) exported, ' + model.exportFields.length + ' fields requested (no personal contact fields).' });
      const out = T.buildDatasets(got.records, model);
      if (!out.report.ok) throw new Error('The export could not be used: ' + out.report.errors.join(' '));
      const hash = T.hashDatasets(out.datasets), cur = this.store.list().find(s => s.active);
      let snapshot = null, changed = true;
      if (cur && cur.hash === hash) { changed = false; steps.push({ step: 'store', ok: true, note: 'No change since the last snapshot.' }); }
      else {
        snapshot = this.store.save(out.datasets, { source: 'redcap-api', trigger: reason, recordsUsed: out.report.recordsUsed, completeM1: out.report.completeM1, completeBoth: out.report.completeBoth, warnings: out.report.warnings.length, dictionary: model.sha256.slice(0, 12) });
        steps.push({ step: 'store', ok: true, note: 'Snapshot ' + snapshot.id + ' saved and published to the dashboard.' });
      }
      this.lastOk = new Date().toISOString(); this.lastError = null;
      const entry = this.store.log({ type: 'sync', reason, ok: true, changed, ms: Date.now() - t0, records: out.report.recordsUsed, completeM1: out.report.completeM1, completeBoth: out.report.completeBoth, warnings: out.report.warnings.slice(0, 20), warningCount: out.report.warnings.length, info: out.report.info, steps, snapshot: snapshot && snapshot.id });
      return { ok: true, changed, entry };
    } catch (e) {
      this.lastError = e.message;
      const entry = this.store.log({ type: 'sync', reason, ok: false, ms: Date.now() - t0, error: e.message, steps });
      return { ok: false, error: e.message, entry };
    } finally { this.running = false; this.computeNext(); }
  }

  /* Data Entry Trigger: many calls arrive in a burst while a form is saved, so wait and run once. */
  trigger(info) {
    const wait = (this.cfg.sync.webhookDebounceSeconds || 20) * 1000;
    this.store.log({ type: 'webhook', ok: true, project_id: info && info.project_id || null, record: info && info.record || null, instrument: info && info.instrument || null });
    if (this.pending) return { queued: true, already: true };
    this.pending = setTimeout(() => { this.pending = null; this.run('webhook'); }, wait);
    return { queued: true, inSeconds: wait / 1000 };
  }

  computeNext() {
    const s = this.cfg.sync; if (!s.enabled) { this.nextRun = null; return; }
    const c = []; const now = Date.now();
    if (s.intervalMinutes > 0) c.push((this.lastRun ? new Date(this.lastRun).getTime() : now) + s.intervalMinutes * 60000);
    (s.atTimes || []).forEach(t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); if (!m) return; const d = new Date(); d.setHours(+m[1], +m[2], 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1); c.push(d.getTime()); });
    this.nextRun = c.length ? new Date(Math.min.apply(null, c)).toISOString() : null;
  }
  start() {
    this.stop(); const s = this.cfg.sync; if (!s.enabled) return;
    if (s.onStart) setTimeout(() => this.run('startup'), 1500);
    this.computeNext();
    this.timer = setInterval(() => {
      const now = new Date();
      if (this.nextRun && now.getTime() >= new Date(this.nextRun).getTime() && !this.running) this.run('schedule');
      (s.atTimes || []).forEach(t => { const key = now.toDateString() + t; const m = /^(\d{1,2}):(\d{2})$/.exec(t); if (m && now.getHours() === +m[1] && now.getMinutes() === +m[2] && !this.firedToday[key]) { this.firedToday[key] = 1; this.run('schedule'); } });
    }, 15000);
    this.timer.unref && this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; if (this.pending) clearTimeout(this.pending); this.pending = null; }
}
module.exports = { Syncer };
