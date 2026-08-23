export interface ILogger {
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, err?: Error, ...args: unknown[]): void;
  fatal(msg: string, err?: Error, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): ILogger;
}
