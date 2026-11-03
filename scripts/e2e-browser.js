#!/usr/bin/env node
'use strict';
/* Optional browser check (needs Playwright + Chromium): starts a mock REDCap and the server, then drives the site like a user.
 * Run:  node scripts/e2e-browser.js [screenshot-dir] */
const fs = require('fs'), path = require('path'), os = require('os');
const { createMock } = require('./mock-redcap');
const { createApp } = require('../src/app');
const { chromium } = require('playwright');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'adhmat-e2e-'));
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };

(async () => {
  const mock = createMock({ visible: 20 }), mport = await mock.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhmat-e2e-data-'));
  const app = createApp({ server: { host: '127.0.0.1', port: 0 }, redcap: { url: 'http://127.0.0.1:' + mport + '/api/', retries: 0 }, sync: { enabled: false }, storage: { dir } });
  app.cfg.secrets.redcapToken = mock.token; const addr = await app.start(); const base = 'http://127.0.0.1:' + addr.port, key = app.auth.admin.value;
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage(); const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));

  // 1. site pages and links
  const seen = new Set(), queue = ['/index.html'];
  while (queue.length) {
    const p = queue.shift(); if (seen.has(p)) continue; seen.add(p);
    const r = await page.goto(base + p); check(r.status() === 200, 'page ' + p + ' loads');
    const links = await page.$$eval('a[href],link[href],script[src],img[src]', els => els.map(e => e.getAttribute('href') || e.getAttribute('src')));
    for (const l of links) { if (!l || /^(#|mailto:|https?:)/.test(l)) continue; const u = new URL(l, base + p); const q = u.pathname + (u.pathname.endsWith('/') ? '' : ''); if (/\.html$/.test(q) && !seen.has(q)) queue.push(q); else if (!/\.html$/.test(q)) { const rr = await fetch(base + q); if (rr.status !== 200) check(false, 'link ' + l + ' on ' + p + ' -> ' + rr.status); } }
  }
  check(errs.length === 0, 'no console errors across site pages ' + JSON.stringify(errs));

  // 2. home + badge (test data before any sync)
  await page.goto(base + '/index.html'); await sleep(600);
  check((await page.textContent('#liveBadge')) === 'Test data', 'badge says Test data before the first sync');
  await page.screenshot({ path: out + '/01_home.png' });

  // 3. dashboard with test data
  await page.goto(base + '/dashboard.html'); const fr = page.frameLocator('iframe'); await fr.locator('#ac:not(.pre)').waitFor({ timeout: 8000 });
  check((await fr.locator('#srcPill').textContent()) === 'Test data', 'dashboard frame shows Test data');
  check(await fr.locator('#srcLive').isDisabled(), 'Live switch is disabled while no live data exists');
  await page.screenshot({ path: out + '/02_dashboard_test.png' });

  // 4. admin: unlock, sync, upload
  await page.goto(base + '/admin.html'); await page.fill('#adminKey', 'wrong'); await page.click('#keyForm button'); await sleep(500);
  check((await page.textContent('#keyMsg')).includes('not accepted'), 'wrong admin key is rejected');
  await page.fill('#adminKey', key); await page.click('#keyForm button'); await page.waitForSelector('#adminArea:not([hidden])');
  check((await page.inputValue('#hookUrl')).includes('/api/webhook/redcap?key='), 'webhook URL shown');
  await page.click('#testConn'); await page.waitForFunction(() => /Connected/.test(document.getElementById('syncOut').textContent)); check(true, 'REDCap connection test OK');
  await page.click('#syncNow'); await page.waitForFunction(() => /Done/.test(document.getElementById('syncOut').textContent), null, { timeout: 15000 });
  check((await page.textContent('#syncOut')).includes('20 record'), 'sync pulled the 20 visible records');
  await sleep(500); check((await page.textContent('#statusCards')).includes('Live data'), 'status card says Live data after sync');
  check((await page.locator('#snapTbl tbody tr').count()) === 1, 'one snapshot listed');
  await page.screenshot({ path: out + '/03_admin_after_sync.png', fullPage: true });
  const csvText = await (await fetch(base + '/api/test/redcap-export.csv')).text(); const f = path.join(out, 'upload.csv'); fs.writeFileSync(f, csvText);
  await page.setInputFiles('#upFile', f); await page.click('#upCheck'); await page.waitForFunction(() => /can be imported/.test(document.getElementById('upOut').textContent));
  check(true, 'upload check passes for the test export'); page.once('dialog', d => d.accept()); await page.click('#upImport'); await page.waitForFunction(() => /Imported/.test(document.getElementById('upOut').textContent)); check(true, 'upload imported');

  // 5. live dashboard + live refresh without reload
  const dp = await ctx.newPage(); const derrs = []; dp.on('console', m => { if (m.type() === 'error') derrs.push(m.text()); }); dp.on('pageerror', e => derrs.push('PAGEERROR ' + e.message));
  await dp.goto(base + '/dashboard/'); await dp.waitForSelector('#ac:not(.pre)'); await sleep(600);
  check((await dp.textContent('#srcPill')).includes('Live'), 'dashboard defaults to live data once it exists');
  check((await dp.textContent('#sample-note')).includes('REDCap data'), 'banner says REDCap data');
  await dp.screenshot({ path: out + '/04_dashboard_live.png' });
  for (const t of ['insights', 'compare', 'gaps', 'profile', 'evidence', 'input', 'about']) { await dp.click('[data-tab=' + t + ']'); await sleep(250); if (t === 'input' || t === 'profile') await dp.screenshot({ path: out + '/05_live_' + t + '.png', fullPage: true }); }
  check(derrs.length === 0, 'no console errors on the live dashboard through all tabs ' + JSON.stringify(derrs));
  await dp.selectOption('#cFilter', { index: 3 }); await dp.click('[data-tab=profile]'); await sleep(300);
  const before = await dp.textContent('#sample-note');
  await fetch('http://127.0.0.1:' + mport + '/__control', { method: 'POST', body: JSON.stringify({ visible: 35, set: { record: 2, field: 'q_a2_1', value: '0' } }) });
  const sync = await fetch(base + '/api/sync', { method: 'POST', headers: { 'x-admin-key': key } }); check(sync.status === 200, 'second sync after REDCap changed');
  await dp.waitForFunction(b => document.getElementById('sample-note').textContent !== b, before, { timeout: 8000 }); check(true, 'open dashboard refreshed by itself (no reload)');
  check(derrs.length === 0, 'no console errors after live refresh ' + JSON.stringify(derrs));
  await dp.click('#srcTest'); await dp.waitForFunction(() => /Test data/.test(document.getElementById('srcPill').textContent)); check(true, 'visitor can switch to Test data');
  await dp.click('#srcLive'); await dp.waitForFunction(() => /Live/.test(document.getElementById('srcPill').textContent)); check(true, 'and back to Live');
  // server stops: dashboard keeps its data and says so
  // 6. mobile
  const mp = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 }).then(c => c.newPage());
  await mp.goto(base + '/index.html'); await mp.screenshot({ path: out + '/06_mobile_home.png' }); const ov = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); check(!ov, 'home has no horizontal scroll at 390 px');
  await mp.goto(base + '/admin.html'); await mp.screenshot({ path: out + '/07_mobile_admin.png' }); check(!(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'admin has no horizontal scroll at 390 px');
  await mp.goto(base + '/dashboard/'); await sleep(800); await mp.screenshot({ path: out + '/08_mobile_dashboard.png' });

  await browser.close(); await app.stop(); await mock.close();
  console.log(failures ? failures + ' check(s) failed' : 'All browser checks passed'); console.log('Screenshots: ' + out); process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
