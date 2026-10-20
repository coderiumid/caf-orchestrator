export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogLine {
  source: 'server' | 'worker' | 'tunnel';
  level: LogLevel;
  time: number;
  message: string;
  /** Remaining pino bindings (jobId, durationMs, ...), empty for raw text lines. */
  fields: Record<string, unknown>;
}

export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

export function levelAtLeast(level: LogLevel, min: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(min);
}
