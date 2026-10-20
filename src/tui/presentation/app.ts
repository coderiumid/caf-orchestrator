import blessed from 'neo-blessed';
import type { PipelineRunApiShape } from '../../infrastructure/db/pipeline-run-shape.js';
import { planAll, planKill, planQuit, planRestart, planToggle, startAllOrder, type ProcessPlan } from '../application/process-plans.js';
import { transitionToast } from '../application/process-toasts.js';
import { TunnelMonitor } from '../application/services/tunnel-monitor.js';
import { prUrl } from '../application/view-models/inspector.js';
import { buildFloor, type FloorView } from '../application/view-models/floor.js';
import { filterRuns, STATUS_FILTERS, statusLabel, TYPE_FILTERS, type RunFilters } from '../application/view-models/run-list.js';
import { buildActions, type ActionId } from '../application/view-models/actions.js';
import type { FailedJobInfo, HealthInfo, ITuiDataSource, QueueCounts } from '../domain/interfaces/data-source.interface.js';
import type { IProcessController } from '../domain/interfaces/process-controller.interface.js';
import type { ProcessName, ProcessStatus, RunMode } from '../domain/models/process.js';
import { PROCESS_NAMES } from '../domain/models/process.js';
import type { TuiSettings } from '../domain/models/settings.js';
import { pad, truncate } from '../shared/format.js';
import { renderInspector } from './formatters/inspector.js';
import { escapeTags } from './formatters/markup.js';
import { splitRatio } from './layout.js';
import type { PaletteItem } from './widgets/dialogs.js';
import { createDialogs } from './widgets/dialogs.js';
import { createFloorWidget } from './widgets/floor-widget.js';
import { createFooter } from './widgets/footer.js';
import { createHeaderBar, HEADER_H } from './widgets/header-bar.js';
import { createLogPane } from './widgets/log-pane.js';
import { createRunsList } from './widgets/runs-list.js';
import { createSidebar, SIDEBAR_W, type CopyKind } from './widgets/sidebar.js';
import { createStatTiles, TILES_H_CARDS, TILES_H_STRIP } from './widgets/stat-tiles.js';
import { PANEL_FOOT, PANEL_HEAD } from './widgets/panel.js';
import { C } from './theme.js';

const REFRESH_MS = 2000;
const ANIMATION_MS = 250;
/** Margin around the whole layout (0 = panels touch the terminal edge) and the gaps between panels; the dark screen shows through them. */
const MARGIN = 1;
/** The header and the strip are text on the bare screen, so they keep this inset even without a margin. */
const TEXT_INSET = 0;
const GAP_X = 2;
const GAP_Y = 1;
/** Below this width the sidebar is dropped; every action is still on a key and in the palette. */
const MIN_WIDTH_FOR_SIDEBAR = 110;
/** Below this many rows the summary cards become a one-line strip. */
const COMPACT_BELOW_ROWS = 42;
/** Below this many content rows the log drawer is dropped. */
const MIN_ROWS_FOR_LOGS = 24;
/** The short log drawer: six lines of log under the panel head, plus the foot. The long one takes 45% of the height. */
const LOGS_H_SHORT = PANEL_HEAD + 6 + PANEL_FOOT;
const LOGS_SHARE_LONG = 0.45;
/** The runs and the Agent Floor always keep at least this many rows. */
const MIN_MID_ROWS = 14;

export interface AppDeps {
  settings: TuiSettings;
  processes: IProcessController;
  data: ITuiDataSource;
  /** Config problems found at startup; shown in a modal and block server/worker starts. */
  configErrors: string[];
  copyToClipboard(text: string): Promise<boolean>;
  openUrl(url: string): void;
  /** Shown next to the logo. */
  version: string;
}

