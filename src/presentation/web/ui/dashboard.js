(function () {
  'use strict';

  var grid = document.getElementById('run-grid');
  var empty = document.getElementById('empty-state');
  var search = document.getElementById('run-search');
  var statusFilter = document.getElementById('status-filter');
  var repoFilter = document.getElementById('repo-filter');
  var count = document.getElementById('result-count');
  var inspector = document.getElementById('inspector');
  var backdrop = document.getElementById('inspector-backdrop');
  var detail = document.getElementById('detail-content');
  var connDot = document.getElementById('conn-dot');
  var connLabel = document.getElementById('conn-label');

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

  function totalRetries(counts) {
    return Object.keys(counts || {}).reduce(function (sum, key) {
      return sum + counts[key];
    }, 0);
  }

  function statusColor(status) {
    if (status === 'SUCCESS') return 'var(--green)';
    if (status === 'NEEDS_HUMAN') return 'var(--amber)';
    if (status === 'ERROR') return 'var(--red)';
    return 'var(--cyan)';
  }

  function statusLabel(status) {
    return status === 'NEEDS_HUMAN' ? 'NEEDS ATTENTION' : status;
  }

  function eventColor(type) {
    if (type === 'retry') return 'var(--amber)';
    if (type === 'gate_exhausted') return 'var(--red)';
    if (type === 'end') return 'var(--green)';
    return 'var(--cyan)';
  }

  // ---- Rendering: run grid ----

  function phaseRail(run) {
    var active = phaseIndex(run.currentPivPhase);
    return ['Plan', 'Implement', 'Verify'].map(function (label, i) {
      var cls = i < active || (run.status === 'SUCCESS' && i <= active) ? 'done' : i === active ? 'active' : '';
      if ((run.status === 'ERROR' || run.status === 'NEEDS_HUMAN') && i === active) cls += ' failed';
      return '<span class="phase ' + cls + '">' + label + '</span>';
    }).join('');
  }

  function runCard(run) {
    var key = run.repoId + '|' + run.ticketId;
    return '<button type="button" class="run-card' + (key === selected ? ' selected' : '') + '"' +
      ' data-repo="' + esc(run.repoId) + '" data-ticket="' + esc(run.ticketId) + '"' +
      ' style="--statusColor:' + statusColor(run.status) + '">' +
      '<div class="run-head">' +
        '<div>' +
          '<div class="ticket-key">' + esc(run.ticketId) + '</div>' +
          '<div class="ticket-title">' + esc(run.ticketTitle || 'Untitled pipeline') + '</div>' +
          '<div class="repo">' + esc(run.repoId) + '</div>' +
        '</div>' +
        '<span class="status ' + esc(run.status) + '">' + esc(statusLabel(run.status)) + '</span>' +
      '</div>' +
      '<div class="phase-rail">' + phaseRail(run) + '</div>' +
      '<div class="run-meta">' +
        '<div class="meta-cell"><span class="meta-label">Elapsed</span><span class="meta-value">' + esc(elapsed(run)) + '</span></div>' +
        '<div class="meta-cell"><span class="meta-label">Retries</span><span class="meta-value">' + totalRetries(run.retryCounts) + '</span></div>' +
        '<div class="meta-cell"><span class="meta-label">Cost</span><span class="meta-value">' + esc(money(run.totalCostUsd)) + '</span></div>' +
      '</div>' +
    '</button>';
  }

  function visibleRuns() {
    var q = search.value.trim().toLowerCase();
    return runs.filter(function (run) {
      var matchesQuery = !q || [run.repoId, run.ticketId, run.ticketTitle].join(' ').toLowerCase().indexOf(q) !== -1;
      var matchesStatus = statusFilter.value === 'ALL' || run.status === statusFilter.value;
      var matchesRepo = repoFilter.value === 'ALL' || run.repoId === repoFilter.value;
      return matchesQuery && matchesStatus && matchesRepo;
    });
  }

  function render() {
    var list = visibleRuns();
    grid.classList.remove('loading');
    grid.innerHTML = list.map(runCard).join('');
    grid.hidden = !list.length;
    empty.hidden = !!list.length;
    count.textContent = list.length + ' of ' + runs.length + ' runs';

    Array.prototype.forEach.call(grid.querySelectorAll('.run-card'), function (button) {
      button.addEventListener('click', function () {
        openDetail(button.dataset.repo, button.dataset.ticket);
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
          var artifact = e.artifactLink ? '<div class="artifact">↳ ' + esc(e.artifactLink) + '</div>' : '';
          return '<li style="--eventColor:' + eventColor(e.eventType) + '">' +
            '<div class="event-head">' +
              '<div>' +
                '<span class="event-agent">' + esc(agentLabel(e.agentName)) + '</span>' +
                '<span class="event-type">' + esc(e.eventType.replace('_', ' ')) + '</span>' +
              '</div>' +
              '<time class="event-time">' + esc(new Date(e.createdAt).toLocaleString()) + '</time>' +
            '</div>' +
            '<div class="event-meta">' + esc(meta.join(' · ')) + '</div>' +
            artifact +
          '</li>';
        }).join('')
      : '<li><div class="event-meta">Waiting for the first agent event.</div></li>';

    detail.innerHTML =
      '<h2 class="detail-title">' + esc(d.ticketTitle || d.ticketId) + '</h2>' +
      '<div class="detail-repo">' + esc(d.repoId) + ' / ' + esc(d.ticketId) + '</div>' +
      '<div class="detail-summary">' +
        '<div><span class="meta-label">Status</span><span class="status ' + esc(d.status) + '">' + esc(statusLabel(d.status)) + '</span></div>' +
        '<div><span class="meta-label">Elapsed</span><span class="meta-value">' + esc(elapsed(d)) + '</span></div>' +
        '<div><span class="meta-label">Cost · retries</span><span class="meta-value">' + esc(money(d.totalCostUsd)) + ' · ' + totalRetries(d.retryCounts) + '</span></div>' +
      '</div>' +
      '<div class="timeline-title">Agent event stream · ' + events.length + ' events</div>' +
      '<ol class="timeline">' + timelineItems + '</ol>';
  }

  function openDetail(repo, ticket) {
    selected = repo + '|' + ticket;
    render();
    inspector.hidden = false;
    backdrop.hidden = false;
    detail.innerHTML = '<div class="loading">Loading agent event stream…</div>';

    fetch('/api/pipelines/' + encodeURIComponent(repo) + '/' + encodeURIComponent(ticket))
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(renderDetail)
      .catch(function () {
        detail.innerHTML = '<div class="empty"><strong>Details unavailable</strong><span>The overview remains available.</span></div>';
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
        grid.classList.remove('loading');
        if (!runs.length) {
          grid.innerHTML = '<div class="empty"><strong>Unable to load pipelines</strong><span>Live updates will retry automatically.</span></div>';
        }
      });
  }

  function setConnectionStatus(state) {
    connDot.className = 'connection-dot ' + state;
    connLabel.textContent = state === 'live' ? 'live feed' : state === 'down' ? 'reconnecting' : 'connecting';
  }

  function connect() {
    var source = new EventSource('/api/events/stream');
    source.onopen = function () { setConnectionStatus('live'); };
    source.onerror = function () { setConnectionStatus('down'); };
    source.onmessage = function () {
      load();
      if (selected) {
        var parts = selected.split('|');
        openDetail(parts[0], parts[1]);
      }
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
  repoFilter.addEventListener('change', render);

  tick();
  setInterval(tick, 1000);
  load();
  connect();
})();
