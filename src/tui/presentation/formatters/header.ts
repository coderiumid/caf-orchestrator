import type { HealthInfo, QueueCounts } from '../../domain/interfaces/data-source.interface.js';
import type { ProcessState, ProcessStatus, RunMode } from '../../domain/models/process.js';
import { formatDuration } from '../../shared/format.js';
import { bold, C, dim, faint, fg } from '../theme.js';

/** Pure builder for the header's two content lines (blessed tag markup). No blessed import, so it's testable. */

export interface HeaderInput {
  version: string;
  now: number;
  frame: number;
  width: number;
  server: ProcessStatus;
  worker: ProcessStatus;
  health: HealthInfo;
  queue: QueueCounts | null;
  mode: RunMode;
  port: number;
  /** null when ENABLE_PIPELINE_TRIGGER is unset. */
  trigger: boolean | null;
  activeRuns: number;
  tunnel: ProcessStatus;
}

const TAG = /\{[^}]*\}/g;

/** Printed width of a tagged string. */
export function visibleLength(tagged: string): number {
  return tagged.replace(TAG, '').length;
}

/** Left text, then right text flush to `width` (falls back to a single space when it doesn't fit). */
export function justify(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${' '.repeat(gap)}${right}`;
}

/** "CAF" in the accent colour, then the product name. */
export function logo(): string {
  return `${fg(C.accent, bold('CAF'))} ${bold('Orchestrator')}`;
}

const STATE_STYLE: Record<ProcessState, { color: string; dot: string }> = {
  stopped: { color: C.faint, dot: '○' },
  starting: { color: C.warn, dot: '◌' },
  running: { color: C.ok, dot: '●' },
  stopping: { color: C.warn, dot: '◌' },
  crashed: { color: C.bad, dot: '✖' },
};

const HEALTH_STYLE: Record<string, { color: string; dot: string }> = {
  up: { color: C.ok, dot: '●' },
  missing: { color: C.warn, dot: '◌' },
  down: { color: C.bad, dot: '✖' },
};

/** `● server ↑11s`: a status dot, the name, and one dim detail. */
function processItem(label: string, s: ProcessStatus, now: number, frame: number): string {
  const st = STATE_STYLE[s.state];
  // Starting/stopping blink so a slow worker stop visibly "does something".
  const dot = (s.state === 'starting' || s.state === 'stopping') && frame % 4 >= 2 ? ' ' : st.dot;
  let detail: string;
  switch (s.state) {
    case 'running':
      detail = dim(s.startedAt !== null ? `↑${formatDuration(now - s.startedAt)}` : 'running');
      break;
    case 'crashed':
      detail = fg(C.bad, s.exitCode !== null ? `crashed exit ${s.exitCode}` : 'crashed');
      break;
    case 'starting':
    case 'stopping':
      detail = fg(C.warn, s.state);
      break;
    default:
      detail = faint('off');
  }
  const name = s.state === 'stopped' ? dim(label) : label;
  return `${fg(st.color, dot)} ${name} ${detail}`;
}

function healthItem(label: string, status: string): string {
  const st = HEALTH_STYLE[status] ?? HEALTH_STYLE.down;
  return `${fg(st.color, st.dot)} ${dim(label)}${status === 'up' ? '' : ` ${fg(st.color, status)}`}`;
}

const FLOW = ['▰▱▱▱▱▱', '▱▰▱▱▱▱', '▱▱▰▱▱▱', '▱▱▱▰▱▱', '▱▱▱▱▰▱', '▱▱▱▱▱▰', '▱▱▱▱▰▱', '▱▱▱▰▱▱', '▱▱▰▱▱▱', '▱▰▱▱▱▱'];

/** A scanning bar while runs are active, a flat one otherwise — the header's heartbeat. */
export function heartbeat(active: boolean, frame: number): string {
  return active ? fg(C.accent, FLOW[frame % FLOW.length]) : faint('▱▱▱▱▱▱');
}

function clock(now: number): string {
  const d = new Date(now);
  const date = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  return `${dim(date)}  ${bold(d.toTimeString().slice(0, 8))}`;
}

const SEP = faint(' · ');

/** Queue flow as plain counts; failures go red, everything else stays quiet. */
function queueText(q: QueueCounts | null): string {
  if (!q) return dim('queue n/a (Redis down?)');
  const failed = q.failed > 0 ? fg(C.bad, `${q.failed} failed`) : faint('0 failed');
  return [`${q.waiting} ${dim('waiting')}`, `${fg(q.active > 0 ? C.accent : C.text, String(q.active))} ${dim('active')}`, `${q.delayed} ${dim('delayed')}`, failed].join(SEP);
}

/** Two lines: brand + clock, then process and dependency status with queue and flags on the right. */
export function renderHeaderLines(i: HeaderInput): [string, string] {
  const w = i.width - 1; // the caller positions the box inside the margin; a line as wide as the box would wrap
  const anyRunning = i.server.state === 'running' || i.worker.state === 'running';
  const version = i.version ? dim(` v${i.version}`) : '';
  const line1 = justify(`${logo()}${version}`, `${heartbeat(anyRunning && i.activeRuns > 0, i.frame)}  ${clock(i.now)}`, w);

  const left = `${processItem('server', i.server, i.now, i.frame)}   ${processItem('worker', i.worker, i.now, i.frame)}   ${processItem('tunnel', i.tunnel, i.now, i.frame)}${faint('   │   ')}${healthItem('redis', i.health.redis)}   ${healthItem('db', i.health.db)}   ${healthItem('http', i.health.server)}`;
  const flags = [i.trigger === null ? '' : `${dim('trigger')} ${i.trigger ? fg(C.ok, 'ON') : fg(C.bad, 'OFF')}`, `${bold(i.mode)}${dim(` :${i.port}`)}`].filter(Boolean).join(SEP);
  const queue = queueText(i.queue);
  // Drop the flags, then the queue, rather than letting the line wrap on a narrow terminal.
  const right = [`${queue}${SEP}${flags}`, queue, ''].find((r) => visibleLength(left) + visibleLength(r) + 3 <= w) ?? '';
  return [line1, justify(left, right, w)];
}