/** Builds the screen from the widgets, wires keys and live data, and resolves when the user quits. */
export function runApp(deps: AppDeps): Promise<void> {
  const { settings, processes, data } = deps;
  const screen = blessed.screen({ smartCSR: true, title: 'CAF Orchestrator', fullUnicode: true });
  // The terminal draws its own window padding in its default background. Pointing that at the
  // screen colour (OSC 11) makes the padding blend in; OSC 111 restores it. Terminals that
  // ignore the sequence are unaffected.
  const output = screen.program.output as NodeJS.WriteStream;
  output.write(`\x1b]11;${C.base}\x07`);
  const restoreBackground = () => output.write('\x1b]111\x07');
  process.once('exit', restoreBackground);
  // The darkest surface; every panel paints its own lighter grey on top of it.
  blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: '100%', style: { bg: C.base } });

  // ---- State ----
  let runs: PipelineRunApiShape[] = [];
  let visible: PipelineRunApiShape[] = [];
  let queue: QueueCounts | null = null;
  let health: HealthInfo = { redis: 'down', db: 'missing', server: 'down' };
  const filters: RunFilters = { search: '', type: 'all', status: 'all', repo: '' };
  let selectedRunId: string | null = null;
  let followLive = true;
  let floorView: FloorView | null = null;
  let inspectedRunId: string | null = null;
  let inspectorBox: blessed.Widgets.BoxElement | null = null;
  let frame = 0;
  /** The log drawer is short (six lines) until expanded. */
  let logsExpanded = false;
  /** START ALL / STOP ALL include the tunnel only when TUNNEL_URL says there is one to use. */
  const tunnelInAll = settings.tunnel?.publicUrl != null;
  const tunnelMonitor = new TunnelMonitor((url) => data.probe(url));

  // ---- Widgets ----
  const footer = createFooter(screen);
  const dialogs = createDialogs(screen, {
    restoreFocus: () => {
      inspectedRunId = null;
      runsList.focus();
    },
    onToast: () => {},
  });
  const toast = dialogs.toast;
  const header = createHeaderBar(screen);
  const tiles = createStatTiles(screen);
  const runsList = createRunsList(screen, {
    onInspect: (run) => inspect(run),
    onSelect: (run) => {
      if (run.runId === selectedRunId) return;
      selectedRunId = run.runId;
      loadFloor();
      renderFloor();
      screen.render();
    },
    // Moving the selection by hand pins the floor to that run until F is pressed.
    onManualMove: () => {
      followLive = false;
    },
  });
  const floor = createFloorWidget(screen, { top: 0, left: 10, width: 10, height: 10 });
  const logs = createLogPane(screen);
  const actions = createSidebar({
    screen,
    footer,
    tunnelAvailable: settings.tunnel !== null,
    tunnelInAll,
    onAction: (id) => actionHandlers[id](),
    onDisabled: (id) => toast(disabledReason(id), 'warn'),
  });

  /**
   * One integer grid for every panel. Percentage sizes round differently per
   * widget, which left panels a column short of the edge and put uneven gaps
   * between them; columns and rows are computed here so each row tiles the
   * usable width exactly. Layout: a margin all round, the main column (runs and
   * agent floor side by side, logs underneath) and the sidebar on the right.
   */
  function applyLayout(): void {
    const W = screen.width as number;
    const H = screen.height as number;
    const compactTop = H < COMPACT_BELOW_ROWS;
    const midTop = HEADER_H + (compactTop ? TILES_H_STRIP : TILES_H_CARDS);
    const contentW = W - 2 * MARGIN;
    // The header's lines are one cell shorter than their box (a full-width line wraps), so the box is one cell wider: the text ends TEXT_INSET from the right edge, as it starts TEXT_INSET from the left.
    header.layout(MARGIN + TEXT_INSET, contentW - 2 * TEXT_INSET + 1);
    tiles.layout(HEADER_H, MARGIN, contentW, compactTop);
    const sidebarShown = W >= MIN_WIDTH_FOR_SIDEBAR;
    const mainW = contentW - (sidebarShown ? SIDEBAR_W + GAP_X : 0);
    const avail = Math.max(10, H - midTop - 2); // minus the footer row and one row of air above it
    let logsH = avail >= MIN_ROWS_FOR_LOGS ? (logsExpanded ? Math.round(avail * LOGS_SHARE_LONG) : LOGS_H_SHORT) : 0;
    if (logsH > 0 && avail - logsH - GAP_Y < MIN_MID_ROWS) logsH = avail - MIN_MID_ROWS - GAP_Y;
    const logsShown = logsH >= PANEL_HEAD + PANEL_FOOT + 2;
    const midH = logsShown ? avail - logsH - GAP_Y : avail;
    const [runsSpan, floorSpan] = splitRatio(mainW - GAP_X, 0.42);
    Object.assign(runsList.box, { top: midTop, left: MARGIN + runsSpan.left, width: runsSpan.width, height: midH });
    Object.assign(floor.box, { top: midTop, left: MARGIN + floorSpan.left + GAP_X, width: floorSpan.width, height: midH });
    if (logsShown) {
      logs.box.show();
      logs.setExpanded(logsExpanded);
      Object.assign(logs.box, { top: midTop + midH + GAP_Y, left: MARGIN, width: mainW, height: logsH });
    } else logs.box.hide();
    if (sidebarShown) {
      actions.box.show();
      Object.assign(actions.box, { top: midTop, left: W - MARGIN - SIDEBAR_W, width: SIDEBAR_W, height: avail });
      actions.fit(avail);
    } else actions.box.hide();
    footer.refresh();
  }
  applyLayout();
  screen.on('resize', () => {
    applyLayout();
    renderAll();
  });

  // ---- Actions ----
  const actionHandlers: Record<ActionId, () => void> = {
    server: () => toggle('server'),
    worker: () => toggle('worker'),
    tunnel: () => toggle('tunnel'),
    all: () => toggleAll(),
    restart: () => restartTarget(),
    kill: () => killTarget(),
    help: () => showHelp(),
    queue: () => showQueue(),
  };

  function disabledReason(id: ActionId): string {
    if (id === 'kill') return 'Nothing running to kill';
    if (id === 'tunnel') return settings.tunnelError ?? 'Tunnel is not available';
    return 'Stop server and worker first';
  }

  const activeJobs = () => queue?.active ?? 0;

  /** The tunnel only needs TUNNEL_*; server and worker need the whole app config. */
  function blockedByConfig(name?: ProcessName): boolean {
    if (name === 'tunnel') {
      if (settings.tunnel) return false;
      dialogs.overlay('Tunnel settings invalid — cannot start', `• ${escapeTags(settings.tunnelError ?? 'unknown error')}\n\n{gray-fg}Set TUNNEL_NAME / TUNNEL_URL / TUNNEL_TARGET_URL in .env{/}`, '40%');
      return true;
    }
    if (deps.configErrors.length === 0) return false;
    dialogs.overlay('Config problems — cannot start', deps.configErrors.map((e) => `• ${escapeTags(e)}`).join('\n'), '60%');
    return true;
  }

  /** Runs a plan from the application layer: refuse if config blocks it, ask if it wants asking, then do it. */
  function runPlan(plan: ProcessPlan, name: ProcessName | null): void {
    if ((plan.action === 'start' || plan.action === 'restart') && name && blockedByConfig(name)) return;
    if (plan.action === 'startAll' && blockedByConfig()) return;
    const go = () => execute(plan, name);
    if (plan.confirm) dialogs.confirm(plan.confirm, go);
    else go();
  }

  function execute(plan: ProcessPlan, name: ProcessName | null): void {
    switch (plan.action) {
      case 'startAll':
        for (const n of startAllOrder(tunnelInAll)) processes.start(n);
        return;
      case 'stopAll':
        PROCESS_NAMES.forEach((n) => processes.stop(n));
        return;
      case 'start':
        if (name) processes.start(name);
        return;
      case 'stop':
        if (name) processes.stop(name);
        return;
      case 'force':
        if (name) processes.forceKill(name);
        return;
      case 'restart':
        if (name) processes.restart(name);
    }
  }

  function toggle(name: ProcessName): void {
    actions.setTarget(name);
    runPlan(planToggle(name, processes.getStatus(name).state, activeJobs()), name);
  }

  function toggleAll(): void {
    const anyActive = processes.isActive('server') || processes.isActive('worker') || (tunnelInAll && processes.isActive('tunnel'));
    runPlan(planAll(anyActive, activeJobs()), null);
  }

  function restartTarget(): void {
    const name = actions.getTarget();
    runPlan(planRestart(name, activeJobs()), name);
  }

  function killTarget(): void {
    const name = actions.getTarget();
    if (!processes.isActive(name)) {
      toast(disabledReason('kill'), 'warn');
      return;
    }
    runPlan(planKill(name), name);
  }

  function setModeTo(next: RunMode): void {
    if (next === processes.getMode()) return;
    if (!processes.setMode(next)) toast('Stop server and worker before switching mode', 'warn');
    else toast(`Mode: ${next} (${next === 'dev' ? 'tsx, no build' : 'node dist/, run pnpm build first'})`, 'info');
    renderHeader();
  }

  async function copyLink(kind: CopyKind): Promise<void> {
    const url = settings.tunnel?.webhookUrls?.[kind];
    if (!url) {
      toast('Set TUNNEL_URL in .env to get webhook links', 'warn');
      return;
    }
    const ok = await deps.copyToClipboard(url);
    toast(ok ? `Copied ${kind} URL` : `No clipboard tool found — ${url}`, ok ? 'ok' : 'warn');
  }

  // ---- Rendering ----
  const statusOf = (name: ProcessName): ProcessStatus => processes.getStatus(name);

  function renderSidebar(): void {
    actions.render({
      processes: { server: statusOf('server').state, worker: statusOf('worker').state, tunnel: statusOf('tunnel').state },
      activeJobs: activeJobs(),
      failedJobs: queue?.failed ?? 0,
      tunnel: {
        running: statusOf('tunnel').state === 'running',
        url: settings.tunnel?.publicUrl ?? null,
        target: settings.tunnel?.targetUrl ?? `http://localhost:${settings.serverPort}`,
        reach: tunnelMonitor.reach,
        error: settings.tunnelError,
      },
    });
  }

  function renderHeader(): void {
    header.render({
      version: deps.version,
      now: Date.now(),
      frame,
      width: (screen.width as number) - 2 * (MARGIN + TEXT_INSET) + 1,
      server: statusOf('server'),
      worker: statusOf('worker'),
      health,
      queue,
      mode: processes.getMode(),
      port: settings.serverPort,
      trigger: settings.pipelineTriggerEnabled,
      activeRuns: runs.filter((r) => r.finalStatus === null).length,
      tunnel: statusOf('tunnel'),
    });
    renderSidebar();
  }

  function renderRuns(): void {
    visible = filterRuns(runs, filters);
    // Follow mode keeps the floor on the newest running run (running rows are pinned first).
    if (followLive && visible.length > 0 && statusLabel(visible[0]) === 'RUNNING') selectedRunId = visible[0].runId;
    if (visible.length > 0 && !visible.some((r) => r.runId === selectedRunId)) selectedRunId = visible[0].runId;
    const label = [filters.type !== 'all' && `type:${filters.type}`, filters.status !== 'all' && `status:${filters.status}`, filters.repo && `repo:${filters.repo}`, filters.search && `"${filters.search}"`]
      .filter(Boolean)
      .join(' ');
    runsList.render(visible, runs.length, selectedRunId, label);
  }

  function loadFloor(): void {
    const detail = selectedRunId ? data.getRunDetail(selectedRunId) : undefined;
    floorView = detail ? buildFloor(detail.floor) : null;
  }

  function renderFloor(): void {
    floor.render(floorView, frame, Date.now(), followLive);
  }

  function renderAll(): void {
    renderHeader();
    tiles.render(runs, frame);
    renderRuns();
    loadFloor();
    renderFloor();
    screen.render();
  }

  // ---- Data refresh ----
  let refreshing = false;
  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      runs = data.listRuns();
      const [q, h] = await Promise.all([data.queueCounts(), data.health()]);
      queue = q;
      health = h;
      await tunnelMonitor.update(statusOf('tunnel').state === 'running', settings.tunnel?.publicUrl ?? null);
      if (inspectedRunId) updateInspector();
    } finally {
      refreshing = false;
      renderAll();
    }
  }

  function updateInspector(): void {
    if (!inspectedRunId || !inspectorBox) return;
    const detail = data.getRunDetail(inspectedRunId);
    inspectorBox.setContent(detail ? renderInspector(detail) : '{red-fg}Run not found{/}');
  }

  function inspect(run: PipelineRunApiShape): void {
    if (dialogs.isOpen()) return;
    const detail = data.getRunDetail(run.runId);
    if (!detail) return;
    inspectorBox = dialogs.overlay(`Run ${truncate(run.ticketId, 30)}`, renderInspector(detail), '85%');
    inspectedRunId = run.runId;
    inspectorBox.key(['o'], () => {
      const url = prUrl(run.repoId, run.prNumber);
      if (url) deps.openUrl(url);
      else toast('No PR for this run yet', 'warn');
    });
  }

  // ---- Overlays ----
  function showQueue(): void {
    if (dialogs.isOpen()) return;
    void data.failedJobs().then((failed: FailedJobInfo[]) => {
      const body =
        failed.length === 0
          ? '{gray-fg}No failed jobs.{/}'
          : failed
              .map((j, i) => `${pad(String(i + 1), 3)} ${pad(j.ticket ?? j.name, 14)} attempts=${j.attemptsMade}  ${escapeTags(truncate(j.failedReason.replace(/\s+/g, ' '), 90))}`)
              .join('\n');
      const box = dialogs.overlay('Failed jobs', `${body}\n\n{gray-fg}Press 1-9 to retry that job (asks first) · Esc close{/}`, '70%');
      for (let i = 1; i <= Math.min(9, failed.length); i++) {
        box.key([String(i)], () => {
          const job = failed[i - 1];
          dialogs.confirm(`Retry job ${job.id} (${job.ticket ?? job.name})? It re-runs the whole pipeline from the planner.`, () => {
            void data.retryJob(job.id).then((ok) => toast(ok ? `Job ${job.id} re-queued` : `Could not retry job ${job.id}`, ok ? 'ok' : 'bad'));
          });
        });
      }
    });
  }

  function toggleLogs(): void {
    logsExpanded = !logsExpanded;
    applyLayout();
    renderAll();
  }

  function openSelectedPr(): void {
    const run = visible.find((r) => r.runId === selectedRunId);
    const url = run ? prUrl(run.repoId, run.prNumber) : null;
    if (url) deps.openUrl(url);
    else toast('No PR for this run yet', 'warn');
  }

  /** Every command in one searchable list: the process actions (labelled for what they do right now), then the rest. */
  function openPalette(): void {
    if (dialogs.isOpen()) return;
    const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    const processItems: PaletteItem[] = buildActions({
      server: statusOf('server').state,
      worker: statusOf('worker').state,
      tunnel: statusOf('tunnel').state,
      tunnelAvailable: settings.tunnel !== null,
      tunnelInAll: tunnelInAll,
      focused: actions.getTarget(),
      activeJobs: activeJobs(),
      failedJobs: queue?.failed ?? 0,
    }).map((a) => ({ label: a.id === 'queue' ? 'Failed jobs' : sentence(a.label), keys: a.key, run: actionHandlers[a.id] }));
    const other: PaletteItem[] = [
      { label: 'Inspect selected run', keys: 'enter', run: () => { const run = visible.find((r) => r.runId === selectedRunId); if (run) inspect(run); } },
      { label: 'Open PR of selected run', keys: 'o', run: openSelectedPr },
      { label: 'Search runs', keys: '/', run: searchRuns },
      { label: 'Cycle type filter', keys: 't', run: () => { filters.type = cycle(TYPE_FILTERS, filters.type); renderAll(); } },
      { label: 'Cycle status filter', keys: 'f', run: () => { filters.status = cycle(STATUS_FILTERS, filters.status); renderAll(); } },
      { label: 'Clear filters', keys: 'c', run: () => { Object.assign(filters, { search: '', type: 'all', status: 'all', repo: '' }); renderAll(); } },
      { label: 'Follow the live run', keys: 'F', run: () => { followLive = true; renderAll(); } },
      { label: logsExpanded ? 'Collapse logs' : 'Expand logs', keys: '`', run: toggleLogs },
      { label: 'Next log tab', keys: 'l', run: () => logs.cycleTab(logLines()) },
      { label: 'Next log level', keys: 'L', run: () => logs.cycleLevel(logLines()) },
      { label: 'Pause or resume logs', keys: 'space', run: () => logs.togglePause(logLines()) },
      ...(['server', 'worker', 'tunnel'] as const).map((n): PaletteItem => ({ label: `Restart and kill act on: ${n}`, keys: n === actions.getTarget() ? 'current' : '', run: () => actions.setTarget(n) })),
      { label: `Switch to ${processes.getMode() === 'dev' ? 'dist' : 'dev'} mode`, keys: 'm', run: () => setModeTo(processes.getMode() === 'dev' ? 'dist' : 'dev') },
      { label: 'Copy Linear webhook URL', run: () => void copyLink('linear') },
      { label: 'Copy GitHub webhook URL', run: () => void copyLink('github') },
      { label: 'Copy health URL', run: () => void copyLink('health') },
      { label: 'Help', keys: '?', run: showHelp },
      { label: 'Quit', keys: 'q', run: () => quitRequest() },
    ];
    dialogs.palette([...processItems, ...other]);
  }

  function searchRuns(): void {
    dialogs.prompt('Search ticket / title / repo', filters.search, (value) => {
      filters.search = value;
      renderAll();
    });
  }

  function showHelp(): void {
    if (dialogs.isOpen()) return;
    dialogs.overlay(
      'Help',
      [
        '{bold}Processes{/bold}',
        '  s  start/stop server   w  start/stop worker   n  start/stop Cloudflare tunnel   a  start/stop all (tunnel included when TUNNEL_URL is set)',
        '  Tab  choose the restart / kill target (or click a chip in the Controls sidebar)',
        '  r  restart target     x  force kill (SIGKILL) target     m  switch dev(tsx)/dist mode',
        '  Worker stop is graceful: it waits for the running job. Press s/w again while stopping to force kill.',
        '',
        '{bold}Runs{/bold}',
        '  ↑/↓ j/k  select      Enter  inspect run      /  search',
        '  t  cycle type filter   f  cycle status filter   p  cycle repo filter   c  clear filters',
        '  F  follow the newest running run (selecting a run by hand pins the Agent Floor to it)',
        '',
        '{bold}Logs{/bold}',
        '  l  cycle tab (all/server/worker/tunnel)   L  cycle min level   space  pause/resume   PgUp/PgDn  scroll',
        '',
        '{bold}Other{/bold}',
        "  ctrl+p  command palette (every action, type to filter)     `  show/hide the log drawer     o  open the selected run's PR",
        '  u  failed jobs / retry     ?  this help     Esc  dismiss a toast or cancel a dialog     q  quit (stops everything it started)',
        '',
        '{#8c8c8c-fg}Monitoring is read-only: SQLite run history + Redis, the same data as /dashboard.{/}',
      ].join('\n'),
      '70%',
    );
  }

  // ---- Keys ----
  const guard = (fn: () => void) => () => {
    if (!dialogs.isOpen()) fn();
  };
  const cycle = <T>(list: readonly T[], current: T): T => list[(list.indexOf(current) + 1) % list.length];
  const logLines = () => processes.getLogs();
  /** Set once the quit flow exists (it needs the promise below); the palette calls it. */
  let quitRequest: () => void = () => {};

  screen.key(['s'], guard(() => toggle('server')));
  screen.key(['w'], guard(() => toggle('worker')));
  screen.key(['a'], guard(toggleAll));
  screen.key(['n'], guard(() => toggle('tunnel')));
  screen.key(['tab'], guard(() => actions.cycleTarget()));
  screen.key(['r'], guard(restartTarget));
  screen.key(['x'], guard(killTarget));
  screen.key(['m'], guard(() => setModeTo(processes.getMode() === 'dev' ? 'dist' : 'dev')));
  // Esc outside a dialog just dismisses the toast; inside one, the dialog's own Esc cancels it.
  screen.key(['escape'], guard(() => void dialogs.dismissToast()));
  screen.key(['/'], searchRuns);
  screen.key(['C-p'], openPalette);
  screen.key(['`', 'C-l'], guard(toggleLogs));
  screen.key(['o'], guard(openSelectedPr));
  screen.key(['t'], guard(() => { filters.type = cycle(TYPE_FILTERS, filters.type); renderAll(); }));
  screen.key(['f'], guard(() => { filters.status = cycle(STATUS_FILTERS, filters.status); renderAll(); }));
  screen.key(['p'], guard(() => {
    const repos = ['', ...new Set(runs.map((r) => r.repoId))];
    filters.repo = cycle(repos, filters.repo);
    renderAll();
  }));
  screen.key(['c'], guard(() => { Object.assign(filters, { search: '', type: 'all', status: 'all', repo: '' }); renderAll(); }));
  screen.key(['S-f'], guard(() => { followLive = true; renderAll(); }));
  screen.key(['l'], guard(() => logs.cycleTab(logLines())));
  screen.key(['S-l'], guard(() => logs.cycleLevel(logLines())));
  screen.key(['space'], guard(() => logs.togglePause(logLines())));
  screen.key(['pageup'], guard(() => logs.scrollPage(-1)));
  screen.key(['pagedown'], guard(() => logs.scrollPage(1)));
  screen.key(['u'], () => showQueue());
  screen.key(['?'], () => showHelp());

  // ---- Live wiring ----
  const lastStatus = new Map<ProcessName, ProcessStatus>();
  processes.on('status', (next) => {
    const t = transitionToast(lastStatus.get(next.name), next);
    lastStatus.set(next.name, next);
    if (t) toast(t.text, t.tone);
    renderHeader();
    screen.render();
  });
  processes.on('log', (line) => logs.append(line));

  let nudgeTimer: NodeJS.Timeout | null = null;
  const unsubscribe = data.subscribe(() => {
    // The worker can emit bursts of events; coalesce into one re-query.
    if (nudgeTimer) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      void refresh();
    }, 250);
  });
  const poll = setInterval(() => void refresh(), REFRESH_MS);
  // Spinners and clocks: cheap redraws; the floor only while something is working.
  const animate = setInterval(() => {
    frame++;
    if (!dialogs.isOpen()) {
      renderHeader();
      tiles.render(runs, frame);
      screen.render();
    }
    if (dialogs.isOpen() || !floorView) return;
    if (floorView.phase === 'run' || floorView.desks.some((d) => d.working || d.state === 'celebrating')) {
      renderFloor();
      screen.render();
    }
  }, ANIMATION_MS);

  runsList.focus();
  logs.rebuild(logLines());
  void refresh();
  if (deps.configErrors.length > 0) blockedByConfig();

  return new Promise<void>((resolve) => {
    let quitting = false;
    const quit = async () => {
      if (quitting) return;
      quitting = true;
      clearInterval(poll);
      clearInterval(animate);
      unsubscribe();
      if (processes.anyActive()) {
        footer.message('{yellow-fg} Stopping server, worker and tunnel… (Ctrl-C again to force){/}');
        screen.key(['C-c'], () => processes.killAllNow());
        await processes.stopAll();
      }
      await data.close();
      restoreBackground();
      screen.destroy();
      resolve();
    };
    quitRequest = () => {
      if (dialogs.isOpen()) return;
      const { confirm } = planQuit(processes.anyActive());
      if (confirm) dialogs.confirm(confirm, () => void quit());
      else void quit();
    };
    screen.key(['q'], () => quitRequest());
    screen.key(['C-c'], () => void quit());
    process.once('SIGTERM', () => void quit());
  });
}
