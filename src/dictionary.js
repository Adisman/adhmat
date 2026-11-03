'use strict';
/*
 * Reads a REDCap data dictionary (CSV download of the project's instrument) and derives everything the
 * pipeline needs, so no one has to map columns by hand:
 *   - the question list (id, number, domain, sub-domain, maturity step, text), from the q_* fields and the
 *     h_<domain>_<sub>_y calculated fields that REDCap itself uses to score each sub-domain
 *   - domain names and the maturity-level thresholds, from the h_dom_* labels and result_*_lvl formulas
 *   - the 55 Member States and Regional Collaborating Centres, from the country_* drop-downs
 *   - the priority questions that ask for a supporting document, from the up_* upload fields
 *   - Module 2 fields (narrative questions, evidence slots, consent and contact choices)
 *   - the list of fields to request from the REDCap API (personal contact fields are never requested)
 */
const crypto = require('crypto');
const fs = require('fs');
const csv = require('./csv');
const C = require('./countries');

const COL = {
  name: 'Variable / Field Name', form: 'Form Name', header: 'Section Header', type: 'Field Type', label: 'Field Label',
  choices: 'Choices, Calculations, OR Slider Labels', note: 'Field Note', branching: 'Branching Logic (Show field only if...)',
  required: 'Required Field?', number: 'Question Number (surveys only)', annotation: 'Field Annotation'
};

const plain = html => String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/* The question text is the last <div> of the label; earlier divs are sub-domain headers shown on the form. */
function questionText(labelHtml) {
  const divs = String(labelHtml || '').match(/<div[^>]*>[\s\S]*?<\/div>/gi);
  return plain(divs && divs.length ? divs[divs.length - 1] : labelHtml);
}

function parseChoices(s) {
  const out = {}, order = [];
  String(s || '').split('|').forEach(p => {
    const i = p.indexOf(','); if (i < 0) return;
    const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim();
    if (k) { out[k] = v; order.push(k); }
  });
  return { map: out, order };
}

const LEVEL_NAMES = { 1: 'Nascent', 2: 'Emerging', 3: 'Established', 4: 'Advanced', 5: 'Optimized' };

