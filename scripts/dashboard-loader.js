/* ADHMAT dashboard data loader.
 * Replaces the standalone file's built-in loader. Same window.dash contract (calc, onData, data, setLink),
 * but data comes from the local ADHMAT server (/api/data) and refreshes when the server has new data. */
(function () {
  'use strict';
  var loaded = false, calcs = {}, cache = {}, cbs = [], raw = {}, lastEtag = null, es = null, pollTimer = null, debounce = null, liveAvailable = null, pollSeconds = 60;
  var RAWIDS = ['countries', 'module2', 'subdomains', 'answers', 'questions'];
  var src = { test: false, source: '', label: '', meta: null, fallback: false };
  var $ = function (id) { return document.getElementById(id); };
  function pref() {
    try { var q = new URLSearchParams(location.search).get('source'); if (q === 'live' || q === 'test' || q === 'auto') return q; } catch (e) { /* ignore */ }
    try { var s = localStorage.getItem('adhmat.source'); if (s === 'live' || s === 'test') return s; } catch (e) { /* storage may be blocked */ }
    return 'auto';
  }
  function fmtTime(iso) { try { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso || ''; } }

  window.dash = {
    calc: function (id, o) { calcs[id] = o; },
    onData: function (f) { cbs.push(f); if (loaded) { try { f(); } catch (e) { console.error(e); } } },
    setLink: function (n) { try { history.replaceState(null, '', location.pathname + location.search + '#' + n); } catch (e) { /* ignore */ } },
    data: function (id) {
      if (!loaded) return { status: 'loading', data: [] };
      if (raw[id]) return { status: 'ok', data: raw[id] };
      var o = calcs[id]; if (!o) return { status: 'missing', data: [] };
      if (!cache[id]) { var self = window.dash; cache[id] = o.fn.apply(null, o.inputs.map(function (i) { return self.data(i).data; })); }
      return { status: 'ok', data: cache[id] };
    },
    src: src, totalQ: 373,
    tag: function () { return src.test ? ' · test data' : ''; }
  };

  function paint() {
    var cs = raw.countries || [], started = cs.filter(function (c) { return c.m1_status !== 'Not started' || c.m2_status !== 'Not started'; }).length;
    var m1 = cs.filter(function (c) { return c.m1_status === 'Complete'; }).length, both = cs.filter(function (c) { return c.status === 'Complete'; }).length;
    var pill = $('srcPill'); if (pill) pill.textContent = src.test ? 'Test data' : 'Live · REDCap';
    var note = $('sample-note');
    if (note) {
      note.replaceChildren(); note.classList.toggle('live', !src.test);
      var b = document.createElement('b'); b.textContent = src.test ? 'Test data. ' : 'REDCap data. '; note.appendChild(b);
      var t = document.createElement('span');
      if (src.test) t.textContent = 'Every score, level and answer on this page is generated to test the dashboard for all ' + cs.length + ' Member States. It is not a real assessment result.' + (src.fallback ? ' No REDCap data has been imported yet, so the test data is shown.' : '');
      else t.textContent = 'Updated ' + fmtTime(src.meta.generatedAt) + '. ' + started + ' of ' + cs.length + ' Member States have started, ' + m1 + ' completed ADHMAT and ' + both + ' completed both modules. This page refreshes by itself when new data arrives.';
      note.appendChild(t);
    }
    var av = $('aboutVersion');
    if (av) av.textContent = src.test ? 'The figures shown now are generated test data for the 55 Member States. They check the layout, filters and map and are not real results. Switch to Live to see data imported from REDCap.' : 'The figures shown now come from the REDCap project through the ADHMAT server. Scores are recalculated from the answers using the project data dictionary, and match the calculations in the REDCap form.';
    var bl = $('srcLive'), bt = $('srcTest');
    if (bl && bt) {
      bl.setAttribute('aria-pressed', String(!src.test)); bt.setAttribute('aria-pressed', String(src.test));
      bl.disabled = liveAvailable === false; bl.title = liveAvailable === false ? 'No REDCap data has been imported yet' : 'Show data imported from REDCap';
    }
    document.title = 'State of Digital Health – Country Insights' + (src.test ? ' (test data)' : '');
  }
  function conn(ok, msg) { var c = $('conn'); if (!c) return; c.hidden = ok; c.textContent = ok ? '' : (msg || 'Connection to the server lost. Showing the last data received.'); }

  function apply(p) {
    raw = {}; RAWIDS.forEach(function (i) { raw[i] = p.datasets[i] || []; });
    cache = {}; src.meta = p.meta; src.test = !!p.meta.test; src.source = p.meta.source; src.label = src.test ? 'test data' : 'REDCap data';
    window.dash.totalQ = raw.questions.length || 373;
    loaded = true; paint();
    var ac = $('ac'); if (ac) ac.classList.remove('pre');
    cbs.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
  }
  function fail(msg) {
    var m = $('loadMsg'); if (m) m.textContent = 'The dashboard could not load its data: ' + msg;
    var b = $('loadSample'); if (b) b.hidden = false;
  }
  function load() {
    var want = pref(); src.fallback = false;
    return fetch('/api/data?source=' + want, { cache: 'no-cache' }).then(function (r) {
      if (r.status === 404 && want === 'live') { src.fallback = true; liveAvailable = false; return fetch('/api/data?source=test', { cache: 'no-cache' }); }
      return r;
    }).catch(function () { return { ok: false, status: 0 }; }).then(function (r) {
      /* Static copy (GitHub Pages) has no server: use the bundled test data. */
      if (!r.ok) { src.fallback = want === 'live'; liveAvailable = false; return fetch(new URL('../data/test-data.json', location.href).href, { cache: 'no-cache' }); }
      return r;
    }).then(function (r) {
      if (!r.ok) throw new Error('the data answered ' + r.status);
      var et = (r.headers.get('etag') || r.headers.get('last-modified') || 'static') + (src.fallback ? '#f' : '');
      if (loaded && et === lastEtag) return null;
      lastEtag = et; return r.json();
    }).then(function (p) { if (p) apply(p); conn(true); }).catch(function (e) { if (!loaded) fail(e.message); else conn(false); });
  }
  function status() {
    return fetch('/api/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
      liveAvailable = !!(s.data && s.data.liveAvailable);
      if (s.redcap && s.redcap.client && s.redcap.client.pollSeconds) pollSeconds = s.redcap.client.pollSeconds;
      if (loaded) paint();
    }).catch(function () { /* status is optional */ });
  }
  function watch() {
    try {
      es = new EventSource('/api/events');
      es.addEventListener('data', function () { clearTimeout(debounce); debounce = setTimeout(function () { status().then(load); }, 400); });
      es.onerror = function () { /* the browser reconnects; polling covers gaps */ };
    } catch (e) { /* no EventSource: polling only */ }
    clearInterval(pollTimer);
    pollTimer = setInterval(function () { if (!document.hidden) status().then(load); }, Math.max(15, pollSeconds) * 1000);
  }
  function choose(s) { try { localStorage.setItem('adhmat.source', s); } catch (e) { /* ignore */ } lastEtag = null; load(); }

  document.addEventListener('DOMContentLoaded', function () {
    var ac = $('ac'); if (ac) ac.classList.add('pre');
    var retry = $('loadSample'); if (retry) retry.addEventListener('click', function () { var m = $('loadMsg'); if (m) m.textContent = 'Loading…'; load(); });
    var bl = $('srcLive'), bt = $('srcTest');
    if (bl) bl.addEventListener('click', function () { choose('live'); });
    if (bt) bt.addEventListener('click', function () { choose('test'); });
    var tb = document.createElement('button'); tb.type = 'button'; tb.className = 'btn'; tb.id = 'themeBtn'; tb.textContent = 'Dark mode';
    tb.addEventListener('click', function () { var h = document.documentElement, d = h.getAttribute('data-theme') !== 'dark'; h.setAttribute('data-theme', d ? 'dark' : 'light'); tb.textContent = d ? 'Light mode' : 'Dark mode'; });
    $('fbarExtra').appendChild(tb);
    status().then(load).then(watch);
  });
})();
