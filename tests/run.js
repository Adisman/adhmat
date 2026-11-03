'use strict';
/* Runs every *.test.js with Node's built-in test runner (works on Node 18+ and on Windows). */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).map(f => path.join(__dirname, f));
const r = spawnSync(process.execPath, ['--test'].concat(files), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
