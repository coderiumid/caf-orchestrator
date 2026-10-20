import blessed from 'neo-blessed';
import { DESK_NAME, DESKS, type FloorView } from '../../application/view-models/floor.js';
import { formatCost, formatElapsed, truncate } from '../../shared/format.js';
import { TONE_COLOR, deskCard, deskLine, formatOffset, stepLine, thinBar } from '../formatters/floor.js';
import { escapeTags } from '../formatters/markup.js';
import { splitGap } from '../layout.js';
import { bold, C, dim, faint, fg } from '../theme.js';
import { createCard } from './card.js';
import { createPanel, PANEL_FOOT, PANEL_HEAD, PANEL_PAD_X } from './panel.js';

type Box = blessed.Widgets.BoxElement;
type Log = blessed.Widgets.Log;

const PHASE_COLOR = { run: C.accent, success: C.ok, needs: C.bad, waiting: C.warn, error: C.bad } as const;

const CARD_H = 6;
const CARD_GAP = 1;
/**
 * How the agents are drawn, by the room the panel has: six cards in a row from
 * 84 columns, two rows of three from 54 (taller), otherwise one text row each.
 */
const ROW_MIN_WIDTH = 84;
const ROW_MIN_HEIGHT = 27;
const GRID_MIN_WIDTH = 54;
const GRID_MIN_HEIGHT = 31;
const GRID_COLUMNS = 3;
type AgentsMode = 'row' | 'grid' | 'rows';
/** Event lines kept in view under the cards; the feed still scrolls. */
const FEED_ROWS = 3;

// Rows inside the panel: ticket, meta, air, step line, progress bar, air, the agents, air, the handoff, air, the feed.
const HEAD_TOP = PANEL_HEAD;
const STEPS_TOP = HEAD_TOP + 3;
const DESKS_TOP = STEPS_TOP + 3;
const DESK_ROWS = 6;

export interface FloorWidget {
  /** Redraws from `view`; `frame` drives the spinners, `now` the elapsed clock. */
  render(view: FloorView | null, frame: number, now: number, followLive: boolean): void;
  focus(): void;
  box: Box;
}

/**
 * The "Agent Floor" panel: ticket, step line, the agents, last handoff and the
 * event feed — a text twin of the web Agent Floor. With room it draws one card
 * per agent side by side; on a small panel it falls back to one row per agent.
 */
