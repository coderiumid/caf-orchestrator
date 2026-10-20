import type { LogLine } from '../../domain/models/log-line.js';
import { C, dim, faint, fg } from '../theme.js';
import { escapeTags } from './markup.js';

const LEVEL_COLOR: Record<LogLine['level'], string> = {
  trace: C.faint,
  debug: C.faint,
  info: C.faint,
  warn: C.warn,
  error: C.bad,
  fatal: C.bad,
};
const LEVEL_TAG: Record<LogLine['level'], string> = { trace: 'trce', debug: 'debg', info: 'info', warn: 'warn', error: 'erro', fatal: 'fatl' };
const SOURCE_COLOR: Record<LogLine['source'], string> = { server: C.info, worker: C.purple, tunnel: C.warn };

/** One log line as blessed markup: quiet timestamp and level, a coloured source, and the message in full strength (tinted for warn and up). */
export function formatLogLine(line: LogLine): string {
  const t = new Date(line.time).toTimeString().slice(0, 8);
  const src = line.source === 'server' ? 'srv' : line.source === 'tunnel' ? 'tnl' : 'wrk';
  const extras = Object.entries(line.fields)
    .slice(0, 6)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
  const body = escapeTags(extras ? `${line.message} ${dim(extras)}` : line.message);
  const loud = line.level === 'warn' || line.level === 'error' || line.level === 'fatal';
  return `${faint(t)} ${fg(SOURCE_COLOR[line.source], src)} ${fg(LEVEL_COLOR[line.level], LEVEL_TAG[line.level])} ${loud ? fg(LEVEL_COLOR[line.level], body) : body}`;
}
