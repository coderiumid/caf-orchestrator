import type { ProcessName, ProcessState } from '../domain/models/process.js';

/**
 * Decides what a process button or key should do, including whether to ask
 * first. Pure: the UI executes the plan, so the rules are testable without a
 * terminal.
 */

export type PlanAction = 'start' | 'stop' | 'force' | 'restart' | 'startAll' | 'stopAll';

export interface ProcessPlan {
  action: PlanAction;
  /** When set, ask this question before doing it. */
  confirm?: string;
}

const ACTIVE: ReadonlySet<ProcessState> = new Set(['starting', 'running', 'stopping']);

export function isActiveState(state: ProcessState): boolean {
  return ACTIVE.has(state);
}

/** The s / w / n keys and the process buttons. */
export function planToggle(name: ProcessName, state: ProcessState, activeJobs: number): ProcessPlan {
  if (!isActiveState(state)) return { action: 'start' };
  if (state === 'stopping') return { action: 'force', confirm: `${name} is still stopping. Force kill (SIGKILL) now?` };
  if (name === 'worker' && activeJobs > 0) {
    return { action: 'stop', confirm: `Worker has ${activeJobs} active job(s). Stop waits for the job to finish (up to the agent timeout).\nStop gracefully?` };
  }
  return { action: 'stop' };
}

/** The ALL button: starts what is stopped, or stops whatever runs. */
export function planAll(anyActive: boolean, activeJobs: number): ProcessPlan {
  if (!anyActive) return { action: 'startAll' };
  return activeJobs > 0 ? { action: 'stopAll', confirm: `Worker has ${activeJobs} active job(s). Stop everything gracefully?` } : { action: 'stopAll' };
}

/** Start order for ALL: the tunnel joins only when TUNNEL_URL is set. */
export function startAllOrder(tunnelInAll: boolean): ProcessName[] {
  return tunnelInAll ? ['server', 'tunnel', 'worker'] : ['server', 'worker'];
}

export function planRestart(name: ProcessName, activeJobs: number): ProcessPlan {
  return name === 'worker' && activeJobs > 0 ? { action: 'restart', confirm: `Worker has ${activeJobs} active job(s). Restart anyway?` } : { action: 'restart' };
}

const KILL_CONSEQUENCE: Record<ProcessName, string> = {
  worker: 'A running job will be interrupted and retried by BullMQ.',
  tunnel: 'Webhooks stop reaching this machine until it is started again.',
  server: 'In-flight requests are dropped.',
};

export function planKill(name: ProcessName): ProcessPlan {
  return { action: 'force', confirm: `SIGKILL the ${name} immediately? ${KILL_CONSEQUENCE[name]}` };
}

export function planQuit(anyActive: boolean): { confirm?: string } {
  return anyActive ? { confirm: 'Quit? This stops the server, worker and tunnel (the worker waits for a running job).' } : {};
}
