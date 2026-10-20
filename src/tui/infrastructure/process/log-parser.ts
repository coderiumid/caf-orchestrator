import { LOG_LEVELS, type LogLevel, type LogLine } from '../../domain/models/log-line.js';

const CLOUDFLARED_LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(TRC|DBG|INF|WRN|ERR|FTL)\s+(.*)$/;
const CLOUDFLARED_LEVELS: Record<string, LogLevel> = { TRC: 'trace', DBG: 'debug', INF: 'info', WRN: 'warn', ERR: 'error', FTL: 'fatal' };
const PINO_NUMERIC: Record<number, LogLevel> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

function toLevel(value: unknown): LogLevel {
  if (typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  if (typeof value === 'number' && PINO_NUMERIC[value]) return PINO_NUMERIC[value];
  return 'info';
}

/** Parses one stdout/stderr line: pino JSON when possible, otherwise raw text (stderr counts as error). */
export function parseLogLine(source: LogLine['source'], raw: string, now: number = Date.now(), fromStderr = false): LogLine {
  const text = raw.replace(/\r$/, '');
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const { level, time, msg, ...fields } = obj;
      delete fields.pid;
      delete fields.hostname;
      return {
        source,
        level: toLevel(level),
        time: typeof time === 'number' ? time : now,
        message: typeof msg === 'string' ? msg : text,
        fields,
      };
    } catch {
      // fall through to raw
    }
  }
  // cloudflared logs plain text to stderr: `2026-06-18T13:39:02Z INF Registered tunnel connection ...`.
  const cf = CLOUDFLARED_LINE.exec(text);
  if (cf) {
    const time = Date.parse(cf[1]);
    return { source, level: CLOUDFLARED_LEVELS[cf[2]] ?? 'info', time: Number.isNaN(time) ? now : time, message: cf[3], fields: {} };
  }
  return { source, level: fromStderr ? 'error' : 'info', time: now, message: text, fields: {} };
}

/** Splits a stream chunk into complete lines, carrying a partial trailing line over to the next chunk. */
export class LineSplitter {
  private rest = '';

  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split('\n');
    this.rest = parts.pop() ?? '';
    return parts.filter((l) => l.length > 0);
  }

  flush(): string[] {
    const out = this.rest.length > 0 ? [this.rest] : [];
    this.rest = '';
    return out;
  }
}
