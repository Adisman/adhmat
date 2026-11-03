#!/usr/bin/env node
'use strict';
const { createApp } = require('./src/app');
const app = createApp();
app.start().then(addr => {
  const url = 'http://' + (addr.address === '0.0.0.0' ? 'localhost' : addr.address) + ':' + addr.port;
  const c = app.cfg, m = app.model;
  console.log('\n  ADHMAT platform is running');
  console.log('  Website          ' + url + '/');
  console.log('  Dashboard        ' + url + '/dashboard/');
  console.log('  Data & pipeline  ' + url + '/admin.html');
  console.log('  Dictionary       ' + m.questions.length + ' questions, ' + m.countries.length + ' Member States (' + m.source + ')');
  console.log('  REDCap           ' + (c.redcap.url && c.secrets.redcapToken ? 'configured, sync ' + (c.sync.enabled ? 'every ' + c.sync.intervalMinutes + ' min' + (c.sync.atTimes.length ? ' + at ' + c.sync.atTimes.join(', ') : '') : 'disabled') : 'not configured yet (copy .env.example to .env). Test data is served meanwhile.'));
  if (app.auth.admin.generated) console.log('\n  First start: your admin key is\n    ' + app.auth.admin.value + '\n  It is saved in ' + c.storage.dir + '/admin.key. Keep it private.');
  console.log('');
});
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { app.stop().then(() => process.exit(0)); }));