function load(source) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : (source.includes('\n') ? source : fs.readFileSync(source, 'utf8'));
  const { headers, records } = csv.parseObjects(text);
  const missingCols = [COL.name, COL.type, COL.label, COL.choices].filter(c => headers.indexOf(c) < 0);
  if (missingCols.length) throw new Error('This is not a REDCap data dictionary: column(s) missing: ' + missingCols.join(', '));

  const fields = {}, order = [];
  records.forEach(r => {
    const f = {
      name: r[COL.name], form: r[COL.form], type: r[COL.type], labelHtml: r[COL.label], label: plain(r[COL.label]),
      choicesRaw: r[COL.choices], branching: r[COL.branching], required: /^y/i.test(r[COL.required] || ''),
      number: r[COL.number] || '', annotation: r[COL.annotation] || ''
    };
    if (f.type === 'radio' || f.type === 'dropdown' || f.type === 'checkbox') f.choices = parseChoices(f.choicesRaw);
    if (f.type === 'calc') f.calc = f.choicesRaw;
    fields[f.name] = f; order.push(f.name);
  });

  const warnings = [], errors = [];

  /* ---- sub-domains and domains from the REDCap scoring calculations ---- */
  const subOf = {};            // q id -> { domain, sub, sub_name }
  const domainNames = {}, subNames = {};
  order.forEach(n => {
    const m = /^h_([a-e])_([a-z]{2})_y$/.exec(n); if (!m) return;
    const f = fields[n], dom = m[1].toUpperCase(), sub = m[2];
    const lab = f.label.replace(/\s*-\s*Yes count\s*$/i, '');
    const parts = lab.split(' / ');
    domainNames[dom] = (parts[0] || dom).trim(); subNames[dom + '|' + sub] = (parts[1] || sub).trim();
    (f.calc.match(/\[(q_[a-z0-9_]+)\]/g) || []).forEach(t => {
      const q = t.slice(1, -1);
      if (subOf[q] && !(subOf[q].domain === dom && subOf[q].sub === sub)) warnings.push('Question ' + q + ' is counted in more than one sub-domain calculation.');
      subOf[q] = { domain: dom, sub, sub_name: subNames[dom + '|' + sub] };
    });
  });
  /* Digital Payment Systems: counted by h_cnt_dps and reported on its own (it has no sub-domain calculation). */
  const dpsIds = ((fields.h_cnt_dps && fields.h_cnt_dps.calc || '').match(/\[(q_dps[a-z0-9_]*)\]/g) || []).map(t => t.slice(1, -1));
  dpsIds.forEach(q => { subOf[q] = { domain: 'DPS', sub: 'sa', sub_name: 'Services & Applications' }; });
  domainNames.DPS = 'Digital Payment Systems (supplementary)';

  /* ---- questions, in form order ---- */
  const questions = [];
  order.forEach(n => {
    const f = fields[n]; if (!/^q_/.test(n) || f.type !== 'radio') return;
    const m = subOf[n];
    if (!m) { errors.push('Question ' + n + ' is not part of any sub-domain calculation in the dictionary.'); return; }
    const num = /^(\d+)\.(\d+)$/.exec(f.number), stepM = /(\d+)$/.exec(n);
    questions.push({
      q: n, n: questions.length + 1, number: f.number || '', domain: m.domain, domain_name: domainNames[m.domain] || m.domain,
      sub: m.sub, sub_name: m.sub_name, step: stepM ? Number(stepM[1]) : (num ? Number(num[2]) : null), text: questionText(f.labelHtml)
    });
  });
  if (!questions.length) errors.push('No ADHMAT questions (q_* fields) were found.');

  /* ---- answer codes (Yes / No / N/A) read from the first question's choices ---- */
  const ch = (fields[questions[0] && questions[0].q] || {}).choices || { map: {} };
  const code = { yes: null, no: null, na: null };
  Object.keys(ch.map).forEach(k => { const v = ch.map[k].toLowerCase(); if (v === 'yes') code.yes = k; else if (v === 'no') code.no = k; else if (/^n\/?a/.test(v)) code.na = k; });
  if (code.yes === null || code.no === null) errors.push('Could not find Yes and No among the question choices.');

  /* ---- maturity thresholds from the REDCap level formula ---- */
  let thresholds = [];
  const lvlCalc = (fields.result_overall_lvl || fields.result_a_lvl || {}).calc || '';
  const re = /round\(\[[a-z_]+\],\s*\d+\)>=(\d+(?:\.\d+)?),(\d)/g; let mm;
  while ((mm = re.exec(lvlCalc))) thresholds.push([Number(mm[1]), Number(mm[2])]);
  if (thresholds.length !== 4) { warnings.push('Maturity thresholds could not be read from the dictionary; the ADHMAT defaults (40/55/70/85) are used.'); thresholds = [[85, 5], [70, 4], [55, 3], [40, 2]]; }
  thresholds.sort((a, b) => b[0] - a[0]);
  const levels = thresholds.map(t => ({ min: t[0], level: t[1], name: LEVEL_NAMES[t[1]], label: 'L' + t[1] + ' - ' + LEVEL_NAMES[t[1]] })).concat([{ min: 0, level: 1, name: LEVEL_NAMES[1], label: 'L1 - ' + LEVEL_NAMES[1] }]);

  /* ---- priority questions: those with a supporting-document upload ---- */
  const priority = [];
  order.forEach(n => {
    const f = fields[n]; if (f.type !== 'file' || !/^up_/.test(n)) return;
    const m = /\[(q_[a-z0-9_]+)\]\s*=\s*'1'/.exec(f.branching || '');
    const q = m ? m[1] : 'q_' + n.slice(3);
    if (questions.some(x => x.q === q)) priority.push({ q, upload: n, label: plain(f.labelHtml).replace(/^Upload supporting document:\s*/i, '') });
  });

  /* ---- countries and regions ---- */
  const rcc = fields.rcc ? fields.rcc.choices : { map: {} };
  const rccName = k => (rcc.map[k] || '').replace(/\s*RCC\s*$/i, '');
  const countries = [];
  order.forEach(n => {
    const m = /^country_([a-z]+)$/.exec(n); if (!m || fields[n].type !== 'dropdown') return;
    const rm = /\[rcc\]\s*=\s*'(\d+)'/.exec(fields[n].branching || '');
    const rccLabel = rm ? rccName(rm[1]) : m[1];
    Object.keys(fields[n].choices.map).forEach(code => {
      const name = fields[n].choices.map[code];
      const iso3 = C.ISO3[name];
      if (!iso3) warnings.push('Country "' + name + '" (code ' + code + ') has no ISO 3 code in the reference table; it will be skipped.');
      countries.push({ code: String(code), redcap_name: name, name: C.DISPLAY[name] || name, iso3: iso3 || null, rcc: rccLabel, region: C.REGION[rccLabel] || rccLabel });
    });
  });
  countries.sort((a, b) => Number(a.code) - Number(b.code));
  if (countries.length !== 55) warnings.push('The dictionary lists ' + countries.length + ' Member States (55 expected).');

  /* ---- Module 2 ---- */
  const narrative = order.filter(n => /^sodh_q\d+$/.test(n) && fields[n].type === 'notes').map(n => {
    const f = fields[n], t = /^(?:Question\s+(\d+))\s*·\s*([^A-Z]*[A-Za-z][^.?]*?)(?=[A-Z][a-z])/.exec(f.label);
    const rawTitle = (String(f.labelHtml).match(/Question\s+\d+\s*·\s*([^<]+?)\s*(?:<|$)/) || [])[1];
    return { field: n, n: Number(n.slice(6)), title: (rawTitle || (t && t[2]) || f.label.slice(0, 60)).trim() };
  });
  const evidence = order.filter(n => /^sodh_q14_e\d_file$/.test(n)).map(n => {
    const c = /Evidence\s+([A-E])\b/.exec(fields[n].label);
    return { field: n, cls: c ? c[1] : null, label: fields[n].label };
  }).filter(e => e.cls);
  const choiceMap = n => (fields[n] && fields[n].choices ? fields[n].choices.map : {});
  const module2 = {
    narrative, evidence,
    consent: choiceMap('data_sharing_consent'), contact: choiceMap('sodh_contact_ok'), case_study: choiceMap('sodh_case_study_ok'),
    structured: order.filter(n => /^sodh_/.test(n) && ['radio', 'dropdown', 'checkbox'].indexOf(fields[n].type) >= 0 && n !== 'sodh_contact_ok' && n !== 'sodh_case_study_ok')
  };
  /* Dashboard Module 2 charts that need structured answers which this dictionary does not contain. */
  const m2Missing = ['init_status', 'phc_area', 'phc_stage', 'barrier_1', 'barrier_2', 'barrier_3', 'barrier_response', 'emerging', 'factors', 'support_from'];
  const structuredAvailable = module2.structured.length > 0;

  /* ---- profile / status / score fields present in this dictionary ---- */
  const has = n => !!fields[n];
  const need = ['record_id', 'rcc', 'country', 'module_choice', 'review_m1_status', 'review_m2_status'];
  need.forEach(n => { if (!has(n)) warnings.push('Field "' + n + '" is not in the dictionary; features that use it will be limited.'); });
  const optional = ['population_covered', 'num_health_facilities', 'urban_population_pct', 'num_admin_units', 'reporting_period', 'assessment_date', 'approval_status',
    'data_sharing_consent', 'sodh_contact_ok', 'sodh_case_study_ok', 'result_overall_score', 'result_a_score', 'result_b_score', 'result_c_score', 'result_d_score', 'result_e_score',
    'h_cnt_all', 'sodh_h_filled'];
  const exportFields = [];
  const add = n => { if (has(n) && exportFields.indexOf(n) < 0) exportFields.push(n); };
  need.concat(optional).forEach(add);
  questions.forEach(q => add(q.q));
  priority.forEach(p => add(p.upload));
  narrative.forEach(x => add(x.field));
  evidence.forEach(x => add(x.field));
  Object.keys(fields).filter(n => /^country_/.test(n)).forEach(add);

  const sha = crypto.createHash('sha256').update(text).digest('hex');
  /* structure signature: ignores label wording and layout so a re-download of the same form does not look like a change */
  const signature = crypto.createHash('sha256').update(JSON.stringify(order.filter(n => fields[n].type !== 'descriptive').map(n => [n, fields[n].type, fields[n].choicesRaw, fields[n].branching]))).digest('hex');
  return {
    sha256: sha, signature, loadedAt: new Date().toISOString(), fields, order, warnings, errors,
    form: (fields.record_id && fields.record_id.form) || null,
    questions, domainNames, subNames, subdomains: Object.keys(subNames).map(k => { const [d, s] = k.split('|'); return { domain: d, sub: s, sub_name: subNames[k] }; }),
    answerCode: code, levels, priority, countries, rcc: Object.keys(rcc.map).map(k => ({ code: k, name: rccName(k) })),
    module2, m2Missing: structuredAvailable ? [] : m2Missing, structuredModule2: structuredAvailable,
    exportFields, profileFields: { population: 'population_covered', facilities: 'num_health_facilities', urban: 'urban_population_pct' },
    summary() {
      const byDom = {}; questions.forEach(q => { byDom[q.domain] = (byDom[q.domain] || 0) + 1; });
      return {
        sha256: sha, fields: order.length, questions: questions.length, questionsByDomain: byDom, domains: domainNames,
        subdomains: this.subdomains.length, priorityQuestions: priority.map(p => p.q), countries: countries.length,
        rccs: this.rcc.map(r => r.name), levels, answerCodes: code, module2: { narrativeQuestions: narrative.length, evidenceSlots: evidence.map(e => e.cls), structuredFields: module2.structured.length },
        exportFieldCount: exportFields.length, warnings, errors
      };
    }
  };
}

