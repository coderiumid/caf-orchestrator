import blessed from 'neo-blessed';
import type { PipelineRunApiShape } from '../../../infrastructure/db/pipeline-run-shape.js';
import { buildStatTiles } from '../../application/view-models/stat-tiles.js';
import { renderStatCard, renderStatStrip } from '../formatters/stat-strip.js';
import { splitGap } from '../layout.js';
import { C } from '../theme.js';
import { createCard } from './card.js';

/** Cards of six rows (the last one is padding), and one row of air under them. */
export const TILES_H_CARDS = 7;
/** The one-line strip used on short terminals, and one row of air. */
export const TILES_H_STRIP = 2;
const TILE_COUNT = 5;
const CARD_GAP = 2;
const STRIP_INSET = 2;

export interface StatTiles {
  /** Place the tiles at row `top`/column `left`, `width` columns wide; `compact` swaps the cards for the one-line strip. */
  layout(top: number, left: number, width: number, compact: boolean): void;
  render(runs: readonly PipelineRunApiShape[], frame: number): void;
}

/** The summary numbers (active, completed, waiting, attention, spend) as five quiet cards, or a single line when space is tight. */
export function createStatTiles(screen: blessed.Widgets.Screen): StatTiles {
  const cards = Array.from({ length: TILE_COUNT }, () => createCard(screen, C.panel, 2));
  const strip = blessed.box({ parent: screen, top: 0, left: 0, width: 10, height: 1, tags: true, style: { bg: C.base, fg: C.text } });
  let compact = false;
  let width = 0;
  return {
    layout(top, left, total, isCompact) {
      compact = isCompact;
      // The strip is bare text, so it keeps the same inset as the header.
      width = total - 2 * STRIP_INSET;
      Object.assign(strip, { top, left: left + STRIP_INSET, width });
      splitGap(total, TILE_COUNT, CARD_GAP).forEach((span, i) => Object.assign(cards[i].box, { top, left: left + span.left, width: span.width, height: 6 }));
      for (const c of cards) {
        if (compact) c.box.hide();
        else c.box.show();
      }
      if (compact) strip.show();
      else strip.hide();
    },
    render(runs, frame) {
      const tiles = buildStatTiles(runs, 6);
      if (compact) {
        strip.setContent(renderStatStrip(tiles, frame, width));
        return;
      }
      tiles.forEach((t, i) => {
        const card = renderStatCard(t, frame, Math.max(6, ((cards[i].box.width as number) || 12) - 4));
        cards[i].set(card.lines, card.bar);
      });
    },
  };
}
