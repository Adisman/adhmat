'use strict';
/*
 * REDCap records -> dashboard datasets. Everything field-specific comes from the dictionary model
 * (src/dictionary.js); nothing here is mapped by hand.
 *
 * Scoring follows ADHMAT V2.5 exactly as the REDCap form calculates it (h_* and result_* fields):
 *   sub-domain % = Yes / (Yes + No) x 100   (N/A and blank are left out)
 *   domain %     = mean of the sub-domain %s that have at least one Yes/No answer
 *   overall %    = mean of domains A to E (Digital Payment Systems is supplementary and excluded)
 *   level        = thresholds read from the dictionary (L1 <40, L2 40-54.9, L3 55-69.9, L4 70-84.9, L5 >=85)
 */
const crypto = require('crypto');

const r1 = x => Math.round(x * 10) / 10;
const blank = v => v === undefined || v === null || String(v).trim() === '';
const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = v => { if (blank(v)) return null; const s = String(v).replace(/[\s,]/g, '').replace('%', ''); return isNaN(Number(s)) ? null : Number(s); };
const STATUS = /^(Complete|In progress|Not started)$/i;
const cap = s => { s = String(s).trim().toLowerCase(); return s === 'complete' ? 'Complete' : s === 'in progress' ? 'In progress' : 'Not started'; };

function levelOf(model, score) {
  if (score == null) return null;
  const r = Math.round(score * 1e6) / 1e6;
  return model.levels.find(l => r >= l.min) || model.levels[model.levels.length - 1];
}

function countryIndex(model) {
  const idx = { code: {}, iso3: {}, name: {} };
  model.countries.forEach(c => { if (!c.iso3) return; idx.code[c.code] = c; idx.iso3[c.iso3] = c; [c.redcap_name, c.name, c.iso3].forEach(n => { idx.name[norm(n)] = c; }); });
  return idx;
}
function resolveCountry(raw, idx) {
  if (blank(raw)) return null; const s = String(raw).trim();
  return idx.code[s] || idx.iso3[s.toUpperCase()] || idx.name[norm(s)] || null;
}
/* Accepts raw codes (1/0/2) or exported labels (Yes/No/N/A). */
function answerOf(v, code) {
  if (blank(v)) return null; const s = String(v).trim();
  if (s === code.yes || /^yes$/i.test(s)) return 1;
  if (s === code.no || /^no$/i.test(s)) return 0;
  if ((code.na !== null && s === code.na) || /^n\/?a$/i.test(s)) return 2;
  return undefined; // present but not a valid answer
}
function choiceLabel(map, v) {
  if (blank(v)) return null; const s = String(v).trim();
  if (map[s]) return map[s];
  const k = Object.keys(map).find(x => norm(map[x]) === norm(s));
  return k ? map[k] : s;
}

