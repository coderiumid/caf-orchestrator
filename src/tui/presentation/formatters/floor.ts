import { checksText, type DeskView, type StepView, type Tone } from '../../application/view-models/floor.js';
import { formatCost, formatDuration, pad, truncate } from '../../shared/format.js';
import { bold, C, dim, faint, fg } from '../theme.js';
import { escapeTags } from './markup.js';

/** Glyphs, colours and markup for the Agent Floor. Pure strings, no blessed. */

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Glyph for a desk at animation frame `frame` — a spinner while the agent runs, static otherwise. */
export function deskGlyph(d: DeskView, frame: number): string {
  if (d.working) return SPINNER[frame % SPINNER.length];
  switch (d.state) {
    case 'celebrating':
      return frame % 2 === 0 ? '★' : '☆';
    case 'retrying':
      return '↻';
    case 'blocked':
      return '⊘';
    case 'error':
      return '✖';
    case 'alert':
      return d.tone === 'ok' ? '✔' : '!';
    case 'offduty':
      return '·';
    default:
      return '○';
  }
}

export function progressBar(fraction: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** A thin two-tone bar: `color` for the done part, faint for the rest. */
export function thinBar(fraction: number, width: number, color: string): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return `${fg(color, '━'.repeat(filled))}${faint('━'.repeat(width - filled))}`;
}

export function formatOffset(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  return `+${String(mm).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const TONE_COLOR: Record<Tone, string> = { info: C.text, ok: C.ok, warn: C.warn, bad: C.bad };

const STEP_SHORT: Record<string, string> = { plan: 'plan', spec: 'spec', impl: 'impl', qa: 'validate', review: 'review', pr: 'PR' };

function stepMark(s: StepView, frame: number): string {
  switch (s.status) {
    case 'pass':
      return fg(C.ok, '✔');
    case 'fail':
      return fg(C.bad, '✘');
    case 'active':
      return fg(C.accent, ['◐', '◓', '◑', '◒'][frame % 4]);
    default:
      return faint('○');
  }
}

/** `✔ plan ─ ✔ impl ─ ◐ validate ─ ○ review ─ ○ PR`, the active step in the accent colour. */
export function stepLine(steps: readonly StepView[], frame: number): string {
  return steps
    .map((s) => {
      const label = STEP_SHORT[s.step] ?? s.step;
      const color = s.status === 'pass' ? C.ok : s.status === 'fail' ? C.bad : s.status === 'active' ? C.accent : C.faint;
      return `${stepMark(s, frame)} ${fg(color, label)}`;
    })
    .join(faint(' ─ '));
}

/** Colour of a desk's glyph and text: status colours for trouble, the accent while working, quiet otherwise. */
function deskColor(d: DeskView): string {
  if (d.state === 'alert' || d.state === 'blocked' || d.state === 'error' || d.state === 'retrying') return TONE_COLOR[d.tone] === C.text ? C.text : TONE_COLOR[d.tone];
  if (d.working) return C.accent;
  if (d.state === 'celebrating') return C.ok;
  return d.state === 'offduty' ? C.faint : C.dim;
}

/** Word-wraps `text` into at most `rows` lines of `width` characters; the last line is cut with an ellipsis. */
function wrap(text: string, width: number, rows: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) line = next;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > rows ? [...lines.slice(0, rows - 1), truncate(lines.slice(rows - 1).join(' '), width)] : lines;
}

/** Colour of the hairline on a desk card: only an agent with something going on gets one. */
function deskBar(d: DeskView): string | null {
  if (d.working) return C.accent;
  if (d.state === 'alert' || d.state === 'blocked' || d.state === 'error' || d.state === 'retrying') return TONE_COLOR[d.tone] === C.text ? null : TONE_COLOR[d.tone];
  return d.state === 'celebrating' ? C.ok : null;
}

/**
 * One agent as a card: name, state, cost and duration, check results. An idle
 * agent is dimmed and stays at one line of substance; the Manager's sentence
 * wraps over the card instead of being cut off. `width` is the printable width.
 */
export function deskCard(d: DeskView, frame: number, width: number): { lines: string[]; bar: string | null } {
  const color = deskColor(d);
  const idle = !d.working && (d.state === 'idle' || d.state === 'offduty');
  const name = idle ? dim(d.name) : bold(d.name);
  if (d.id === 'human') {
    return { lines: ['', name, ...wrap(d.text, width, 3).map((l) => fg(color, escapeTags(l)))], bar: deskBar(d) };
  }
  const state = `${fg(color, deskGlyph(d, frame))} ${fg(color, escapeTags(truncate(d.text, Math.max(4, width - 2))))}`;
  const spent = [d.costUsd !== null ? formatCost(d.costUsd) : '', d.durationMs !== null ? formatDuration(d.durationMs) : ''].filter(Boolean).join('  ');
  return { lines: ['', name, state, spent ? dim(spent) : faint('–'), d.verify ? faint(escapeTags(truncate(checksText(d.verify), width))) : ''], bar: deskBar(d) };
}

const NAME_W = 10;
const COST_W = 6;
const TIME_W = 7;

/**
 * One agent as one row: glyph, name, what it is doing, cost, duration. `width`
 * is the printable width. The Manager has no cost, so its sentence takes the
 * whole row.
 */
export function deskLine(d: DeskView, frame: number, width: number): string {
  const color = deskColor(d);
  const idle = !d.working && (d.state === 'idle' || d.state === 'offduty');
  const name = idle ? dim(pad(d.name, NAME_W)) : pad(d.name, NAME_W);
  const head = `${fg(color, deskGlyph(d, frame))} ${name} `;
  const fixed = 2 + NAME_W + 1;
  if (d.id === 'human') return `${head}${fg(color, escapeTags(truncate(d.text, Math.max(8, width - fixed))))}`;
  const detail = d.verify ? `${d.text} · ${checksText(d.verify)}` : d.text;
  const textW = Math.max(8, width - fixed - COST_W - TIME_W - 2);
  const cost = d.costUsd !== null ? formatCost(d.costUsd) : '';
  const time = d.durationMs !== null ? formatDuration(d.durationMs) : '';
  return `${head}${fg(color, escapeTags(pad(detail, textW)))} ${dim(cost.padStart(COST_W))} ${dim(time.padStart(TIME_W))}`;
}
