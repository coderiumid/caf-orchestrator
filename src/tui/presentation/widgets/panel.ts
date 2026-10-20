import blessed from 'neo-blessed';
import { C } from '../theme.js';

type Screen = blessed.Widgets.Screen;
type Box = blessed.Widgets.BoxElement;

/** Columns of air between a panel's edge and its content. */
export const PANEL_PAD_X = 2;
/** Rows a panel spends above its content: one of air, the title line, one blank line. */
export const PANEL_HEAD = 3;
/** Rows of air under the content. */
export const PANEL_FOOT = 1;

/** Position of a child that fills a panel's content area, padding included. */
export const PANEL_CONTENT = {
  top: PANEL_HEAD,
  left: PANEL_PAD_X,
  width: `100%-${PANEL_PAD_X * 2}`,
  height: `100%-${PANEL_HEAD + PANEL_FOOT}`,
} as const;

export interface Panel {
  /** The panel surface; position and size it with `Object.assign`. */
  box: Box;
  /** Replaces the title line (blessed markup). */
  setTitle(markup: string): void;
}

/**
 * A borderless surface: a slightly lighter grey than the screen, with a title
 * line on top. Panels are separated by the dark gap between them, not by
 * outlines. Children go inside `PANEL_CONTENT`.
 */
export function createPanel(screen: Screen, bg: string = C.panel): Panel {
  const box = blessed.box({ parent: screen, top: 0, left: 0, width: 10, height: 5, tags: true, style: { bg, fg: C.text } });
  const title = blessed.box({ parent: box, top: 1, left: PANEL_PAD_X, width: `100%-${PANEL_PAD_X * 2}`, height: 1, tags: true, style: { bg, fg: C.dim } });
  return { box, setTitle: (markup) => title.setContent(markup) };
}