function buildDatasets(records, model, opts) {
  opts = opts || {};
  const report = { ok: true, errors: [], warnings: [], info: [], recordsRead: records.length, recordsUsed: 0, recordsSkipped: 0, countries: [], columnsFound: 0, columnsExpected: model.questions.length };
  const warn = m => { if (report.warnings.length < 200) report.warnings.push(m); }, err = m => report.errors.push(m);
  const cols = records.length ? Object.keys(records[0]) : [];
  const qById = {}; model.questions.forEach(q => { qById[q.q] = q; });
  const qCols = cols.filter(c => qById[c]);
  report.columnsFound = qCols.length;
  if (!records.length) err('The data has no records.');
  else if (cols.indexOf('country') < 0 && !cols.some(c => /^country_/.test(c))) err('There is no country column (country or country_*). Export the ADHMAT form with the standard field list.');
  else if (qCols.length < model.questions.length * 0.5) err('Only ' + qCols.length + ' of ' + model.questions.length + ' ADHMAT question columns were found. This does not look like an export of this ADHMAT form.');
  if (err.length) { /* noop */ }
  if (report.errors.length) { report.ok = false; return { report, datasets: null }; }
  if (qCols.length < model.questions.length) warn((model.questions.length - qCols.length) + ' question column(s) are not in the data; they count as unanswered. First missing: ' + model.questions.filter(q => cols.indexOf(q.q) < 0).slice(0, 5).map(q => q.q).join(', ') + '.');

  const idx = countryIndex(model), code = model.answerCode, total = model.questions.length;
  const subRank = {}; model.questions.forEach((q, i) => { const k = q.domain + '|' + q.sub; if (subRank[k] === undefined) subRank[k] = i; });
  const priSet = {}; model.priority.forEach(p => { priSet[p.q] = p; });
  const narr = model.module2.narrative, evid = model.module2.evidence;

  const countryOf = rec => {
    if (!blank(rec.country)) return resolveCountry(rec.country, idx);
    for (const c of cols) if (/^country_/.test(c) && !blank(rec[c])) { const t = resolveCountry(rec[c], idx); if (t) return t; }
    return null;
  };
  const answered = rec => { let n = 0; for (const q of model.questions) if (!blank(rec[q.q])) n++; return n; };

  /* one record per Member State: prefer Complete, then most answers, then the latest record id */
  const byC = {};
  records.forEach((rec, k) => {
    const t = countryOf(rec);
    if (!t) { report.recordsSkipped++; warn('Row ' + (k + 1) + ': country "' + (rec.country || '') + '" is not a recognised Member State; skipped.'); return; }
    const score = [STATUS.test(String(rec.review_m1_status || '').trim()) && cap(rec.review_m1_status) === 'Complete' ? 1 : 0, answered(rec), Number(rec.record_id) || 0];
    const cur = byC[t.iso3];
    if (cur) {
      report.recordsSkipped++;
      const better = score[0] !== cur.score[0] ? score[0] > cur.score[0] : score[1] !== cur.score[1] ? score[1] > cur.score[1] : score[2] >= cur.score[2];
      warn('More than one record for ' + t.name + ' (record ' + (cur.rec.record_id || '?') + ' and ' + (rec.record_id || '?') + '); using record ' + ((better ? rec : cur.rec).record_id || '?') + '.');
      if (!better) return;
    }
    byC[t.iso3] = { t, rec, score };
  });

  const D = { countries: [], module2: [], subdomains: [], answers: [], questions: model.questions.map(q => ({ q: q.q, n: q.n, domain: q.domain, domain_name: q.domain_name, sub: q.sub, sub_name: q.sub_name, step: q.step, text: q.text })) };
  const consentWarn = [];

  model.countries.filter(t => t.iso3).forEach(t => {
    const hit = byC[t.iso3], rec = hit ? hit.rec : {};
    const ans = [], tally = {}; let nAns = 0, bad = 0;
    model.questions.forEach(q => {
      const a = answerOf(rec[q.q], code);
      if (a === null) return; if (a === undefined) { bad++; return; }
      const row = { c: t.iso3, q: q.q, a };
      if (priSet[q.q] && a === 1) row.u = blank(rec[priSet[q.q].upload]) ? 0 : 1;
      ans.push(row); nAns++;
      if (a === 2) return;
      const k = q.domain + '|' + q.sub, g = tally[k] || (tally[k] = { domain: q.domain, sub: q.sub, sub_name: q.sub_name, yes: 0, no: 0 });
      if (a === 1) g.yes++; else g.no++;
    });
    if (bad) warn(t.name + ': ' + bad + ' answer value(s) were not Yes, No or N/A and were ignored.');
    ans.forEach(a => D.answers.push(a));

    const dom = {}, dpsList = [];
    Object.keys(tally).sort((a, b) => subRank[a] - subRank[b]).forEach(k => {
      const g = tally[k], tot = g.yes + g.no; if (!tot) return; const s = g.yes / tot * 100;
      D.subdomains.push({ c: t.iso3, domain: g.domain, sub: g.sub, sub_name: g.sub_name, score: r1(s), yes: g.yes, no: g.no });
      if (g.domain === 'DPS') dpsList.push(s); else (dom[g.domain] = dom[g.domain] || []).push(s);
    });
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const letters = ['A', 'B', 'C', 'D', 'E'], dsc = {};
    letters.forEach(L => { dsc[L] = dom[L] ? mean(dom[L]) : null; });
    const present = letters.filter(L => dsc[L] !== null);
    const overall = present.length ? mean(present.map(L => dsc[L])) : null;
    const dps = dpsList.length ? mean(dpsList) : null;
    const lv = levelOf(model, overall);

    const modChoice = String(rec.module_choice || '').trim();
    const m1Given = STATUS.test(String(rec.review_m1_status || '').trim()) ? cap(rec.review_m1_status) : null;
    const m1 = m1Given || (nAns >= total ? 'Complete' : nAns > 0 ? 'In progress' : 'Not started');
    if (m1Given && m1Given === 'Complete' && nAns < total) warn(t.name + ': review status says Complete but only ' + nAns + ' of ' + total + ' questions are answered.');

    /* Module 2: narrative completeness, consent, contact and evidence slots */
    const filled = narr.filter(x => !blank(rec[x.field])).length;
    const m2Given = STATUS.test(String(rec.review_m2_status || '').trim()) ? cap(rec.review_m2_status) : null;
    const m2s = m2Given || (narr.length && filled >= narr.length ? 'Complete' : filled > 0 ? 'In progress' : 'Not started');
    const m2 = { iso3: t.iso3, m2_status: m2s, m2_answered: filled, m2_total: narr.length };
    m2.consent = choiceLabel(model.module2.consent, rec.data_sharing_consent);
    m2.contact_ok = choiceLabel(model.module2.contact, rec.sodh_contact_ok);
    m2.case_study_ok = choiceLabel(model.module2.case_study, rec.sodh_case_study_ok);
    ['a', 'b', 'c', 'd', 'e'].forEach(l => { m2['ev_' + l] = 0; });
    evid.forEach(e => { if (!blank(rec[e.field])) m2['ev_' + e.cls.toLowerCase()]++; });
    D.module2.push(m2);
    if (hit && m2.consent && /not for publication|use only/i.test(m2.consent)) consentWarn.push(t.name);

    const status = m1 === 'Complete' && m2s === 'Complete' ? 'Complete' : (m1 === 'Not started' && m2s === 'Not started' ? 'Not started' : 'In progress');
    const pop = num(rec[model.profileFields.population]), fac = num(rec[model.profileFields.facilities]), urb = num(rec[model.profileFields.urban]);
    let priYes = 0, priDocs = 0; ans.forEach(a => { if (priSet[a.q] && a.a === 1) { priYes++; if (a.u === 1) priDocs++; } });
    D.countries.push({
      iso3: t.iso3, country: t.name, region: t.region,
      population_m: pop === null ? null : Math.round(pop / 1e4) / 100, facilities: fac, urban_pct: urb,
      status, m1_status: m1, m2_status: m2s, answered: nAns, completion_pct: r1(nAns / total * 100),
      overall: overall === null ? null : r1(overall), level: lv ? lv.level : null, level_name: lv ? lv.label : '',
      dom_a: dsc.A === null ? null : r1(dsc.A), dom_b: dsc.B === null ? null : r1(dsc.B), dom_c: dsc.C === null ? null : r1(dsc.C),
      dom_d: dsc.D === null ? null : r1(dsc.D), dom_e: dsc.E === null ? null : r1(dsc.E), dps: dps === null ? null : r1(dps),
      priority_yes: priYes, priority_docs: priDocs
    });

    /* cross-check against the scores REDCap calculated itself */
    if (hit) {
      const chk = [['result_overall_score', overall], ['result_a_score', dsc.A], ['result_b_score', dsc.B], ['result_c_score', dsc.C], ['result_d_score', dsc.D], ['result_e_score', dsc.E]];
      chk.forEach(([f, mine]) => {
        const theirs = num(rec[f]); if (theirs === null || mine === null) return;
        if (Math.abs(theirs - r1(mine)) > 0.15) warn(t.name + ': ' + f + ' is ' + theirs + ' in REDCap but ' + r1(mine) + ' when recalculated here. Check that the form version matches the dictionary.');
      });
      if (!blank(rec.h_cnt_all) && num(rec.h_cnt_all) !== nAns) warn(t.name + ': REDCap counts ' + rec.h_cnt_all + ' answered questions, this import counts ' + nAns + '.');
      report.countries.push({ iso3: t.iso3, name: t.name, m1, m2: m2s, answered: nAns, overall: overall === null ? null : r1(overall), record_id: rec.record_id || null });
    }
  });
  report.recordsUsed = Object.keys(byC).length;
  if (!report.recordsUsed) { report.ok = false; err('No record could be matched to a Member State.'); return { report, datasets: null }; }
  report.info.push(report.recordsUsed + ' Member State record(s) used; the other ' + (D.countries.length - report.recordsUsed) + ' are shown as not started.');
  if (!model.structuredModule2) report.info.push('Module 2 in this dictionary is narrative text only. Structured Module 2 charts (initiative stage, barriers, support sources and similar) have no data and are shown as not captured. Narrative text is never copied into the dashboard.');
  if (consentWarn.length) report.info.push('Data-use consent is "not for publication / use only": ' + consentWarn.join(', ') + '. Check consent before sharing named results outside Africa CDC.');
  report.completeM1 = D.countries.filter(c => c.m1_status === 'Complete').length;
  report.completeBoth = D.countries.filter(c => c.status === 'Complete').length;
  return { report, datasets: D };
}

