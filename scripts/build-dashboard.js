#!/usr/bin/env node
'use strict';
/* Builds public/dashboard/index.html from the attached standalone dashboard (design unchanged):
 *  - extracts the embedded generated data into data/test/test-datasets.json (the Test data source)
 *  - removes the embedded data blocks and the built-in loader; the page now reads /api/data
 *  - makes a few labels dynamic (test / live) and the Module 2 views safe for narrative-only data */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'scripts', 'source', 'State_of_Digital_Health_Dashboard_Standalone_4.html');
let h = fs.readFileSync(SRC, 'utf8');
const must = (cond, msg) => { if (!cond) { console.error('BUILD FAILED: ' + msg); process.exit(1); } };
function rep(from, to, count) {
  const parts = h.split(from); must(parts.length - 1 === (count || 1), 'expected ' + (count || 1) + ' occurrence(s) of: ' + from.slice(0, 70) + ' (found ' + (parts.length - 1) + ')');
  h = parts.join(to);
}

/* 1. extract test datasets */
const ids = ['countries', 'module2', 'subdomains', 'answers', 'questions'], ds = {};
ids.forEach(i => {
  const re = new RegExp('<script type="application/json" id="d-' + i + '">([\\s\\S]*?)</script>');
  const m = re.exec(h); must(m, 'data block ' + i); ds[i] = JSON.parse(m[1]); h = h.replace(re, '');
});
fs.mkdirSync(path.join(ROOT, 'data', 'test'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'test', 'test-datasets.json'), JSON.stringify({ meta: { generatedAt: '2026-10-23T11:50:00Z', note: 'Generated test data (55 Member States) from the State of Digital Health dashboard design v4.' }, datasets: ds }));

/* 2. replace the built-in loader with the server loader */
const a = h.indexOf('<script>(function(){\n  var loaded=false,calcs={}'); must(a > 0, 'loader start');
const b = h.indexOf('</script>', a); must(b > a, 'loader end');
h = h.slice(0, a) + '<script src="loader.js"></script>' + h.slice(b + '</script>'.length);

/* 3. header, loading state, banner */
rep('<span class="ac-pill">Sample data</span><button class="loadbtn small" id="loadSample2" type="button" hidden>Reload sample data</button>',
  '<span class="ac-pill" id="srcPill">Loading</span><span class="srcsw" role="group" aria-label="Data source"><button type="button" id="srcLive" aria-pressed="false">Live</button><button type="button" id="srcTest" aria-pressed="false">Test data</button></span>');
h = h.replace(/<section class="welcome" id="welcome">[\s\S]*?<\/section>/, '<section class="welcome" id="welcome"><h2>Loading the dashboard</h2><p>Reading the latest data from the ADHMAT server.</p><button class="loadbtn" id="loadSample" type="button" hidden>Try again</button><p class="sub" id="loadMsg" role="status"></p></section>');
h = h.replace(/<div class="ac-note" id="sample-note">[\s\S]*?<\/div>/, '<div id="conn" role="status" hidden></div><div class="ac-note" id="sample-note"></div>');
must(h.indexOf('id="sample-note"') > 0 && h.indexOf('id="conn"') > 0, 'banner');

/* 4. wording that depended on sample data */
rep("tip.appendChild(el('div', 'rg', 'Click for details · sample data'));", "tip.appendChild(el('div', 'rg', 'Click for details' + dash.tag()));");
rep("note: 'Sample data' + (S.cf ? '' : ''),", "note: (dash.src.test ? 'Test data' : 'REDCap data'),");
rep("c.region + ' Africa · sample data'", "c.region + ' Africa' + dash.tag()");
rep("'Based on ' + kRowDone() + ' countries with a completed questionnaire (sample data).'", "'Based on ' + kRowDone() + ' countries with a completed questionnaire' + dash.tag() + '.'");
rep('<p>All figures here come from sample data generated for the 55 Member States to test the layout, filters and map. When real survey data is available, the same views will read from it.</p>', '<p id="aboutVersion"></p>');
rep(" of 373 (' + c.completion_pct", " of ' + dash.totalQ + ' (' + c.completion_pct", 2);
rep("c.region + ' Africa · ' + c.population_m + ' M people'", "c.region + ' Africa' + (c.population_m == null ? '' : ' · ' + c.population_m + ' M people')");
rep("kv('Population', c.population_m + ' million'); kv('Health facilities', String(c.facilities)); kv('Urban population', c.urban_pct + '%');",
  "kv('Population', c.population_m == null ? '—' : c.population_m + ' million'); kv('Health facilities', c.facilities == null ? '—' : String(c.facilities)); kv('Urban population', c.urban_pct == null ? '—' : c.urban_pct + '%');", 2);

/* 5. Module 2: the 3 Nov REDCap form holds narrative text only, so structured answers may be absent */
rep("add('Featured initiative', m2.init_status); add('Primary care example', m2.phc_area + ' · ' + m2.phc_stage);\n      add('Barriers', [m2.barrier_1, m2.barrier_2, m2.barrier_3].map(function (x) { return trunc(x, 32); }));\n      add('Emerging', m2.emerging.split('|')); add('Support from', m2.support_from.split('|')); add('Evidence cited',",
  "if (m2.init_status) { add('Featured initiative', m2.init_status); add('Primary care example', m2.phc_area + ' · ' + m2.phc_stage);\n      add('Barriers', [m2.barrier_1, m2.barrier_2, m2.barrier_3].map(function (x) { return trunc(x, 32); }));\n      add('Emerging', (m2.emerging || '').split('|')); add('Support from', (m2.support_from || '').split('|')); } else if (m2.m2_total) add('Narrative answers', m2.m2_answered + ' of ' + m2.m2_total);\n      add('Evidence cited',");
