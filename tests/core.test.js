'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testDatasets, model, D, T } = require('./helpers');
const csv = require('../src/csv');

test('dictionary: structure is derived, not configured', () => {
  const m = model();
  assert.equal(m.errors.length, 0); assert.equal(m.warnings.length, 0);
  assert.equal(m.questions.length, 373);
  const by = {}; m.questions.forEach(q => { by[q.domain] = (by[q.domain] || 0) + 1; });
  assert.deepEqual(by, { A: 105, B: 140, C: 53, D: 35, E: 35, DPS: 5 });
  assert.equal(m.subdomains.length, 23);
  assert.equal(m.countries.length, 55); assert.ok(m.countries.every(c => c.iso3 && c.region));
  assert.deepEqual(m.priority.map(p => p.q), ['q_a1_2', 'q_a4_2', 'q_a4_3', 'q_a5_1', 'q_a7_3', 'q_a8_3', 'q_b11_3', 'q_b13_2', 'q_c2_3', 'q_e9_2']);
  assert.deepEqual(m.levels.map(l => l.min), [85, 70, 55, 40, 0]);
  assert.deepEqual(m.answerCode, { yes: '1', no: '0', na: '2' });
  assert.equal(m.module2.narrative.length, 14); assert.equal(m.module2.evidence.length, 5);
  assert.equal(m.structuredModule2, false);
  assert.ok(!m.exportFields.some(f => /^focal_person_|email|phone/.test(f)), 'personal contact fields must never be requested');
});

test('dictionary: question list equals the attached dashboard design (368 identical, 5 DPS wording cleaned)', () => {
  const m = model(), dash = {}; testDatasets().questions.forEach(q => { dash[q.q] = q; });
  m.questions.forEach(q => {
    const d = dash[q.q]; assert.ok(d, q.q);
    ['n', 'domain', 'domain_name', 'sub', 'sub_name', 'step'].forEach(k => assert.equal(q[k], d[k], q.q + ' ' + k));
    if (q.domain !== 'DPS') assert.equal(q.text, d.text, q.q + ' text'); else assert.ok(d.text.endsWith(q.text), q.q + ' DPS text');
  });
});

test('dictionary: rejects things that are not a REDCap dictionary', () => {
  assert.throws(() => D.load(Buffer.from('a,b\n1,2\n')), /not a REDCap data dictionary/);
});

test('scoring parity: test data -> REDCap records -> datasets reproduces the design data exactly', () => {
  const m = model(), ds = testDatasets(), recs = T.toRecords(ds, m), out = T.buildDatasets(recs, m);
  assert.ok(out.report.ok); assert.deepEqual(out.report.warnings, []);
  /* One known conflict: the dictionary puts Mauritius in the Southern RCC, the dashboard design data has it under East. The dictionary wins (it is the REDCap source) and the difference is reported in the README. */
  const fixMus = ds.countries.map(c => c.iso3 === 'MUS' ? Object.assign({}, c, { region: 'Southern' }) : c);
  assert.deepEqual(out.datasets.countries, fixMus);
  assert.deepEqual(out.datasets.subdomains, ds.subdomains);
  assert.deepEqual(out.datasets.answers, ds.answers);
});

function blankRecord(m, country) { const r = { record_id: '1', country: String(country) }; m.questions.forEach(q => { r[q.q] = ''; }); return r; }

test('scoring: all Yes = 100 L5; all No = 0 L1; N/A and blanks are excluded', () => {
  const m = model(), r = blankRecord(m, 53); m.questions.forEach(q => { r[q.q] = '1'; });
  let c = T.buildDatasets([r], m).datasets.countries.find(x => x.iso3 === 'UGA');
  assert.equal(c.overall, 100); assert.equal(c.level, 5); assert.equal(c.dps, 100); assert.equal(c.m1_status, 'Complete');
  m.questions.forEach(q => { r[q.q] = '0'; });
  c = T.buildDatasets([r], m).datasets.countries.find(x => x.iso3 === 'UGA'); assert.equal(c.overall, 0); assert.equal(c.level, 1);
  m.questions.forEach(q => { r[q.q] = '2'; });
  c = T.buildDatasets([r], m).datasets.countries.find(x => x.iso3 === 'UGA'); assert.equal(c.overall, null); assert.equal(c.level, null); assert.equal(c.answered, 373);
  m.questions.forEach(q => { r[q.q] = ''; }); r.q_a1_1 = '1'; r.q_a1_2 = '1'; r.q_a1_3 = '1'; r.q_a1_4 = '0'; r.q_a1_5 = '2';
  const out = T.buildDatasets([r], m), sd = out.datasets.subdomains.filter(s => s.c === 'UGA');
  assert.equal(sd.length, 1); assert.equal(sd[0].score, 75); assert.equal(sd[0].yes, 3); assert.equal(sd[0].no, 1);
  const u = out.datasets.countries.find(x => x.iso3 === 'UGA'); assert.equal(u.dom_a, 75); assert.equal(u.overall, 75); assert.equal(u.level, 4); assert.equal(u.m1_status, 'In progress');
});

