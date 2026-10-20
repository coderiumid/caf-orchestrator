import blessed from 'neo-blessed';
import { buildActions, type ActionId, type ActionView } from '../../application/view-models/actions.js';
import type { ProcessName, ProcessState } from '../../domain/models/process.js';
import { truncate } from '../../shared/format.js';
import { escapeTags } from '../formatters/markup.js';
import { bold, C, dim, faint, fg, themeColor } from '../theme.js';
import type { Footer } from './footer.js';
import { createPanel, PANEL_PAD_X } from './panel.js';

type Screen = blessed.Widgets.Screen;
type Button = blessed.Widgets.ButtonElement;
type Box = blessed.Widgets.BoxElement;

export const SIDEBAR_W = 38;
const INNER_W = SIDEBAR_W - PANEL_PAD_X * 2;
const TARGETS: readonly ProcessName[] = ['server', 'worker', 'tunnel'];

export type CopyKind = 'linear' | 'github' | 'health';

/** Row of each element, counted from the top of the panel (row 1 is the title). */
const ROW = {
  processesLabel: 3,
  server: 5,
  worker: 6,
  tunnel: 7,
  all: 8,
  targetLabel: 10,
  restart: 11,
  kill: 12,
  queue: 14,
  help: 15,
  tunnelLabel: 17,
  tunnelUrl: 19,
  tunnelRoute: 20,
  tunnelReach: 21,
} as const;

export interface SidebarDeps {
  screen: Screen;
  footer: Footer;
  tunnelAvailable: boolean;
  tunnelInAll: boolean;
  /** An enabled action was clicked. */
  onAction(id: ActionId): void;
  /** A disabled action was clicked. */
  onDisabled(id: ActionId): void;
}

export interface SidebarState {
  processes: Record<ProcessName, ProcessState>;
  activeJobs: number;
  failedJobs: number;
  tunnel: {
    running: boolean;
    /** Public https origin from TUNNEL_URL, or null when unset. */
    url: string | null;
    target: string;
    /** Whether `<url>/health` answered through the tunnel. */
    reach: 'up' | 'down' | 'unknown';
    /** Set when TUNNEL_* are invalid. */
    error: string | null;
  };
}

export interface Sidebar {
  box: Box;
  render(state: SidebarState): void;
  /** Hide the rows that do not fit in `height` rows. */
  fit(height: number): void;
  /** Which process RESTART and KILL act on. */
  getTarget(): ProcessName;
  setTarget(name: ProcessName): void;
  cycleTarget(): void;
}

/** Colour of an action's icon: its semantic colour, plain for neutral, faint when disabled. */
function ink(a: ActionView): string {
  if (a.disabled) return C.faint;
  return a.bg === 'gray' ? C.dim : themeColor(a.bg);
}

/** `  s   ■ stop server`: key, icon, lower-case label. */
function actionRow(a: ActionView, failedJobs: number): string {
  const label = a.id === 'queue' ? 'failed jobs' : a.label.toLowerCase();
  const badge = a.id === 'queue' && failedJobs > 0 ? `  ${fg(C.warn, String(failedJobs))}` : '';
  return `${' '.repeat(PANEL_PAD_X)}${fg(a.disabled ? C.faint : C.text, bold(a.key.padEnd(2)))}  ${fg(ink(a), a.icon)}  ${a.disabled ? faint(label) : label}${badge}`;
}

/**
 * The right-hand column, kept to what you act on: start/stop, restart/kill
 * (with the process they act on), failed jobs, help, and the tunnel route with
 * its reachability. Mode, target choice and webhook copying live in the
 * `ctrl+p` palette. Rows are clickable; hovering one explains it in the footer.
 */
