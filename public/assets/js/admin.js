/* Data & pipeline page. All text is written with textContent; nothing from the server is inserted as HTML. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var key = ''; try { key = sessionStorage.getItem('adhmat.admin') || ''; } catch (e) { /* ignore */ }
  var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  var fmt = function (iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } };

  function api(path, opt) {
    opt = opt || {}; var h = opt.headers || {}; if (opt.admin !== false && key) h['X-Admin-Key'] = key;
    return fetch(path, { method: opt.method || 'GET', headers: h, body: opt.body, cache: 'no-store' }).then(function (r) {
      return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ } return { status: r.status, ok: r.ok, json: j, text: t }; });
    });
  }

  /* ---------- public status ---------- */
  function card(title, big, line) { var c = el('div', 'card stat-card'); c.appendChild(el('h3', null, title)); c.appendChild(el('div', 'big', big)); if (line) c.appendChild(el('p', null, line)); return c; }
  function status() {
    api('/api/status', { admin: false }).then(function (r) {
      var s = r.json; if (!s) return; var host = $('statusCards'); host.replaceChildren();
      var live = s.data.serving === 'live', cur = s.data.current;
      host.appendChild(card('Dashboard is showing', live ? 'Live data' : 'Test data', live && cur ? 'Saved ' + fmt(cur.createdAt) + ' · ' + cur.recordsUsed + ' record(s), ' + cur.completeM1 + ' with ADHMAT complete' : 'No REDCap data has been imported yet.'));
      var sy = s.sync;
      host.appendChild(card('Last REDCap sync', sy.lastSuccess ? fmt(sy.lastSuccess) : (sy.configured ? 'Not yet' : 'Not connected'), sy.lastError ? 'Last error: ' + sy.lastError : (sy.configured ? (sy.enabled ? 'Every ' + sy.intervalMinutes + ' min' + (sy.atTimes.length ? ' and at ' + sy.atTimes.join(', ') : '') + (sy.nextScheduled ? ' · next ' + fmt(sy.nextScheduled) : '') : 'Scheduled sync is switched off') : 'Set REDCAP_API_URL and REDCAP_API_TOKEN in .env, then restart.')));
      var d = s.dictionary;
      host.appendChild(card('Data dictionary', d.questions + ' questions', d.countries + ' Member States · ' + d.file + (d.warnings ? ' · ' + d.warnings + ' warning(s)' : '')));
      var n = $('m2note'); n.hidden = d.structuredModule2; if (!d.structuredModule2) { n.replaceChildren(); var b = el('strong', null, 'Module 2. '); n.appendChild(b); n.appendChild(document.createTextNode('In this dictionary Module 2 (Qualitative Insights) is narrative text with evidence uploads. The structured charts for initiative stage, barriers and support sources have no data source and show “not captured”. Narrative progress, consent, follow-up and evidence uploads are shown. Narrative text is never copied from REDCap.')); }
    });
  }

  /* ---------- admin ---------- */
  function unlock(ok, msg) { $('adminArea').hidden = !ok; $('keyMsg').textContent = msg || ''; $('keyMsg').className = ok ? 'ok' : 'bad'; if (ok) refresh(); }
  function tryKey() {
    if (!key) return;
    api('/api/admin/info').then(function (r) {
      if (r.ok) { try { sessionStorage.setItem('adhmat.admin', key); } catch (e) { /* ignore */ } unlock(true, 'Unlocked'); info(r.json); }
      else { key = ''; try { sessionStorage.removeItem('adhmat.admin'); } catch (e) { /* ignore */ } unlock(false, r.status === 429 ? 'Too many attempts. Wait a minute.' : 'That key was not accepted.'); }
    });
  }
  function info(i) {
    $('hookUrl').value = i.webhookUrl;
    var c = i.config; $('cfgInfo').textContent = (c.redcapConfigured ? 'REDCap: ' + c.redcapUrl : 'REDCap is not configured yet') + '. Data folder: ' + i.dataDir + '. Listening on ' + i.host + ':' + i.port + '.';
  }
  function refresh() { snapshots(); history(); dictionary(); status(); radios(); }

  function snapshots() {
    api('/api/snapshots').then(function (r) {
      var tb = $('snapTbl').tBodies[0]; tb.replaceChildren(); var l = r.json || [];
      if (!l.length) { var tr = el('tr'); var td = el('td', null, 'No snapshots yet. Run a sync or upload a REDCap export.'); td.colSpan = 6; tr.appendChild(td); tb.appendChild(tr); return; }
      l.forEach(function (s) {
        var tr = el('tr', s.active ? 'act' : ''); tr.appendChild(el('td', null, fmt(s.createdAt)));
        tr.appendChild(el('td', null, (s.source === 'redcap-api' ? 'REDCap API' : 'Upload') + (s.trigger && s.source === 'redcap-api' ? ' (' + s.trigger + ')' : '')));
        tr.appendChild(el('td', null, String(s.recordsUsed == null ? '—' : s.recordsUsed))); tr.appendChild(el('td', null, String(s.completeM1 == null ? '—' : s.completeM1))); tr.appendChild(el('td', null, String(s.completeBoth == null ? '—' : s.completeBoth)));
        var t = el('td'); if (s.active) t.appendChild(el('span', 'pill', 'On the dashboard')); else { var b = el('button', 'btn btn-outline', 'Use this'); b.type = 'button'; b.addEventListener('click', function () { if (confirm('Show this snapshot on the dashboard?')) api('/api/snapshots/' + s.id + '/activate', { method: 'POST' }).then(refresh); }); t.appendChild(b); }
        tr.appendChild(t); tb.appendChild(tr);
      });
    });
  }
  function history() {
    api('/api/sync/history?n=30').then(function (r) {
      var tb = $('histTbl').tBodies[0]; tb.replaceChildren(); var l = r.json || [];
      if (!l.length) { var tr = el('tr'); var td = el('td', null, 'Nothing has run yet.'); td.colSpan = 4; tr.appendChild(td); tb.appendChild(tr); return; }
      l.forEach(function (h) {
        var tr = el('tr'); tr.appendChild(el('td', null, fmt(h.at)));
        tr.appendChild(el('td', null, h.type === 'sync' ? 'Sync (' + h.reason + ')' : h.type === 'webhook' ? 'REDCap trigger' : h.type === 'upload' ? 'Upload' : h.type === 'activate' ? 'Snapshot restored' : h.type === 'dictionary' ? 'Dictionary' : h.type));
        var rt = el('td'); rt.appendChild(el('span', 'pill ' + (h.ok ? '' : 'err'), h.ok ? (h.changed === false ? 'No change' : 'OK') : 'Failed')); tr.appendChild(rt);
        var d = el('td'); var parts = [];
        if (h.error) parts.push(h.error);
        if (h.records != null) parts.push(h.records + ' record(s), ' + (h.completeM1 == null ? '?' : h.completeM1) + ' ADHMAT complete');
        if (h.warningCount) parts.push(h.warningCount + ' warning(s)');
        if (h.file) parts.push(h.file);
        if (h.record) parts.push('record ' + h.record);
        d.textContent = parts.join(' · ');
        (h.steps || []).filter(function (x) { return x.changed; }).forEach(function (x) { d.appendChild(el('div', 'small', x.note)); });
        if (h.warnings && h.warnings.length) { var det = el('details'); det.appendChild(el('summary', 'small', 'Show warnings')); var u = el('ul'); h.warnings.forEach(function (w) { u.appendChild(el('li', 'small', w)); }); det.appendChild(u); d.appendChild(det); }
        tr.appendChild(d); tb.appendChild(tr);
      });
    });
  }
  function dictionary() {
    api('/api/dictionary/summary', { admin: false }).then(function (r) {
      var s = r.json, h = $('dictInfo'); if (!s) return; h.replaceChildren();
      h.appendChild(el('h3', null, 'Loaded dictionary')); h.appendChild(el('p', 'small', s.source + ' · fingerprint ' + s.sha256.slice(0, 12)));
      var ul = el('ul'); var dom = s.questionsByDomain, names = s.domains;
      Object.keys(dom).forEach(function (k) { ul.appendChild(el('li', null, (names[k] || k) + ': ' + dom[k] + ' questions')); });
      ul.appendChild(el('li', null, s.subdomains + ' sub-domains, ' + s.countries + ' Member States, ' + s.priorityQuestions.length + ' priority questions with document upload'));
      ul.appendChild(el('li', null, 'Levels: ' + s.levels.slice().reverse().map(function (l) { return 'L' + l.level + ' from ' + l.min + '%'; }).join(', ')));
      ul.appendChild(el('li', null, 'Module 2: ' + s.module2.narrativeQuestions + ' narrative questions, ' + s.module2.evidenceSlots.length + ' evidence slots, ' + s.module2.structuredFields + ' structured fields'));
      ul.appendChild(el('li', null, s.exportFieldCount + ' fields are requested from REDCap (no personal contact fields)'));
      h.appendChild(ul);
      if (s.warnings.length) { h.appendChild(el('p', 'bad', 'Warnings')); var w = el('ul'); s.warnings.forEach(function (x) { w.appendChild(el('li', 'small', x)); }); h.appendChild(w); }
    });
  }
  function radios() {
    api('/api/status', { admin: false }).then(function (r) {
      var v = r.json && r.json.data.preferred; document.querySelectorAll('#srcRadios input').forEach(function (i) { i.checked = i.value === v; });
    });
  }

  /* ---------- actions ---------- */
  function out(node, ok, lines, extra) {
    node.hidden = false; node.replaceChildren(); node.appendChild(el('div', ok ? 'ok' : 'bad', lines[0]));
    if (lines.length > 1) { var u = el('ul'); lines.slice(1).forEach(function (l) { u.appendChild(el('li', null, l)); }); node.appendChild(u); }
    if (extra) node.appendChild(extra);
  }
  function reportLines(rep) {
    var l = []; if (!rep) return l;
    l.push('Records read: ' + rep.recordsRead + ' · used: ' + rep.recordsUsed + ' · question columns found: ' + rep.columnsFound + ' of ' + rep.columnsExpected);
    if (rep.completeM1 != null) l.push('ADHMAT complete: ' + rep.completeM1 + ' · both modules complete: ' + rep.completeBoth);
    (rep.info || []).forEach(function (x) { l.push(x); });
    (rep.errors || []).forEach(function (x) { l.push('Error: ' + x); });
    (rep.warnings || []).slice(0, 12).forEach(function (x) { l.push('Warning: ' + x); });
    if ((rep.warnings || []).length > 12) l.push((rep.warnings.length - 12) + ' more warning(s).');
    return l;
  }
  $('keyForm').addEventListener('submit', function (e) { e.preventDefault(); key = $('adminKey').value.trim(); tryKey(); });
  $('syncNow').addEventListener('click', function () {
    var b = this, o = $('syncOut'); b.disabled = true; o.hidden = false; o.textContent = 'Reading REDCap…';
    api('/api/sync', { method: 'POST' }).then(function (r) {
      b.disabled = false; var j = r.json || {}, e = j.entry;
      o.textContent = (j.ok ? (j.changed ? 'Done. New data published to the dashboard.' : 'Done. REDCap has no new data since the last snapshot.') : 'Failed: ' + (j.error || r.text)) + (e && e.steps ? '\n' + e.steps.map(function (s) { return '• ' + s.note; }).join('\n') : '') + (e && e.warningCount ? '\n' + e.warningCount + ' warning(s), see the history below.' : '');
      refresh();
    });
  });
  $('testConn').addEventListener('click', function () {
    var o = $('syncOut'); o.hidden = false; o.textContent = 'Contacting REDCap…';
    api('/api/admin/redcap-test', { method: 'POST' }).then(function (r) { var j = r.json || {}; o.textContent = j.ok ? 'Connected. REDCap version ' + j.redcapVersion + (j.project && j.project.title ? ' · project: ' + j.project.title : '') : 'Not connected: ' + (j.error || r.text); });
  });

  var upText = '', upName = '';
  $('upFile').addEventListener('change', function () {
    var f = this.files[0]; $('upCheck').disabled = !f; $('upImport').disabled = true; $('upOut').hidden = true; if (!f) return;
    upName = f.name; f.text().then(function (t) { upText = t; });
  });
  $('upCheck').addEventListener('click', function () {
    api('/api/ingest?dry=1&name=' + encodeURIComponent(upName), { method: 'POST', body: upText, headers: { 'content-type': 'text/csv' } }).then(function (r) {
      var j = r.json || {}, rep = j.report; var ok = !!j.ok;
      out($('upOut'), ok, [ok ? 'The file can be imported.' : (j.error || 'The file cannot be imported.')].concat(reportLines(rep)));
      $('upImport').disabled = !ok;
    });
  });
  $('upImport').addEventListener('click', function () {
    if (!confirm('Replace what the dashboard shows with this file?')) return;
    api('/api/ingest?name=' + encodeURIComponent(upName), { method: 'POST', body: upText, headers: { 'content-type': 'text/csv' } }).then(function (r) {
      var j = r.json || {}; out($('upOut'), !!j.ok, [j.ok ? 'Imported. The dashboard now shows this data.' : (j.error || 'Import failed.')].concat(reportLines(j.report))); $('upImport').disabled = true; refresh();
    });
  });
  document.querySelectorAll('#srcRadios input').forEach(function (i) {
    i.addEventListener('change', function () { api('/api/source', { method: 'POST', body: JSON.stringify({ preferred: i.value }) }).then(function (r) { $('srcMsg').textContent = r.ok ? 'Saved.' : 'Could not save.'; $('srcMsg').className = r.ok ? 'ok' : 'bad'; status(); }); });
  });
  $('copyHook').addEventListener('click', function () { var i = $('hookUrl'); i.select(); try { navigator.clipboard.writeText(i.value); } catch (e) { document.execCommand('copy'); } this.textContent = 'Copied'; var b = this; setTimeout(function () { b.textContent = 'Copy'; }, 1500); });

  var dText = '';
  $('dictFile').addEventListener('change', function () { var f = this.files[0]; $('dictCheck').disabled = !f; $('dictUse').disabled = true; $('dictOut').hidden = true; if (f) f.text().then(function (t) { dText = t; }); });
  function dictLines(j) {
    var l = []; if (j.summary) l.push(j.summary.questions + ' questions · ' + j.summary.countries + ' Member States · ' + j.summary.subdomains + ' sub-domains');
    if (j.diff) { l.push('Added: ' + (j.diff.added.length ? j.diff.added.slice(0, 12).join(', ') + (j.diff.added.length > 12 ? '…' : '') : 'none')); l.push('Removed: ' + (j.diff.removed.length ? j.diff.removed.slice(0, 12).join(', ') + (j.diff.removed.length > 12 ? '…' : '') : 'none')); l.push('Fields with changed choices: ' + j.diff.changedChoices.length); }
    (j.errors || []).forEach(function (x) { l.push('Error: ' + x); }); return l;
  }
  $('dictCheck').addEventListener('click', function () {
    api('/api/dictionary?dry=1', { method: 'POST', body: dText, headers: { 'content-type': 'text/csv' } }).then(function (r) { var j = r.json || {}; out($('dictOut'), !!j.ok, [j.ok ? 'This dictionary can be used.' : (j.error || 'This is not a usable ADHMAT dictionary.')].concat(dictLines(j))); $('dictUse').disabled = !j.ok; });
  });
  $('dictUse').addEventListener('click', function () {
    if (!confirm('Use this dictionary for all future imports?')) return;
    api('/api/dictionary', { method: 'POST', body: dText, headers: { 'content-type': 'text/csv' } }).then(function (r) { var j = r.json || {}; out($('dictOut'), !!j.ok, [j.ok ? 'Dictionary updated.' : 'Could not update.'].concat(dictLines(j))); $('dictUse').disabled = true; refresh(); });
  });

  status(); setInterval(status, 30000);
  if (key) tryKey();
})();
