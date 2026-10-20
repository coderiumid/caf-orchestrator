import { visibleLength } from './header.js';
import { bold, C, dim, fg } from '../theme.js';

export type KeyHint = readonly [key: string, label: string];

/** Most useful first: the footer keeps as many as fit and drops the tail. */
export const DEFAULT_HINTS: readonly KeyHint[] = [
  ['↑↓', 'select'],
  ['enter', 'inspect'],
  ['ctrl+p', 'commands'],
  ['/', 'search'],
  ['f', 'status'],
  ['`', 'logs'],
  ['u', 'queue'],
  ['?', 'help'],
  ['q', 'quit'],
];

/** `ctrl+p commands` with the key bold and the label dim, joined by wide gaps; cut at `width`. */
export function renderKeyHints(hints: readonly KeyHint[], width: number): string {
  let out = ' ';
  for (const [key, label] of hints) {
    const next = `${fg(C.text, bold(key))} ${dim(label)}`;
    const candidate = out === ' ' ? ` ${next}` : `${out}    ${next}`;
    if (visibleLength(candidate) > width) break;
    out = candidate;
  }
  return out;
}
