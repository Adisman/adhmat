'use strict';
/* Minimal RFC 4180 CSV reader/writer. Handles BOM, quoted fields, embedded commas and line breaks. */
function parse(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0, n = text.length; i < n; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}
function parseObjects(text) {
  const rows = parse(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map(h => h.trim());
  const records = rows.slice(1).map(r => { const o = {}; headers.forEach((h, k) => { o[h] = r[k] === undefined ? '' : r[k]; }); return o; });
  return { headers, records };
}
const esc = v => { v = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
function stringify(headers, records) {
  return '﻿' + [headers.map(esc).join(',')].concat(records.map(r => headers.map(h => esc(r[h])).join(','))).join('\r\n') + '\r\n';
}
module.exports = { parse, parseObjects, stringify };
