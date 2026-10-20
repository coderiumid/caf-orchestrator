import blessed from 'neo-blessed';
import { LOG_LEVELS, levelAtLeast, type LogLevel, type LogLine } from '../../domain/models/log-line.js';
import { formatLogLine } from '../formatters/log-line.js';
import { bold, C, dim, faint, fg } from '../theme.js';
import { createPanel, PANEL_CONTENT } from './panel.js';

type LogTab = 'all' | 'server' | 'worker' | 'tunnel';
const LOG_TABS: readonly LogTab[] = ['all', 'server', 'worker', 'tunnel'];

export interface LogPane {
  box: blessed.Widgets.BoxElement;
  /** Append one line if it matches the tab/level filter and the pane is not paused. */
  append(line: LogLine): void;
  /** Redraw everything from `lines` through the current filter. */
  rebuild(lines: readonly LogLine[]): void;
  cycleTab(lines: readonly LogLine[]): void;
  cycleLevel(lines: readonly LogLine[]): void;
  togglePause(lines: readonly LogLine[]): void;
  scrollPage(direction: 1 | -1): void;
  /** The title offers to expand the drawer while it is the short one. */
  setExpanded(expanded: boolean): void;
}

/**
 * Scrollable log view with a tab (all/server/worker/tunnel), a minimum level
 * and pause. cloudflared is chatty at info level (connection registrations,
 * curve preferences), so the `all` tab only shows its warnings and errors; the
 * full stream is on the `tunnel` tab.
 */
export function createLogPane(screen: blessed.Widgets.Screen): LogPane {
  let tab: LogTab = 'all';
  let min: LogLevel = 'info';
  let paused = false;
  let expanded = false;
  const panel = createPanel(screen);
  const box = blessed.log({
    parent: panel.box,
    ...PANEL_CONTENT,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    scrollbar: { ch: ' ', style: { bg: C.faint } },
    scrollback: 2000,
    style: { bg: C.panel, fg: C.text },
  });

  const matches = (line: LogLine) => {
    if (tab === 'all' && line.source === 'tunnel' && !levelAtLeast(line.level, 'warn')) return false;
    return (tab === 'all' || line.source === tab) && levelAtLeast(line.level, min);
  };
  const title = () => {
    const tabs = LOG_TABS.map((t) => (t === tab ? fg(C.accent, bold(t)) : dim(t))).join('   ');
    panel.setTitle(`${bold('Logs')}  ${tabs}  ${dim(`≥${min}`)}${paused ? `  ${fg(C.warn, 'paused')}` : ''}${expanded ? '' : `   ${faint('` to expand')}`}`);
  };
  const cycle = <T,>(list: readonly T[], current: T): T => list[(list.indexOf(current) + 1) % list.length];

  function rebuild(lines: readonly LogLine[]): void {
    box.setContent('');
    for (const line of lines) if (matches(line)) box.add(formatLogLine(line));
    title();
    screen.render();
  }

  return {
    box: panel.box,
    append(line) {
      if (paused || !matches(line)) return;
      box.add(formatLogLine(line));
      screen.render();
    },
    rebuild,
    cycleTab(lines) {
      tab = cycle(LOG_TABS, tab);
      rebuild(lines);
    },
    cycleLevel(lines) {
      min = cycle(LOG_LEVELS, min);
      rebuild(lines);
    },
    togglePause(lines) {
      paused = !paused;
      if (!paused) rebuild(lines);
      else {
        title();
        screen.render();
      }
    },
    setExpanded(next) {
      expanded = next;
      title();
    },
    scrollPage(direction) {
      const page = ((box.height as number) || 10) - 1;
      box.scroll(direction * page);
      screen.render();
    },
  };
}