export function createSidebar(deps: SidebarDeps): Sidebar {
  const { screen, footer } = deps;
  const panel = createPanel(screen);
  const box = panel.box;
  panel.setTitle(bold('Controls'));
  const bg = C.panel;

  let target: ProcessName = 'worker';
  let state: SidebarState | null = null;
  let hovered: ActionId | null = null;
  const hints = new Map<ActionId, string>();
  const disabled = new Set<ActionId>();
  /** Everything that can be hidden when the sidebar is short, with its row. */
  const placed: Array<{ el: Box | Button; row: number }> = [];

  const refresh = () => {
    if (state) render(state);
    screen.render();
  };
  const text = (row: number): Box => {
    const el = blessed.box({ parent: box, top: row, left: PANEL_PAD_X, width: INNER_W, height: 1, tags: true, style: { bg, fg: C.text } });
    placed.push({ el, row });
    return el;
  };
  const label = (row: number, content: string): void => text(row).setContent(faint(content));

  // ---- Action rows ----
  label(ROW.processesLabel, 'processes');
  label(ROW.tunnelLabel, 'tunnel');

  const rows = new Map<ActionId, Button>();
  for (const id of ['server', 'worker', 'tunnel', 'all', 'restart', 'kill', 'queue', 'help'] as const) {
    const btn = blessed.button({ parent: box, top: ROW[id], left: 0, width: SIDEBAR_W, height: 1, tags: true, mouse: true, style: { bg, fg: C.text } });
    btn.on('press', () => (disabled.has(id) ? deps.onDisabled(id) : deps.onAction(id)));
    btn.on('mouseover', () => {
      hovered = id;
      footer.hint(hints.get(id) ?? '');
      refresh();
    });
    btn.on('mouseout', () => {
      if (hovered === id) hovered = null;
      footer.hint(null);
      refresh();
    });
    placed.push({ el: btn, row: ROW[id] });
    rows.set(id, btn);
  }

  // ---- Target: which process restart / kill act on; clicking cycles it ----
  const targetRow = blessed.button({ parent: box, top: ROW.targetLabel, left: 0, width: SIDEBAR_W, height: 1, tags: true, mouse: true, style: { bg, fg: C.text } });
  targetRow.on('press', () => cycleTarget());
  targetRow.on('mouseover', () => footer.hint('Which process restart and kill act on (click or Tab to change)'));
  targetRow.on('mouseout', () => footer.hint(null));
  placed.push({ el: targetRow, row: ROW.targetLabel });

  // ---- Tunnel ----
  const tunnelUrl = text(ROW.tunnelUrl);
  const tunnelRoute = text(ROW.tunnelRoute);
  const tunnelReach = text(ROW.tunnelReach);

  /** Rows below the sidebar's height are hidden. */
  let fitHeight = Number.POSITIVE_INFINITY;
  function applyVisibility(): void {
    for (const { el, row } of placed) {
      if (row + 1 <= fitHeight) el.show();
      else el.hide();
    }
  }

  function cycleTarget(): void {
    target = TARGETS[(TARGETS.indexOf(target) + 1) % TARGETS.length];
    refresh();
  }

  function render(next: SidebarState): void {
    state = next;
    const actions = buildActions({
      server: next.processes.server,
      worker: next.processes.worker,
      tunnel: next.processes.tunnel,
      tunnelAvailable: deps.tunnelAvailable,
      tunnelInAll: deps.tunnelInAll,
      focused: target,
      activeJobs: next.activeJobs,
      failedJobs: next.failedJobs,
    });
    for (const a of actions) {
      const btn = rows.get(a.id)!;
      (btn.style as { bg: string }).bg = hovered === a.id && !a.disabled ? C.raised : bg;
      btn.setContent(actionRow(a, next.failedJobs));
      hints.set(a.id, a.hint);
      if (a.disabled) disabled.add(a.id);
      else disabled.delete(a.id);
    }
    targetRow.setContent(`${' '.repeat(PANEL_PAD_X)}${faint('acts on')}  ${fg(C.accent, bold(target))}  ${faint('⇄')}`);

    const t = next.tunnel;
    if (t.error) {
      tunnelUrl.setContent(fg(C.bad, escapeTags(truncate(t.error, INNER_W))));
      tunnelRoute.setContent('');
      tunnelReach.setContent('');
    } else {
      tunnelUrl.setContent(t.url ? fg(C.info, escapeTags(truncate(t.url, INNER_W))) : faint('no TUNNEL_URL set'));
      tunnelRoute.setContent(`${fg(C.accent, '→')} ${dim(escapeTags(truncate(t.target, INNER_W - 2)))}`);
      tunnelReach.setContent(
        !t.running || !t.url
          ? faint('○ not running')
          : t.reach === 'up'
            ? fg(C.ok, '● reachable')
            : t.reach === 'down'
              ? fg(C.bad, '✖ not reachable')
              : fg(C.warn, '◌ checking'),
      );
    }
  }

  return {
    box,
    render,
    fit(height) {
      fitHeight = height;
      applyVisibility();
    },
    getTarget: () => target,
    setTarget(name) {
      target = name;
      refresh();
    },
    cycleTarget,
  };
}
