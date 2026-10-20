import type { ToastSpec } from '../domain/models/toast.js';
import type { ProcessName, ProcessStatus } from '../domain/models/process.js';

const NAME: Record<ProcessName, string> = { server: 'Server', worker: 'Worker', tunnel: 'Tunnel' };

/** A toast for a process status change, or null when it isn't worth interrupting for. */
export function transitionToast(prev: ProcessStatus | undefined, next: ProcessStatus): ToastSpec | null {
  if (prev && prev.state === next.state) return null;
  const n = NAME[next.name];
  switch (next.state) {
    case 'running':
      return { tone: 'ok', text: `${n} is up${next.pid ? ` (pid ${next.pid})` : ''}` };
    case 'stopped':
      return prev && prev.state !== 'stopped' ? { tone: 'info', text: `${n} stopped` } : null;
    case 'crashed':
      return { tone: 'bad', text: `${n} crashed${next.exitCode !== null ? ` (exit ${next.exitCode})` : ''} — see logs` };
    case 'stopping':
      return { tone: 'warn', text: `Stopping ${n.toLowerCase()}…${next.name === 'worker' ? ' waiting for the running job' : ''}` };
    default:
      return null;
  }
}
