import blessed from 'neo-blessed';
import { C, fg } from '../theme.js';

type Box = blessed.Widgets.BoxElement;

export interface Card {
  /** The card surface; position and size it with `Object.assign`. */
  box: Box;
  /** Replaces the content (one string per row) and the thin accent line along the top; `null` leaves the top plain. */
  set(lines: readonly string[], bar: string | null): void;
}

/**
 * A small borderless tile: a raised surface with `padX` cells of padding (default one), and a
 * hairline (`▔`) along its top edge that carries the tile's state colour.
 */
export function createCard(parent: blessed.Widgets.Node, bg: string = C.raised, padX = 1): Card {
  const box = blessed.box({ parent, top: 0, left: 0, width: 10, height: 5, tags: true, style: { bg, fg: C.text } });
  const bar = blessed.box({ parent: box, top: 0, left: 0, width: '100%', height: 1, tags: true, style: { bg, fg: C.text } });
  const body = blessed.box({ parent: box, top: 1, left: padX, width: `100%-${padX * 2}`, height: '100%-1', tags: true, style: { bg, fg: C.text } });
  return {
    box,
    set(lines, color) {
      bar.setContent(color ? fg(color, '▔'.repeat(Math.max(1, (box.width as number) || 1))) : '');
      body.setContent(lines.join('\n'));
    },
  };
}