/* Convert the REDCap API metadata export (content=metadata) into dictionary CSV text, so the same loader can read it. */
function metadataToCsv(meta) {
  const head = [COL.name, COL.form, COL.header, COL.type, COL.label, COL.choices, COL.note, 'Text Validation Type OR Show Slider Number', 'Text Validation Min', 'Text Validation Max',
    'Identifier?', COL.branching, COL.required, 'Custom Alignment', COL.number, 'Matrix Group Name', 'Matrix Ranking?', COL.annotation];
  const keys = ['field_name', 'form_name', 'section_header', 'field_type', 'field_label', 'select_choices_or_calculations', 'field_note', 'text_validation_type_or_show_slider_number',
    'text_validation_min', 'text_validation_max', 'identifier', 'branching_logic', 'required_field', 'custom_alignment', 'question_number', 'matrix_group_name', 'matrix_ranking', 'field_annotation'];
  const rows = meta.map(m => { const o = {}; head.forEach((h, i) => { o[h] = m[keys[i]] == null ? '' : m[keys[i]]; }); return o; });
  return csv.stringify(head, rows);
}

/* Compare two models: used when the REDCap project metadata changes after the dictionary was loaded. */
function diff(a, b) {
  const A = new Set(a.order), B = new Set(b.order);
  return {
    added: b.order.filter(n => !A.has(n)), removed: a.order.filter(n => !B.has(n)),
    changedChoices: a.order.filter(n => B.has(n) && a.fields[n].choicesRaw !== b.fields[n].choicesRaw && a.fields[n].type !== 'descriptive').slice(0, 50)
  };
}

module.exports = { load, diff, metadataToCsv, plain, parseChoices, questionText };
