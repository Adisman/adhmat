#!/usr/bin/env node
'use strict';
/* Builds _site/ : a static, test-data-only copy of the website for GitHub Pages.
 * There is no server on GitHub Pages, so REDCap sync, upload and admin actions are not available there;
 * run `node server.js` locally for the live pipeline. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_site');
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'test', 'test-datasets.json'), 'utf8'));
const payload = { meta: Object.assign({}, t.meta, { test: true, source: 'test', static: true }), datasets: t.datasets };
fs.writeFileSync(path.join(OUT, 'data', 'test-data.json'), JSON.stringify(payload));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

/* the test CSV link and admin page need the server: point them at the README instead of a dead link */
for (const f of fs.readdirSync(OUT).filter(x => x.endsWith('.html'))) {
  const p = path.join(OUT, f); let h = fs.readFileSync(p, 'utf8');
  h = h.replace('href="/api/test/redcap-export.csv"', 'href="https://github.com/Adisman/adhmat#readme"');
  if (f === 'index.html' || f === 'dashboard.html') h = h.replace('</body>', '<p style="text-align:center;font:13px system-ui;padding:10px;color:#555">Static preview with generated test data. The live REDCap pipeline runs on the local server (see the README).</p></body>');
  fs.writeFileSync(p, h);
}
console.log('Static site written to ' + OUT);
