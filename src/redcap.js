'use strict';
/* Thin REDCap API client (Node 18+ fetch). Token comes from the environment, never from files in the repository. */
class RedcapError extends Error { constructor(msg, status, detail) { super(msg); this.status = status; this.detail = detail; } }

async function call(cfg, params, opts) {
  opts = opts || {};
  if (!cfg.redcap.url) throw new RedcapError('REDCap API URL is not configured (REDCAP_API_URL).');
  if (!cfg.secrets.redcapToken) throw new RedcapError('REDCap API token is not configured (REDCAP_API_TOKEN).');
  const body = new URLSearchParams(); body.append('token', cfg.secrets.redcapToken); body.append('format', 'json'); body.append('returnFormat', 'json');
  Object.keys(params).forEach(k => {
    const v = params[k];
    if (Array.isArray(v)) v.forEach((x, i) => body.append(k + '[' + i + ']', x)); else if (v !== undefined && v !== null && v !== '') body.append(k, v);
  });
  const tries = (opts.retries !== undefined ? opts.retries : cfg.redcap.retries) + 1; let last;
  for (let a = 1; a <= tries; a++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), cfg.redcap.timeoutMs);
    try {
      const res = await fetch(cfg.redcap.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: ctl.signal });
      const text = await res.text(); clearTimeout(timer);
      let json; try { json = JSON.parse(text); } catch (e) { json = null; }
      if (!res.ok) {
        const msg = json && json.error ? json.error : text.slice(0, 200);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new RedcapError('REDCap refused the request (' + res.status + '): ' + msg, res.status);
        throw new RedcapError('REDCap error ' + res.status + ': ' + msg, res.status);
      }
      if (json === null && opts.text) return text.trim();
      if (json === null) throw new RedcapError('REDCap returned something that is not JSON. Check the API URL.', res.status, text.slice(0, 120));
      return json;
    } catch (e) {
      clearTimeout(timer); last = e.name === 'AbortError' ? new RedcapError('REDCap did not answer within ' + cfg.redcap.timeoutMs / 1000 + ' s.') : e;
      if (last instanceof RedcapError && last.status && last.status >= 400 && last.status < 500 && last.status !== 429) throw last;
      if (a < tries) await new Promise(r => setTimeout(r, Math.min(15000, 1000 * 2 ** (a - 1))));
    }
  }
  throw last;
}

const version = cfg => call(cfg, { content: 'version' }, { retries: 0, text: true });
const project = cfg => call(cfg, { content: 'project' }, { retries: 0 });
const metadata = cfg => call(cfg, { content: 'metadata' });

/* Records are fetched in batches of record ids so one slow export cannot time out the whole sync. */
async function exportRecords(cfg, fields, opt) {
  opt = opt || {};
  const base = { content: 'record', type: 'flat', rawOrLabel: 'raw', rawOrLabelHeaders: 'raw', exportCheckboxLabel: 'false', exportSurveyFields: 'false', exportDataAccessGroups: 'false' };
  const filter = opt.filterLogic !== undefined ? opt.filterLogic : cfg.redcap.filterLogic;
  const idRows = await call(cfg, Object.assign({}, base, { fields: ['record_id'], filterLogic: filter }));
  const ids = Array.from(new Set(idRows.map(r => r.record_id))).filter(x => x !== undefined && x !== '');
  const size = Math.max(1, cfg.redcap.batchSize || 100), out = [];
  for (let i = 0; i < ids.length; i += size) {
    const part = await call(cfg, Object.assign({}, base, { fields, records: ids.slice(i, i + size) }));
    part.forEach(r => out.push(r));
  }
  return { records: out, ids: ids.length };
}

module.exports = { call, version, project, metadata, exportRecords, RedcapError };
