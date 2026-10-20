import blessed from 'neo-blessed';
import { renderHeaderLines, type HeaderInput } from '../formatters/header.js';
import { C } from '../theme.js';

/** Two content lines with a blank line between them and one under. */
export const HEADER_H = 4;

export interface HeaderBar {
  /** Place the bar `left` columns in and `width` wide; the content fills that width. */
  layout(left: number, width: number): void;
  render(input: HeaderInput): void;
}

/** Slim banner: brand and clock, then process dots, dependency health and the queue. No frame; the dots carry the state. */
export function createHeaderBar(screen: blessed.Widgets.Screen): HeaderBar {
  const box = blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: HEADER_H, tags: true, style: { bg: C.base, fg: C.text } });
  return {
    layout(left, width) {
      Object.assign(box, { left, width });
    },
    render(input) {
      box.setContent(renderHeaderLines(input).join('\n\n'));
    },
  };
}
