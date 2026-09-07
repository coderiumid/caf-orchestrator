/**
 * CAF-DASHBOARD-01 Task 6: the whole SPA as one string — vanilla JS, no
 * build step, no bundler, no framework, served directly by dashboard-ui.ts.
 * Talks only to Task 5's REST endpoints (/api/pipelines*) and Task 4's SSE
 * stream (/api/events/stream); both require the same basic auth this page
 * itself sits behind, so the browser's cached credentials cover every fetch
 * here automatically — no auth code needed in the page itself.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CAF Orchestrator — Pipeline Dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0f1115;
    --panel: #171a21;
    --border: #2a2e37;
    --text: #e6e8eb;
    --muted: #8b93a1;
    --accent: #5b8cff;
    --success: #3ecf8e;
    --warn: #f2b84b;
    --error: #f2635b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  #conn-status { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  #conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
  #conn-dot.live { background: var(--success); }
  #conn-dot.down { background: var(--error); }
  .filter-bar { display: flex; gap: 8px; align-items: center; }
  .filter-bar input {
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    min-width: 220px;
  }
  .filter-bar button {
    background: var(--accent);
    border: none;
    color: white;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  main { padding: 24px; display: grid; gap: 24px; grid-template-columns: 1fr; }
  @media (min-width: 1100px) {
    main.has-detail { grid-template-columns: 1.4fr 1fr; align-items: start; }
  }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; font-size: 13px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: rgba(255,255,255,0.03); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr.selected { background: rgba(91,140,255,0.12); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge.RUNNING { background: rgba(91,140,255,0.15); color: var(--accent); }
  .badge.SUCCESS { background: rgba(62,207,142,0.15); color: var(--success); }
  .badge.NEEDS_HUMAN { background: rgba(242,184,75,0.15); color: var(--warn); }
  .badge.ERROR { background: rgba(242,99,91,0.15); color: var(--error); }
  .muted { color: var(--muted); }
  .empty { padding: 32px; text-align: center; color: var(--muted); }
  #detail { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  #detail h2 { font-size: 14px; margin: 0 0 12px; }
  #detail .placeholder { color: var(--muted); font-size: 13px; }
  .timeline { list-style: none; margin: 0; padding: 0; }
  .timeline li { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .timeline li:last-child { border-bottom: none; }
  .timeline .t-head { display: flex; justify-content: space-between; gap: 8px; }
  .timeline .t-agent { font-weight: 600; }
  .timeline .t-time { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .timeline .t-meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
  a.artifact-link { color: var(--accent); text-decoration: none; }
  a.artifact-link:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <h1>CAF Orchestrator — Pipeline Dashboard</h1>
  <div class="filter-bar">
    <input id="repo-filter" type="text" placeholder="Filter by repoId (owner/repo)" />
    <button id="apply-filter">Filter</button>
  </div>
  <div id="conn-status"><span id="conn-dot"></span><span id="conn-label">connecting…</span></div>
</header>
<main id="main">
  <div>
    <table>
      <thead>
        <tr>
          <th>Repo</th>
          <th>Ticket</th>
          <th>Phase</th>
          <th>Retries</th>
          <th>Cost</th>
          <th>Status</th>
          <th>Artifact</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div id="empty-state" class="empty" hidden>No pipeline runs yet.</div>
  </div>
  <div id="detail" hidden>
    <h2 id="detail-title"></h2>
    <ul class="timeline" id="detail-timeline"></ul>
  </div>
</main>
<script>
(function () {
  var rowsEl = document.getElementById('rows');
  var emptyEl = document.getElementById('empty-state');
  var detailEl = document.getElementById('detail');
  var detailTitleEl = document.getElementById('detail-title');
  var detailTimelineEl = document.getElementById('detail-timeline');
  var mainEl = document.getElementById('main');
  var connDot = document.getElementById('conn-dot');
  var connLabel = document.getElementById('conn-label');
  var repoFilterInput = document.getElementById('repo-filter');
  var applyFilterBtn = document.getElementById('apply-filter');

  var selectedKey = null; // "repoId|ticketId"

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatCost(v) {
    return v == null ? 'belum tersedia' : ('$' + v.toFixed(4));
  }

  function formatRetries(retryCounts) {
    var keys = Object.keys(retryCounts || {});
    if (keys.length === 0) return '—';
    return keys.map(function (k) { return k.replace('caf-', '') + ': ' + retryCounts[k]; }).join(', ');
  }

  function artifactHref(run) {
    if (!run.lastArtifactLink) return null;
    // Artifacts live inside the target repo's own workspace, not this
    // server — no working link to build, so just show the relative path.
    return run.lastArtifactLink;
  }

  function renderRows(runs) {
    rowsEl.innerHTML = '';
    emptyEl.hidden = runs.length > 0;

    runs.forEach(function (run) {
      var key = run.repoId + '|' + run.ticketId;
      var tr = document.createElement('tr');
      tr.dataset.repoId = run.repoId;
      tr.dataset.ticketId = run.ticketId;
      if (key === selectedKey) tr.className = 'selected';

      var artifact = artifactHref(run);
      tr.innerHTML =
        '<td>' + esc(run.repoId) + '</td>' +
        '<td>' + esc(run.ticketId) + '<div class="muted">' + esc(run.ticketTitle) + '</div></td>' +
        '<td>' + esc(run.currentPivPhase || '—') + '</td>' +
        '<td>' + esc(formatRetries(run.retryCounts)) + '</td>' +
        '<td>' + esc(formatCost(run.totalCostUsd)) + '</td>' +
        '<td><span class="badge ' + esc(run.status) + '">' + esc(run.status) + '</span></td>' +
        '<td>' + (artifact ? '<span class="artifact-link">' + esc(artifact) + '</span>' : '<span class="muted">—</span>') + '</td>';

      tr.addEventListener('click', function () {
        selectedKey = key;
        renderRows(runs);
        loadDetail(run.repoId, run.ticketId);
      });

      rowsEl.appendChild(tr);
    });
  }

  function eventLabel(event) {
    var label = event.eventType.toUpperCase();
    if (event.eventType === 'retry' && event.retryCount != null) label += ' #' + event.retryCount;
    return label;
  }

  function renderDetail(data) {
    detailEl.hidden = false;
    mainEl.classList.add('has-detail');
    detailTitleEl.textContent = data.repoId + ' / ' + data.ticketId + ' — ' + data.ticketTitle;

    detailTimelineEl.innerHTML = '';
    if (!data.events || data.events.length === 0) {
      var li = document.createElement('li');
      li.className = 'placeholder';
      li.textContent = 'No agent events recorded yet.';
      detailTimelineEl.appendChild(li);
      return;
    }

    data.events.forEach(function (event) {
      var li = document.createElement('li');
      var metaParts = [event.pivPhase];
      if (event.costUsd != null) metaParts.push('$' + event.costUsd.toFixed(4));
      if (event.artifactLink) metaParts.push(event.artifactLink);

      li.innerHTML =
        '<div class="t-head">' +
          '<span class="t-agent">' + esc(event.agentName) + ' — ' + esc(eventLabel(event)) + '</span>' +
          '<span class="t-time">' + esc(new Date(event.createdAt).toLocaleString()) + '</span>' +
        '</div>' +
        '<div class="t-meta">' + esc(metaParts.join(' · ')) + '</div>';
      detailTimelineEl.appendChild(li);
    });
  }

  function loadDetail(repoId, ticketId) {
    fetch('/api/pipelines/' + encodeURIComponent(repoId) + '/' + encodeURIComponent(ticketId))
      .then(function (res) { return res.json(); })
      .then(renderDetail)
      .catch(function () { /* leave previous detail in place on transient failure */ });
  }

  var currentRuns = [];

  function loadPipelines() {
    var repoId = (repoFilterInput.value || '').trim();
    var url = '/api/pipelines' + (repoId ? ('?repoId=' + encodeURIComponent(repoId)) : '');
    return fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (runs) {
        currentRuns = runs;
        renderRows(runs);
      })
      .catch(function () { /* keep last known table on a transient fetch failure */ });
  }

  applyFilterBtn.addEventListener('click', loadPipelines);
  repoFilterInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') loadPipelines();
  });

  function setConnStatus(state) {
    connDot.className = state;
    connLabel.textContent = state === 'live' ? 'live' : (state === 'down' ? 'disconnected — retrying…' : 'connecting…');
  }

  function connectSse() {
    var source = new EventSource('/api/events/stream');
    source.onopen = function () { setConnStatus('live'); };
    source.onerror = function () { setConnStatus('down'); };
    // Task 4's events are a "something changed" signal (repoId/ticketId/eventType),
    // not a full state payload — simplest correct reaction is to refetch the
    // table (and the open detail panel, if any) rather than try to patch
    // client-side state from a partial event.
    source.onmessage = function () {
      loadPipelines();
      if (selectedKey) {
        var parts = selectedKey.split('|');
        loadDetail(parts[0], parts[1]);
      }
    };
  }

  loadPipelines();
  connectSse();
})();
</script>
</body>
</html>
`;
