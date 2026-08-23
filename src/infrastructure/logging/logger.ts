import pino from 'pino';
import type { ILogger } from './logger.interface.js';

const SENSITIVE_KEYS = [
  'LINEAR_API_KEY',
  'LINEAR_WEBHOOK_SECRET',
  'authorization',
  'password',
  'token',
  'secret',
];

const isDev = process.env['NODE_ENV'] !== 'production';
const logLevel = process.env['LOG_LEVEL'] ?? 'info';
const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const level = validLevels.includes(logLevel) ? logLevel : 'info';

const pinoLogger = pino({
  level,
  redact: {
    paths: SENSITIVE_KEYS,
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {
        formatters: {
          level: (label: string) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.epochTime,
      }),
});

class PinoLogger implements ILogger {
  constructor(private readonly logger: pino.Logger) {}

  trace(msg: string, ...args: unknown[]): void {
    this.logger.trace(args[0] ?? {}, msg);
  }

  debug(msg: string, ...args: unknown[]): void {
    this.logger.debug(args[0] ?? {}, msg);
  }

  info(msg: string, ...args: unknown[]): void {
    this.logger.info(args[0] ?? {}, msg);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.logger.warn(args[0] ?? {}, msg);
  }

  error(msg: string, err?: Error, ...args: unknown[]): void {
    this.logger.error({ err, ...((args[0] as object) ?? {}) }, msg);
  }

  fatal(msg: string, err?: Error, ...args: unknown[]): void {
    this.logger.fatal({ err, ...((args[0] as object) ?? {}) }, msg);
  }

  child(bindings: Record<string, unknown>): ILogger {
    return new PinoLogger(this.logger.child(bindings));
  }
}

export const logger: ILogger = new PinoLogger(pinoLogger);
export { pinoLogger };