function hashDatasets(ds) {
  const h = crypto.createHash('sha256');
  ['countries', 'module2', 'subdomains', 'answers', 'questions'].forEach(k => h.update(JSON.stringify(ds[k]))); return h.digest('hex');
}

/* Inverse: dashboard datasets -> REDCap-style flat records for this dictionary. Used for the test export and the mock REDCap server. */
function toRecords(ds, model) {
  const byIso = {}; model.countries.forEach(c => { byIso[c.iso3] = c; });
  const ansBy = {}; ds.answers.forEach(a => { (ansBy[a.c] = ansBy[a.c] || {})[a.q] = a; });
  const m2By = {}; ds.module2.forEach(m => { m2By[m.iso3] = m; });
  /* the design's test data uses short labels; match them to the dictionary's longer ones by leading words */
  const inv = (map, label) => { const L = norm(label); const k = Object.keys(map).find(x => map[x] === label) || Object.keys(map).find(x => { const m = norm(map[x]); return L && (m.startsWith(L) || L.startsWith(m) || (/^named/.test(L) && /published in continental reports with/.test(m)) || (/^aggregated/.test(L) && /aggregated/.test(m)) || (/only$/.test(L) && /only/.test(m) && !/^may be/.test(m) && /not for publication|use only/.test(m))); }); return k === undefined ? '' : k; };
  const rccCode = name => (model.rcc.find(r => r.name === name) || {}).code || '';
  const priUp = {}; model.priority.forEach(p => { priUp[p.q] = p.upload; });
  const recs = [];
  ds.countries.forEach((c, i) => {
    const t = byIso[c.iso3]; if (!t) return;
    const r = { record_id: String(i + 1), rcc: rccCode(t.rcc), country: t.code };
    model.countries.forEach(x => { /* country_* drop-downs: only the one matching the RCC is filled */ });
    Object.keys(model.fields).filter(n => /^country_/.test(n)).forEach(n => { r[n] = ''; });
    r['country_' + t.rcc.toLowerCase()] = t.code;
    r.module_choice = '3'; r.reporting_period = '2026';
    r.population_covered = c.population_m == null ? '' : String(Math.round(c.population_m * 1e6));
    r.num_health_facilities = c.facilities == null ? '' : String(c.facilities);
    r.urban_population_pct = c.urban_pct == null ? '' : String(c.urban_pct);
    const A = ansBy[c.iso3] || {};
    model.questions.forEach(q => { const a = A[q.q]; r[q.q] = a ? String(a.a) : ''; if (a && priUp[q.q]) r[priUp[q.q]] = a.u === 1 ? 'test_supporting_document.pdf' : ''; });
    r.review_m1_status = c.m1_status; r.review_m2_status = c.m2_status;
    r.result_overall_score = c.overall == null ? '' : String(c.overall);
    ['a', 'b', 'c', 'd', 'e'].forEach(l => { r['result_' + l + '_score'] = c['dom_' + l] == null ? '' : String(c['dom_' + l]); });
    r.h_cnt_all = String(Object.keys(A).length);
    const m = m2By[c.iso3] || {};
    const nFill = m.m2_status === 'Complete' ? model.module2.narrative.length : m.m2_status === 'In progress' ? Math.max(1, Math.floor(model.module2.narrative.length / 2)) : 0;
    model.module2.narrative.forEach((x, k) => { r[x.field] = k < nFill ? 'TEST DATA. Narrative response ' + (k + 1) + ' for ' + t.name + '.' : ''; });
    r.sodh_h_filled = String(nFill);
    if (m.m2_status === 'Complete') {
      r.data_sharing_consent = inv(model.module2.consent, m.consent); r.sodh_contact_ok = inv(model.module2.contact, m.contact_ok); r.sodh_case_study_ok = inv(model.module2.case_study, m.case_study_ok);
      model.module2.evidence.forEach(e => { r[e.field] = (m['ev_' + e.cls.toLowerCase()] || 0) > 0 ? 'test_evidence_' + e.cls + '.pdf' : ''; });
    }
    recs.push(r);
  });
  return recs;
}

module.exports = { buildDatasets, hashDatasets, toRecords, levelOf, r1 };
