/* Shows which data the dashboard is using, on every page. */
(function () {
  function fmt(iso) { try { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso || ''; } }
  function render(s) {
    var live = s.data && s.data.serving === 'live', cur = s.data && s.data.current;
    var b = document.getElementById('liveBadge');
    if (b) { b.textContent = live ? 'Live data' : 'Test data'; b.classList.toggle('live', !!live); b.title = live && cur ? 'REDCap data saved ' + fmt(cur.createdAt) : 'Generated test data. No REDCap data imported yet.'; }
    var d = document.getElementById('dashStatus');
    if (d) d.textContent = live && cur ? 'Live data from REDCap, updated ' + fmt(cur.createdAt) + (s.sync.nextScheduled ? ' · next check ' + fmt(s.sync.nextScheduled) : '') : 'Showing generated test data. Live data appears here as soon as the first REDCap sync or upload succeeds.';
    var h = document.getElementById('homeTag'); if (h) h.textContent = live ? 'Live data' : 'Test data';
  }
  function go() { fetch('/api/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(render).catch(function () { /* offline: leave defaults */ }); }
  go(); setInterval(go, 30000);
})();
