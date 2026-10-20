import type { LogLine } from '../models/log-line.js';
import type { ProcessName, ProcessStatus, RunMode } from '../models/process.js';

/** What the UI needs from whatever runs server, worker and tunnel. Events: 'status' (ProcessStatus), 'log' (LogLine). */
export interface IProcessController {
  getStatus(name: ProcessName): ProcessStatus;
  getLogs(): readonly LogLine[];
  getMode(): RunMode;
  /** False (and no change) while server or worker run. */
  setMode(mode: RunMode): boolean;
  isActive(name: ProcessName): boolean;
  anyActive(): boolean;
  start(name: ProcessName): boolean;
  /** SIGTERM, then SIGKILL after the process's grace period. */
  stop(name: ProcessName): boolean;
  /** Immediate SIGKILL. */
  forceKill(name: ProcessName): boolean;
  restart(name: ProcessName): void;
  /** Graceful stop of everything; resolves when all exited. */
  stopAll(): Promise<void>;
  /** Synchronous best-effort SIGKILL of everything — no child may outlive the UI. */
  killAllNow(): void;
  on(event: 'status', listener: (status: ProcessStatus) => void): unknown;
  on(event: 'log', listener: (line: LogLine) => void): unknown;
}