test('scoring: level boundaries follow the thresholds in the dictionary', () => {
  const m = model(), lv = s => T.levelOf(m, s).level;
  [[0, 1], [39.9999, 1], [40, 2], [54.9, 2], [55, 3], [69.99, 3], [70, 4], [84.9, 4], [85, 5], [100, 5]].forEach(([s, l]) => assert.equal(lv(s), l, 'score ' + s));
  assert.equal(T.levelOf(m, null), null);
});

test('overall = mean of the five domains, not of the sub-domains; DPS is excluded', () => {
  const m = model(), r = blankRecord(m, 53);
  m.questions.filter(q => q.domain === 'A' && q.sub === 'ld').forEach(q => { r[q.q] = '1'; });
  m.questions.filter(q => q.domain === 'B' && q.sub === 'in').forEach(q => { r[q.q] = '0'; });
  m.questions.filter(q => q.domain === 'DPS').forEach(q => { r[q.q] = '1'; });
  const c = T.buildDatasets([r], m).datasets.countries.find(x => x.iso3 === 'UGA');
  assert.equal(c.dom_a, 100); assert.equal(c.dom_b, 0); assert.equal(c.overall, 50); assert.equal(c.dps, 100);
});

test('import handling: label exports, duplicates, unknown countries, bad values, REDCap score mismatch', () => {
  const m = model(), ds = testDatasets(), recs = T.toRecords(ds, m);
  const lab = recs.slice(0, 2).map(r => { const o = Object.assign({}, r); m.questions.forEach(q => { o[q.q] = { 1: 'Yes', 0: 'No', 2: 'N/A', '': '' }[o[q.q]]; }); o.country = ({ 1: 'Algeria', 2: 'Angola' })[o.country]; return o; });
  const a = T.buildDatasets(lab, m); assert.ok(a.report.ok);
  assert.deepEqual(a.datasets.countries.slice(0, 2).map(c => c.overall), ds.countries.slice(0, 2).map(c => c.overall));
  const dup = [Object.assign({}, recs[0]), Object.assign({}, recs[0], { record_id: '99', q_a1_1: '' })];
  const d = T.buildDatasets(dup, m); assert.equal(d.report.recordsUsed, 1); assert.ok(d.report.warnings.some(w => /More than one record/.test(w)));
  const unk = T.buildDatasets([recs[0], Object.assign({}, recs[1], { country: '999' })], m); assert.ok(unk.report.warnings.some(w => /not a recognised Member State/.test(w)));
  const bad = Object.assign({}, recs[0], { q_a1_1: 'maybe' }); assert.ok(T.buildDatasets([bad], m).report.warnings.some(w => /not Yes, No or N\/A/.test(w)));
  const mis = Object.assign({}, recs[0], { result_overall_score: '12.3' }); assert.ok(T.buildDatasets([mis], m).report.warnings.some(w => /REDCap but/.test(w)));
  assert.equal(T.buildDatasets([], m).report.ok, false);
  assert.equal(T.buildDatasets([{ foo: 'bar', country: '1' }], m).report.ok, false);
});

test('module 2: narrative completeness, consent, contact and evidence slots come from the dictionary fields', () => {
  const m = model(), r = { record_id: '1', country: '53', module_choice: '3' };
  m.module2.narrative.forEach((x, i) => { r[x.field] = i < 5 ? 'SECRET-NARRATIVE' : ''; });
  r.data_sharing_consent = '2'; r.sodh_contact_ok = '2'; r.sodh_case_study_ok = '1'; r.sodh_q14_e1_file = 'a.pdf'; r.sodh_q14_e3_file = 'c.pdf';
  m.questions.forEach(q => { r[q.q] = '1'; });
  let u = T.buildDatasets([r], m).datasets.module2.find(x => x.iso3 === 'UGA');
  assert.equal(u.m2_status, 'In progress'); assert.equal(u.m2_answered, 5); assert.equal(u.m2_total, 14);
  assert.equal(u.consent, 'May be used in continental reports in aggregated form, without naming the Member State'); assert.equal(u.contact_ok, 'Yes, through the focal point only'); assert.equal(u.case_study_ok, 'Yes');
  assert.deepEqual([u.ev_a, u.ev_b, u.ev_c, u.ev_d, u.ev_e], [1, 0, 1, 0, 0]);
  m.module2.narrative.forEach(x => { r[x.field] = 'SECRET-NARRATIVE'; });
  const full = T.buildDatasets([r], m).datasets; u = full.module2.find(x => x.iso3 === 'UGA'); assert.equal(u.m2_status, 'Complete');
  assert.ok(!JSON.stringify(full).includes('SECRET-NARRATIVE'), 'narrative text must never enter the datasets');
});

test('csv: quotes, embedded commas and line breaks, BOM', () => {
  const t = '﻿a,b\r\n"x,1","line1\nline2"\r\n"he said ""hi""",3\r\n';
  const { records } = csv.parseObjects(t);
  assert.equal(records[0].a, 'x,1'); assert.equal(records[0].b, 'line1\nline2'); assert.equal(records[1].a, 'he said "hi"');
  assert.equal(csv.parseObjects(csv.stringify(['a', 'b'], records)).records[1].a, 'he said "hi"');
});