rep("add('Use of answers', m2.consent);\n      s6.appendChild(kvl);", "add('Use of answers', m2.consent || '—'); if (m2.contact_ok) add('Follow-up contact', m2.contact_ok); if (m2.case_study_ok) add('Case study', m2.case_study_ok);\n      s6.appendChild(kvl);");
rep("add('Featured initiative', m2.init_status); add('Primary care example', m2.phc_area + ' · ' + m2.phc_stage);\n      add('Main barriers', [m2.barrier_1, m2.barrier_2, m2.barrier_3].map(function (x) { return trunc(x, 34); }));\n      add('Response to barriers', m2.barrier_response); add('Emerging', m2.emerging.split('|')); add('Success factors', m2.factors.split('|')); add('Support expected from', m2.support_from.split('|'));",
  "if (m2.init_status) { add('Featured initiative', m2.init_status); add('Primary care example', m2.phc_area + ' · ' + m2.phc_stage);\n      add('Main barriers', [m2.barrier_1, m2.barrier_2, m2.barrier_3].map(function (x) { return trunc(x, 34); }));\n      add('Response to barriers', m2.barrier_response); add('Emerging', (m2.emerging || '').split('|')); add('Success factors', (m2.factors || '').split('|')); add('Support expected from', (m2.support_from || '').split('|')); } else if (m2.m2_total) add('Narrative answers', m2.m2_answered + ' of ' + m2.m2_total);");
rep("add('Data use', m2.consent); eh.appendChild(kvl);", "add('Data use', m2.consent || '—'); eh.appendChild(kvl);");

/* m2_counts: add narrative progress counts (all countries that have started) */
rep("        add('done', 'completed', 1);\n      });", "        add('done', 'completed', 1);\n      });\n      module2.forEach(function (r) { if (r.m2_total) { var n = r.m2_answered || 0; add('narr', n >= r.m2_total ? 'All ' + r.m2_total + ' answered' : n > 0 ? 'Some answered' : 'Not started', 1); } });");
/* empty-state wording and per-card options */
rep("if (!rs.length) { host.appendChild(el('div', 'empty-msg', 'No completed questionnaires yet.')); return; }",
  "if (!rs.length) { host.appendChild(el('div', 'empty-msg', o.empty || (kRowDone() > 0 && !dash.src.test ? 'Not captured in the current REDCap form (Module 2 is narrative text).' : 'No completed questionnaires yet.'))); return; }");
rep("countList($('#m_init'), 'init_status');", "countList($('#m_narr'), 'narr', { empty: 'No narrative answers yet.', names: {} }); countList($('#m_consent'), 'consent', { empty: 'No consent recorded yet.' }); countList($('#m_contact'), 'contact_ok', { empty: 'None yet.' }); countList($('#m_case'), 'case_study_ok', { empty: 'None yet.' });\n    countList($('#m_init'), 'init_status');");
rep('<div class="ac-grid" data-source="m2_counts">\n', '<div class="ac-grid" data-source="m2_counts">\n<div class="card s4"><h2>Narrative answers</h2><p class="sub">Qualitative Insights: how many of the narrative questions each country has answered.</p><div class="blist" id="m_narr"></div></div>\n<div class="card s4"><h2>Permission to use the answers</h2><p class="sub">How Africa CDC may use each country’s input.</p><div class="blist" id="m_consent"></div></div>\n<div class="card s4"><h2>Follow-up</h2><p class="sub">May the focal point be contacted, and may an example become a case study?</p><p class="m2-note" style="margin-top:0">Focal point may be contacted</p><div class="blist" id="m_contact"></div><p class="m2-note">Example may become a case study</p><div class="blist" id="m_case"></div></div>\n');
rep('<p class="foot">The free-text answers (developments, lessons, priority outcomes, support needs) are read and coded for the report. They are not charted here.</p>', '<p class="foot">The free-text answers (developments, lessons, priority outcomes, support needs) are read and coded for the report. They are not charted here and never leave REDCap.</p>');

rep("if (!list.length) bh.appendChild(el('div', 'empty-msg', 'No completed questionnaires yet.'));", "if (!list.length) bh.appendChild(el('div', 'empty-msg', kRowDone() > 0 && !dash.src.test ? 'Not captured in the current REDCap form (Module 2 is narrative text).' : 'No completed questionnaires yet.'));");
/* 6. styles and title */
rep('</head>', '<link rel="stylesheet" href="dashboard.css">\n</head>');
fs.writeFileSync(path.join(ROOT, 'public', 'dashboard', 'index.html'), h);
fs.copyFileSync(path.join(ROOT, 'scripts', 'dashboard-loader.js'), path.join(ROOT, 'public', 'dashboard', 'loader.js'));
fs.copyFileSync(path.join(ROOT, 'scripts', 'dashboard.css'), path.join(ROOT, 'public', 'dashboard', 'dashboard.css'));
console.log('dashboard built:', (h.length / 1024).toFixed(0) + ' KB; test data', ds.answers.length, 'answers,', ds.countries.length, 'countries');
