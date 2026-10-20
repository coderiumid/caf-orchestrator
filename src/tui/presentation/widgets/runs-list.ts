import blessed from 'neo-blessed';
import type { PipelineRunApiShape } from '../../../infrastructure/db/pipeline-run-shape.js';
import { formatRunRow } from '../formatters/run-row.js';
import { bold, C, dim, faint } from '../theme.js';
import { createPanel, PANEL_CONTENT } from './panel.js';

export interface RunsListHandlers {
  /** Enter on a run. */
  onInspect(run: PipelineRunApiShape): void;
  /** The highlighted run changed (keyboard, mouse or programmatically). */
  onSelect(run: PipelineRunApiShape): void;
  /** The user moved the selection by hand (pins the Agent Floor). */
  onManualMove(): void;
}

export interface RunsList {
  box: blessed.Widgets.BoxElement;
  /** Shows `visible` (already filtered) and highlights `selectedId`. `filterLabel` is appended to the title. */
  render(visible: readonly PipelineRunApiShape[], total: number, selectedId: string | null, filterLabel: string): void;
  focus(): void;
}

/**
 * The run list: one line per run — ticket, status, elapsed, cost, retries,
 * title — with a blank line between runs. blessed list items are one row high,
 * so every run is an item followed by a spacer item, and the selection only
 * ever rests on the even ones. The selected row has an accent bar.
 */
export function createRunsList(screen: blessed.Widgets.Screen, handlers: RunsListHandlers): RunsList {
  let shown: readonly PipelineRunApiShape[] = [];
  let marked = -1;
  const panel = createPanel(screen);
  const list = blessed.list({
    parent: panel.box,
    ...PANEL_CONTENT,
    tags: true,
    // Keys are handled below so the selection can skip the spacer rows.
    keys: false,
    mouse: true,
    scrollbar: { ch: ' ', style: { bg: C.faint } },
    style: { bg: C.panel, fg: C.text, item: { bg: C.panel }, selected: { bg: C.raised, fg: C.text } },
  });
  const raw = list as unknown as { selected: number; setItem(i: number, c: string): void };
  const rowWidth = () => ((list.width as number) || 80) - 1;
  const runAt = (item: number) => shown[item >> 1];
  const current = () => runAt(raw.selected);

  /** Moves the accent bar without rebuilding the list (which would re-fire the select event). */
  function mark(run: number): void {
    if (run === marked || shown.length === 0) return;
    if (marked >= 0 && marked < shown.length) raw.setItem(marked * 2, formatRunRow(shown[marked], false, rowWidth()));
    if (run >= 0 && run < shown.length) raw.setItem(run * 2, formatRunRow(shown[run], true, rowWidth()));
    marked = run;
  }

  function move(to: number): void {
    if (shown.length === 0) return;
    list.select(Math.max(0, Math.min(shown.length - 1, to)) * 2);
    handlers.onManualMove();
    screen.render();
  }
  const page = () => Math.max(1, Math.floor((((list.height as number) || 10) - 1) / 2));

  list.on('select item', () => {
    // A click on a spacer snaps to the run above it.
    if (raw.selected % 2 === 1) {
      list.select(raw.selected - 1);
      return;
    }
    const run = current();
    if (!run) return;
    mark(raw.selected >> 1);
    handlers.onSelect(run);
  });
  list.key(['up', 'k'], () => move((raw.selected >> 1) - 1));
  list.key(['down', 'j'], () => move((raw.selected >> 1) + 1));
  list.key(['pageup'], () => move((raw.selected >> 1) - page()));
  list.key(['pagedown'], () => move((raw.selected >> 1) + page()));
  list.key(['home', 'g'], () => move(0));
  list.key(['end', 'G'], () => move(shown.length - 1));
  list.key(['enter'], () => {
    const run = current();
    if (run) handlers.onInspect(run);
  });

  return {
    box: panel.box,
    focus: () => list.focus(),
    render(visible, total, selectedId, filterLabel) {
      shown = visible;
      const idx = selectedId ? visible.findIndex((r) => r.runId === selectedId) : -1;
      marked = visible.length > 0 ? Math.max(0, idx) : -1;
      const items = visible.flatMap((r, i) => [formatRunRow(r, i === marked, rowWidth()), ' ']);
      list.setItems(items.length > 0 ? items : [dim('No runs match. The worker records a run when it picks up a ticket.')]);
      if (idx >= 0) list.select(idx * 2);
      panel.setTitle(`${bold('Runs')}  ${dim(`${visible.length}/${total}`)}${filterLabel ? `   ${faint('filter')} ${dim(filterLabel)}` : ''}`);
    },
  };
}
