#!/usr/bin/env node
'use strict';
/* A small stand-in for the REDCap API, built from the same data dictionary, for testing the pipeline without a real REDCap project.
 * Implements POST /api/ for content=version | project | metadata | record (flat, raw), token check, records[] and fields[] filters.
 * Control endpoint (not part of REDCap): POST /__control  { visible, set:{record,field,value}, dropField, fireDet:{url} }  */
const http = require('http');
const fs = require('fs');
const path = require('path');
const csv = require('../src/csv');
const D = require('../src/dictionary');
const T = require('../src/transform');
const ROOT = path.resolve(__dirname, '..');

function createMock(o) {
  o = o || {};
  const token = o.token || 'MOCKTOKEN0123456789', dictPath = o.dictionary || path.join(ROOT, 'dictionary', 'AfricaDigitalHealthMaturityAss_DataDictionary_2026-11-03.csv');
  const dictText = fs.readFileSync(dictPath, 'utf8'), model = D.load(dictText), parsed = csv.parseObjects(dictText);
  const test = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'test', 'test-datasets.json'), 'utf8')).datasets;
  const all = T.toRecords(test, model);
  const state = { visible: o.visible === undefined ? all.length : o.visible, dropped: [], calls: [], records: all.map(r => Object.assign({}, r)) };
  const keyOf = { 'Variable / Field Name': 'field_name', 'Form Name': 'form_name', 'Section Header': 'section_header', 'Field Type': 'field_type', 'Field Label': 'field_label', 'Choices, Calculations, OR Slider Labels': 'select_choices_or_calculations', 'Field Note': 'field_note', 'Text Validation Type OR Show Slider Number': 'text_validation_type_or_show_slider_number', 'Text Validation Min': 'text_validation_min', 'Text Validation Max': 'text_validation_max', 'Identifier?': 'identifier', 'Branching Logic (Show field only if...)': 'branching_logic', 'Required Field?': 'required_field', 'Custom Alignment': 'custom_alignment', 'Question Number (surveys only)': 'question_number', 'Matrix Group Name': 'matrix_group_name', 'Matrix Ranking?': 'matrix_ranking', 'Field Annotation': 'field_annotation' };

  const body = req => new Promise(res => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString('utf8'))); });
  const server = http.createServer(async (req, res) => {
    const j = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const text = await body(req);
    if (req.url === '/__control' && req.method === 'POST') {
      const c = JSON.parse(text || '{}');
      if (c.visible !== undefined) state.visible = c.visible;
      if (c.set) { const r = state.records.find(x => x.record_id === String(c.set.record)); if (r) r[c.set.field] = String(c.set.value); }
      if (c.dropField) state.dropped.push(c.dropField);
      if (c.token) state.tokenOverride = c.token;
      if (c.fail !== undefined) state.fail = c.fail;
      if (c.fireDet) {
        const rec = state.records[0] || {};
        try { const r = await fetch(c.fireDet.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ project_id: '123', instrument: 'adhmat', record: rec.record_id || '1', redcap_event_name: '', adhmat_complete: '2' }) }); return j(200, { det: r.status }); } catch (e) { return j(500, { error: e.message }); }
      }
      return j(200, { ok: true, visible: state.visible, dropped: state.dropped });
    }
    if (req.url === '/__state') return j(200, { visible: state.visible, calls: state.calls.length });
    if (!/^\/api\/?$/.test(req.url) || req.method !== 'POST') return j(404, { error: 'not found' });
    const p = new URLSearchParams(text), list = n => { const out = []; p.forEach((v, k) => { if (k === n || k.indexOf(n + '[') === 0) out.push(v); }); return out; };
    state.calls.push(p.get('content'));
    if (state.fail) return j(state.fail, { error: 'The mock was told to fail.' });
    if (p.get('token') !== (state.tokenOverride || token)) return j(403, { error: 'You do not have permissions to use the API' });
    switch (p.get('content')) {
      case 'version': res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('14.5.0');
      case 'project': return j(200, { project_id: 123, project_title: 'Africa Digital Health Maturity Assessment (mock)', is_longitudinal: 0 });
      case 'metadata': return j(200, parsed.records.filter(r => state.dropped.indexOf(r['Variable / Field Name']) < 0).map(r => { const o2 = {}; Object.keys(keyOf).forEach(k => { o2[keyOf[k]] = r[k]; }); return o2; }));
      case 'record': {
        const fields = list('fields'), ids = list('records'); let recs = state.records.slice(0, state.visible);
        if (ids.length) recs = recs.filter(r => ids.indexOf(r.record_id) >= 0);
        return j(200, recs.map(r => { const o2 = { record_id: r.record_id }; (fields.length ? fields : Object.keys(r)).forEach(f => { if (state.dropped.indexOf(f) < 0 && r[f] !== undefined) o2[f] = r[f]; }); return o2; }));
      }
      default: return j(400, { error: 'unsupported content type in the mock: ' + p.get('content') });
    }
  });
  return { server, state, token, listen: port => new Promise(r => server.listen(port || 0, '127.0.0.1', () => r(server.address().port))), close: () => new Promise(r => server.close(r)) };
}
module.exports = { createMock };

if (require.main === module) {
  const port = Number(process.env.MOCK_PORT || 8181), m = createMock({ token: process.env.MOCK_TOKEN, visible: process.env.MOCK_VISIBLE ? Number(process.env.MOCK_VISIBLE) : undefined });
  m.listen(port).then(p => {
    console.log('Mock REDCap API listening on http://127.0.0.1:' + p + '/api/');
    console.log('Token: ' + m.token + '   (55 test records built from the 3 Nov dictionary)');
    console.log('To use it:  REDCAP_API_URL=http://127.0.0.1:' + p + '/api/  REDCAP_API_TOKEN=' + m.token + '  npm start');
    console.log('Release records gradually:  curl -X POST http://127.0.0.1:' + p + '/__control -d \'{"visible":20}\'');
  });
}
