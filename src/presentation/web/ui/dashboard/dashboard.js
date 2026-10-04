(function () {
  'use strict';

  var grid = document.getElementById('run-grid');
  var empty = document.getElementById('empty-state');
  var search = document.getElementById('run-search');
  var statusFilter = document.getElementById('status-filter');
  var kindFilter = document.getElementById('kind-filter');
  var repoFilter = document.getElementById('repo-filter');
  var count = document.getElementById('result-count');
  var inspector = document.getElementById('inspector');
  var backdrop = document.getElementById('inspector-backdrop');
  var detail = document.getElementById('detail-content');
  var conn = document.getElementById('conn');

  var runs = [];
  var selected = null;

  var PHASE_INDEX = { plan: 0, implement: 1, verify: 2 };

  // ---- Formatting helpers ----

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(value) {
    return value == null ? 'Pending' : '$' + Number(value).toFixed(2);
  }

  function agentLabel(name) {
    return String(name || '').replace(/^caf-/, '').replace(/-/g, ' ');
  }

  function phaseIndex(phase) {
    return PHASE_INDEX[phase] == null ? -1 : PHASE_INDEX[phase];
  }

  function elapsed(run) {
    var end = run.endedAt ? new Date(run.endedAt) : new Date();
    var mins = Math.max(0, Math.round((end - new Date(run.startedAt)) / 60000));
    return mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  }

  // ---- Run types: a ticket pipeline, or a PR review / fix-review job ----

  // 'pipeline', 'review' (mode initial) or 'fix' (mode global/scoped).
  function runType(run) {
    if (run.kind !== 'pr-review') return 'pipeline';
    return run.reviewMode === 'initial' ? 'review' : 'fix';
  }

  function typeLabel(run) {
    var type = runType(run);
    if (type === 'review') return 'Review';
    if (type === 'fix') return 'Fix review (' + run.reviewMode + ')';
    return 'Pipeline';
  }

  function resultText(run) {
    var r = run.reviewResult;
    if (!r) return run.status === 'RUNNING' ? 'In progress' : 'No result recorded';
    if (r.type === 'verdict') {
      return r.verdict.replace('_', ' ') + (r.postedAsComment ? ' (posted as comment)' : '');
    }
    return r.fixed + ' fixed, ' + r.skipped + ' skipped, ' + r.notApplicable + ' n/a';
  }

  // A review run can only be fetched by its run id: repo + ticket always
  // resolves to the ticket's pipeline run.
  function detailUrl(run) {
    if (run.kind === 'pr-review') return '/api/pipelines/by-run/' + encodeURIComponent(run.runId);
    return '/api/pipelines/' + encodeURIComponent(run.repoId) + '/' + encodeURIComponent(run.ticketId);
  }

  function totalRetries(counts) {
    return Object.keys(counts || {}).reduce(function (sum, key) {
      return sum + counts[key];
    }, 0);
  }

  // Class names below are the design system's (.pill / .log li variants).

  function statusClass(status) {
    if (status === 'SUCCESS') return 'success';
    if (status === 'NEEDS_HUMAN') return 'needs';
    if (status === 'ERROR') return 'error';
    return 'run';
  }

  function statusLabel(status) {
    if (status === 'NEEDS_HUMAN') return 'Needs attention';
    return status.charAt(0) + status.slice(1).toLowerCase();
  }

  function statusPill(status) {
    return '<span class="pill ' + statusClass(status) + '">' + esc(statusLabel(status)) + '</span>';
  }

  function eventClass(type) {
    if (type === 'retry') return 'warn';
    if (type === 'gate_exhausted') return 'bad';
    if (type === 'end') return 'ok';
    return 'info';
  }

  // ---- Rendering: run grid ----

  function reviewRail(run) {
    var cls = run.status === 'SUCCESS' ? 'pass' : run.status === 'RUNNING' ? 'active running' : 'fail';
    return '<span class="st ' + cls + '"><span class="m"></span>' + (runType(run) === 'fix' ? 'Fix review' : 'Review') + '</span>' +
      '<span class="res">' + esc(resultText(run)) + '</span>';
  }

  function phaseRail(run) {
    if (run.kind === 'pr-review') return reviewRail(run);
    var active = phaseIndex(run.currentPivPhase);
    var running = run.status === 'RUNNING';
    return ['Plan', 'Implement', 'Verify'].map(function (label, i) {
      var cls = i < active || (run.status === 'SUCCESS' && i <= active) ? 'pass' : i === active ? 'active' : 'pending';
      if ((run.status === 'ERROR' || run.status === 'NEEDS_HUMAN') && i === active) cls = 'fail';
      if (running && i === active) cls += ' running';
      return '<span class="st ' + cls + '"><span class="m"></span>' + label + '</span>';
    }).join('');
  }

  function runCard(run) {
    var review = run.kind === 'pr-review';
    var tkey = run.ticketId + (review ? ' · ' + typeLabel(run) : '') + (run.prNumber ? ' · PR #' + run.prNumber : '');
    return '<button type="button" class="run-card" aria-pressed="' + (run.runId === selected) + '"' +
      ' data-run="' + esc(run.runId) + '">' +
      '<span class="run-hd">' +
        '<span class="run-id">' +
          '<span class="tkey">' + esc(tkey) + '</span>' +
          '<span class="ttl">' + esc(run.ticketTitle || 'Untitled pipeline') + '</span>' +
          '<span class="repo">' + esc(run.repoId) + '</span>' +
        '</span>' +
        statusPill(run.status) +
      '</span>' +
      '<span class="rail">' + phaseRail(run) + '</span>' +
      '<span class="run-meta">' +
        '<span><span class="k">Elapsed</span><span class="v">' + esc(elapsed(run)) + '</span></span>' +
        (review
          ? '<span><span class="k">Attempt</span><span class="v">' + esc(run.attempt || 1) + '</span></span>'
          : '<span><span class="k">Retries</span><span class="v">' + totalRetries(run.retryCounts) + '</span></span>') +
        '<span><span class="k">Cost</span><span class="v">' + esc(money(run.totalCostUsd)) + '</span></span>' +
      '</span>' +
    '</button>';
  }

  function visibleRuns() {
    var q = search.value.trim().toLowerCase();
    return runs.filter(function (run) {
      var matchesQuery = !q || [run.repoId, run.ticketId, run.ticketTitle].join(' ').toLowerCase().indexOf(q) !== -1;
      var matchesStatus = statusFilter.value === 'ALL' || run.status === statusFilter.value;
      var matchesRepo = repoFilter.value === 'ALL' || run.repoId === repoFilter.value;
      var matchesKind = kindFilter.value === 'ALL' || runType(run) === kindFilter.value;
      return matchesQuery && matchesStatus && matchesRepo && matchesKind;
    });
  }

  function render() {
    var list = visibleRuns();
    grid.innerHTML = list.map(runCard).join('');
    grid.hidden = !list.length;
    empty.hidden = !!list.length;
    count.textContent = list.length + ' of ' + runs.length + ' runs';

    Array.prototype.forEach.call(grid.querySelectorAll('.run-card'), function (button) {
      button.addEventListener('click', function () {
        openDetail(button.dataset.run);
      });
    });
  }

  // ---- Rendering: overview stats + repo filter options ----

  function renderStats() {
    var running = runs.filter(function (r) { return r.status === 'RUNNING'; }).length;
    var success = runs.filter(function (r) { return r.status === 'SUCCESS'; }).length;
    var attention = runs.filter(function (r) { return r.status === 'NEEDS_HUMAN' || r.status === 'ERROR'; }).length;
    var cost = runs.reduce(function (sum, r) { return sum + (r.totalCostUsd || 0); }, 0);

    document.getElementById('stat-running').textContent = running;
    document.getElementById('stat-success').textContent = success;
    document.getElementById('stat-attention').textContent = attention;
    document.getElementById('stat-cost').innerHTML = '$' + cost.toFixed(2) + ' <small>USD</small>';
  }

  function renderRepoOptions() {
    var previous = repoFilter.value;
    var list = runs.map(function (r) { return r.repoId; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
    repoFilter.innerHTML = '<option value="ALL">All repositories</option>' +
      list.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
    if (list.indexOf(previous) !== -1) repoFilter.value = previous;
  }

  // ---- Rendering: run inspector (detail panel) ----

  function renderDetail(d) {
    var events = d.events || [];
    var timelineItems = events.length
      ? events.map(function (e) {
          var meta = [e.pivPhase];
          if (e.costUsd != null) meta.push('$' + Number(e.costUsd).toFixed(4));
          if (e.retryCount != null) meta.push('attempt ' + e.retryCount);
          var artifact = e.artifactLink ? '<div class="ev-art">↳ ' + esc(e.artifactLink) + '</div>' : '';
          return '<li class="' + eventClass(e.eventType) + '">' +
            '<div class="ev-hd">' +
              '<div>' +
                '<span class="ev-agent">' + esc(agentLabel(e.agentName)) + '</span>' +
                '<span class="ev-type">' + esc(e.eventType.replace('_', ' ')) + '</span>' +
              '</div>' +
              '<time>' + esc(new Date(e.createdAt).toLocaleString()) + '</time>' +
            '</div>' +
            '<div class="ev-meta">' + esc(meta.join(' · ')) + '</div>' +
            artifact +
          '</li>';
        }).join('')
      : '<li class="empty">Waiting for the first agent event.</li>';

    detail.innerHTML =
      '<p class="d-title">' + esc(d.ticketTitle || d.ticketId) + '</p>' +
      '<p class="d-repo">' + esc(d.repoId) + ' / ' + esc(d.ticketId) + '</p>' +
      '<dl class="kv">' +
        '<dt>Status</dt><dd>' + statusPill(d.status) + '</dd>' +
        '<dt>Type</dt><dd>' + esc(typeLabel(d)) + (d.prNumber ? ' · PR #' + esc(d.prNumber) : '') + '</dd>' +
        (d.kind === 'pr-review' ? '<dt>Result</dt><dd>' + esc(resultText(d)) + '</dd>' : '') +
        '<dt>Elapsed</dt><dd>' + esc(elapsed(d)) + '</dd>' +
        '<dt>Cost</dt><dd>' + esc(money(d.totalCostUsd)) + '</dd>' +
        (d.kind === 'pr-review'
          ? '<dt>Attempt</dt><dd>' + esc(d.attempt || 1) + '</dd>'
          : '<dt>Retries</dt><dd>' + totalRetries(d.retryCounts) + '</dd>') +
      '</dl>' +
      '<h3 class="d-sub">Events · ' + events.length + '</h3>' +
      '<ol class="log">' + timelineItems + '</ol>';
  }

  function openDetail(runId) {
    var run = runs.filter(function (r) { return r.runId === runId; })[0];
    if (!run) return;
    selected = runId;
    render();
    inspector.hidden = false;
    backdrop.hidden = false;
    detail.innerHTML = '<p class="note">Loading agent events…</p>';

    fetch(detailUrl(run))
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(renderDetail)
      .catch(function () {
        detail.innerHTML = '<div class="empty-state"><strong>Details unavailable</strong><span>The overview remains available.</span></div>';
      });
  }

  function closeDetail() {
    inspector.hidden = true;
    backdrop.hidden = true;
    selected = null;
    render();
  }

  // ---- Data loading + live updates ----

  function load() {
    return fetch('/api/pipelines')
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (data) {
        runs = data;
        renderRepoOptions();
        renderStats();
        render();
      })
      .catch(function () {
        if (!runs.length) {
          grid.innerHTML = '<div class="empty-state"><strong>Unable to load pipelines</strong><span>Live updates will retry automatically.</span></div>';
        }
      });
  }

  function setConnectionStatus(state) {
    conn.className = 'conn' + (state === 'live' ? ' up' : state === 'down' ? ' down' : '');
    conn.textContent = state === 'live' ? 'Connected' : state === 'down' ? 'Disconnected, retrying' : 'Connecting';
  }

  function connect() {
    var source = new EventSource('/api/events/stream');
    source.onopen = function () { setConnectionStatus('live'); };
    source.onerror = function () { setConnectionStatus('down'); };
    source.onmessage = function () {
      load();
      if (selected) openDetail(selected);
    };
  }

  function tick() {
    var now = new Date();
    document.getElementById('clock').textContent = now.toLocaleTimeString([], { hour12: false });
    document.getElementById('today').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // ---- Wiring ----

  document.getElementById('close-inspector').addEventListener('click', closeDetail);
  backdrop.addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !inspector.hidden) closeDetail();
  });
  search.addEventListener('input', render);
  statusFilter.addEventListener('change', render);
  kindFilter.addEventListener('change', render);
  repoFilter.addEventListener('change', render);

  tick();
  setInterval(tick, 1000);
  load();
  connect();
})();
