import type { StatTile } from '../../application/view-models/stat-tiles.js';
import { bold, C, dim, faint, fg } from '../theme.js';
import { visibleLength } from './header.js';
import { escapeTags } from './markup.js';

/** The five summary tiles as one dim-labelled line: `◉ 0 active   ✔ 3 completed (43% success rate) ...`. */

const LABEL: Record<StatTile['id'], string> = { active: 'active', completed: 'completed', waiting: 'waiting on you', attention: 'need attention', spend: 'spend' };
const TONE: Record<StatTile['id'], string> = { active: C.accent, completed: C.ok, waiting: C.warn, attention: C.bad, spend: C.purple };

function item(t: StatTile, frame: number, withCaption: boolean): string {
  const live = t.count > 0;
  // The Active glyph breathes while a run is going.
  const glyph = t.id === 'active' && live && frame % 4 < 2 ? '◎' : t.glyph;
  const head = `${fg(live ? TONE[t.id] : C.faint, glyph)} ${live ? bold(t.value) : dim(t.value)} ${dim(LABEL[t.id])}`;
  if (t.id === 'spend') return `${head}${live ? ` ${fg(C.purple, t.bar)}` : ''}${withCaption ? `  ${faint(escapeTags(t.caption))}` : ''}`;
  // A caption only earns its width when the tile has something in it (the success rate is always useful).
  return withCaption && (live || t.id === 'completed') ? `${head} ${faint(`(${escapeTags(t.caption)})`)}` : head;
}

/** Builds the strip; drops the captions when the full line would not fit `width`. */
export function renderStatStrip(tiles: readonly StatTile[], frame: number, width: number): string {
  const sep = '    ';
  const full = tiles.map((t) => item(t, frame, true)).join(sep);
  if (visibleLength(full) <= width) return full;
  return tiles.map((t) => item(t, frame, false)).join(sep);
}

export interface CardContent {
  lines: string[];
  /** Colour of the hairline along the card's top; null when the tile is empty. */
  bar: string | null;
}

/** One summary tile as a card: small label, the number, a caption. Only a tile with something in it takes colour. */
export function renderStatCard(t: StatTile, frame: number, width: number): CardContent {
  const live = t.count > 0;
  const glyph = t.id === 'active' && live && frame % 4 < 2 ? '◎' : t.glyph;
  const value = `${fg(live ? TONE[t.id] : C.faint, glyph)} ${live ? bold(t.value) : dim(t.value)}`;
  const spark = t.id === 'spend' && live ? `  ${fg(C.purple, t.bar)}` : '';
  return {
    lines: ['', dim(t.label), `${value}${spark}`, faint(escapeTags(t.caption.length > width ? `${t.caption.slice(0, Math.max(0, width - 1))}…` : t.caption))],
    bar: live ? TONE[t.id] : null,
  };
}
