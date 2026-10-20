/** Pure value formatters shared by every layer. No markup, no I/O. */

export function formatElapsed(startedAt: string, endedAt: string | null, now: number = Date.now()): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return '-';
  const secs = Math.max(0, Math.round(((endedAt ? Date.parse(endedAt) : now) - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function formatCost(value: number | null): string {
  return value === null ? '-' : `$${value.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function pad(text: string, width: number): string {
  const t = truncate(text, width);
  return t + ' '.repeat(Math.max(0, width - t.length));
}