export function createFloorWidget(parent: blessed.Widgets.Screen, pos: { top: number | string; left: number | string; width: number | string; height: number | string }): FloorWidget {
  const panel = createPanel(parent);
  Object.assign(panel.box, pos);
  const box = panel.box;
  const inner = { parent: box, left: PANEL_PAD_X, width: `100%-${PANEL_PAD_X * 2}`, tags: true, style: { bg: C.panel, fg: C.text } } as const;
  const head = blessed.box({ ...inner, top: HEAD_TOP, height: 2 });
  const steps = blessed.box({ ...inner, top: STEPS_TOP, height: 2 });
  const cards = DESKS.map(() => createCard(box));
  const rows = blessed.box({ ...inner, top: DESKS_TOP, height: DESK_ROWS });
  const handoff = blessed.box({ ...inner, top: DESKS_TOP + DESK_ROWS + 1, height: 1 });
  const feed: Log = blessed.log({
    ...inner,
    top: DESKS_TOP + DESK_ROWS + 3,
    height: FEED_ROWS,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    scrollbar: { ch: ' ', style: { bg: C.faint } },
  });

  let renderedFeed = 0;
  let renderedKey = '';
  let lastLayout = '';
  const innerWidth = () => Math.max(20, ((box.width as number) || 80) - PANEL_PAD_X * 2);

  /** Cards or rows, decided from the size the panel has right now; moves the blocks under the agents to match. */
  function layout(): AgentsMode {
    const h = (box.height as number) || 0;
    const w = innerWidth();
    const mode: AgentsMode = w >= ROW_MIN_WIDTH && h >= ROW_MIN_HEIGHT ? 'row' : w >= GRID_MIN_WIDTH && h >= GRID_MIN_HEIGHT ? 'grid' : 'rows';
    const deskH = mode === 'row' ? CARD_H : mode === 'grid' ? CARD_H * 2 + 1 : DESK_ROWS;
    const handoffTop = DESKS_TOP + deskH + 1;
    const feedTop = handoffTop + 2;
    const feedH = Math.max(1, Math.min(mode === 'rows' ? 99 : FEED_ROWS, h - PANEL_FOOT - feedTop));
    const key = `${mode}|${w}|${feedTop}|${feedH}`;
    if (key !== lastLayout) {
      lastLayout = key;
      if (mode === 'rows') {
        for (const c of cards) c.box.hide();
        rows.show();
      } else {
        const perRow = mode === 'row' ? DESKS.length : GRID_COLUMNS;
        const spans = splitGap(w, perRow, mode === 'row' ? CARD_GAP : 2);
        cards.forEach((c, i) => {
          const span = spans[i % perRow];
          Object.assign(c.box, { top: DESKS_TOP + Math.floor(i / perRow) * (CARD_H + 1), left: PANEL_PAD_X + span.left, width: span.width, height: CARD_H });
          c.box.show();
        });
        rows.hide();
      }
      Object.assign(handoff, { top: handoffTop });
      Object.assign(feed, { top: feedTop, height: feedH });
      feed.setScrollPerc(100);
    }
    return mode;
  }

  return {
    box,
    focus: () => feed.focus(),
    render(view, frame, now, followLive) {
      const cardsMode = layout() !== 'rows';
      const mode = followLive ? fg(C.ok, 'live') : faint('pinned · F follows live');
      if (!view || !view.title) {
        panel.setTitle(bold('Agent floor'));
        head.setContent(dim('No run selected. The floor lights up when the worker picks up a ticket.'));
        steps.setContent('');
        rows.setContent('');
        cards.forEach((c, i) => c.set(['', dim(DESK_NAME[DESKS[i]]), faint('○ Idle')], null));
        handoff.setContent(mode);
        return;
      }

      const color = PHASE_COLOR[view.phase];
      panel.setTitle(`${bold('Agent floor')}   ${fg(color, `● ${view.pill}`)}   ${mode}`);
      const elapsed = view.startedAt ? formatElapsed(view.startedAt, view.phase === 'run' ? null : lastEventIso(view), now) : '-';
      const total = view.desks.reduce((sum, d) => sum + (d.costUsd ?? 0), 0);
      head.setContent(`${bold(escapeTags(truncate(view.title, innerWidth() - 2)))}\n${dim(escapeTags(truncate(view.meta, innerWidth() - 24)))}   ${dim(`◴ ${elapsed}`)}${total > 0 ? `   ${dim(formatCost(total))}` : ''}`);

      const pct = Math.round(view.progress * 100);
      const ac = view.ac ? `   ${dim('AC')} ${fg(C.ok, `${view.ac.pass}✔`)} ${fg(C.bad, `${view.ac.fail}✘`)} ${fg(C.warn, `${view.ac.unverified}?`)}${dim(`/${view.ac.total}`)}` : '';
      steps.setContent(`${stepLine(view.steps, frame)}\n${thinBar(view.progress, Math.min(32, innerWidth() - 8), color)}  ${dim(`${pct}%`)}${ac}`);

      if (cardsMode) {
        view.desks.forEach((d, i) => {
          const card = deskCard(d, frame, Math.max(6, ((cards[i].box.width as number) || 12) - 2));
          cards[i].set(card.lines, card.bar);
        });
      } else {
        rows.setContent(view.desks.map((d) => deskLine(d, frame, innerWidth() - 2)).join('\n'));
      }

      handoff.setContent(
        view.lastHandoff
          ? `${faint('handoff')}  ${DESK_NAME[view.lastHandoff.from]} ${fg(C.accent, '→')} ${view.lastHandoff.to === 'outbox' ? 'PR outbox' : DESK_NAME[view.lastHandoff.to]}   ${faint(escapeTags(view.lastHandoff.file))}`
          : faint('no handoff yet'),
      );

      // The feed is append-only per run; rebuild only when the run changed or events were rewound.
      const key = `${view.title}|${view.startedAt}`;
      if (key !== renderedKey || view.feed.length < renderedFeed) {
        feed.setContent('');
        renderedFeed = 0;
        renderedKey = key;
      }
      for (const line of view.feed.slice(renderedFeed)) {
        feed.add(`${faint(formatOffset(line.atMs))}  ${fg(line.tone === 'info' ? C.dim : TONE_COLOR[line.tone], escapeTags(line.text))}`);
      }
      renderedFeed = view.feed.length;
    },
  };
}

function lastEventIso(view: FloorView): string | null {
  // Finished runs freeze their clock at the last feed line.
  if (!view.startedAt || view.feed.length === 0) return null;
  return new Date(Date.parse(view.startedAt) + view.feed[view.feed.length - 1].atMs).toISOString();
}
