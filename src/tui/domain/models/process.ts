export type ProcessName = 'server' | 'worker' | 'tunnel';
export const PROCESS_NAMES: readonly ProcessName[] = ['server', 'worker', 'tunnel'];
export type ProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';
/** How server and worker are launched: `tsx src/...` (dev) or `node dist/...`. */
export type RunMode = 'dev' | 'dist';

export interface ProcessStatus {
  name: ProcessName;
  state: ProcessState;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
}
