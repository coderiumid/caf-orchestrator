import type { ProcessName, ProcessState } from '../../domain/models/process.js';

/** Pure description of the action buttons. No blessed import. */

export type ActionId = 'server' | 'worker' | 'tunnel' | 'all' | 'restart' | 'kill' | 'help' | 'queue';

export interface ActionView {
  id: ActionId;
  key: string;
  icon: string;
  /** Full label, used in hints and tests: "START SERVER", "RESTART worker". */
  label: string;
  /** What the button itself shows; short enough for a half-width button: "START SERVER", "RESTART". */
  short: string;
  /** Button fill; the border takes the same colour. */
  bg: string;
  fg: string;
  hoverBg: string;
  disabled: boolean;
  /** Short explanation shown in the footer while the button is hovered. */
  hint: string;
}

export interface ActionsInput {
  server: ProcessState;
  worker: ProcessState;
  tunnel: ProcessState;
  /** False when the tunnel settings are invalid; the button is then disabled. */
  tunnelAvailable: boolean;
  /** True when TUNNEL_URL is set: START ALL / STOP ALL then include the tunnel. */
  tunnelInAll: boolean;
  focused: ProcessName;
  /** Active BullMQ jobs; the worker stop warns when > 0. */
  activeJobs: number;
  /** Failed BullMQ jobs, shown on the queue button. */
  failedJobs: number;
}

const ACTIVE: ReadonlySet<ProcessState> = new Set(['starting', 'running', 'stopping']);

const TITLE: Record<ProcessName, string> = { server: 'SERVER', worker: 'WORKER', tunnel: 'TUNNEL' };
const KEY: Record<ProcessName, string> = { server: 's', worker: 'w', tunnel: 'n' };

function toggleAction(id: ProcessName, state: ProcessState, activeJobs: number, available = true): ActionView {
  const name = TITLE[id];
  const base = { id, key: KEY[id] };
  const lower = name.toLowerCase();
  let view: ActionView;
  switch (state) {
    case 'starting':
      view = { ...base, icon: '◌', label: `STARTING ${name}`, short: `${name}…`, bg: 'yellow', fg: 'black', hoverBg: 'red', disabled: false, hint: `${name} is booting — press to stop it` };
      break;
    case 'running':
      view = {
        ...base,
        icon: '■',
        label: `STOP ${name}`,
        short: `STOP ${name}`,
        bg: 'red',
        fg: 'white',
        hoverBg: 'magenta',
        disabled: false,
        hint: id === 'worker' && activeJobs > 0 ? `Graceful stop waits for ${activeJobs} running job(s)` : `Stop the ${lower} gracefully (SIGTERM)`,
      };
      break;
    case 'stopping':
      view = { ...base, icon: '»', label: `FORCE ${name}`, short: `FORCE ${name}`, bg: 'yellow', fg: 'black', hoverBg: 'red', disabled: false, hint: `${name} is still stopping — press to SIGKILL it` };
      break;
    default:
      view = {
        ...base,
        icon: '▶',
        label: `START ${name}`,
        short: `START ${name}`,
        bg: 'green',
        fg: 'black',
        hoverBg: 'cyan',
        disabled: false,
        hint: `Start the ${lower}${state === 'crashed' ? ' (it crashed last time — check the logs)' : ''}`,
      };
  }
  return available ? view : { ...view, bg: 'gray', fg: 'white', disabled: true, hint: 'Tunnel settings are invalid — fix TUNNEL_* in .env' };
}

export function buildActions(i: ActionsInput): ActionView[] {
  const anyApp = ACTIVE.has(i.server) || ACTIVE.has(i.worker);
  const anyAll = anyApp || (i.tunnelInAll && ACTIVE.has(i.tunnel));
  const allWhat = i.tunnelInAll ? 'server, worker and tunnel' : 'server and worker';
  const focusedActive = ACTIVE.has(i[i.focused]);
  const target = i.focused;
  return [
    toggleAction('server', i.server, i.activeJobs),
    toggleAction('worker', i.worker, i.activeJobs),
    toggleAction('tunnel', i.tunnel, i.activeJobs, i.tunnelAvailable),
    anyAll
      ? { id: 'all', key: 'a', icon: '■', label: 'STOP ALL', short: 'STOP ALL', bg: 'red', fg: 'white', hoverBg: 'magenta', disabled: false, hint: 'Stop everything that is running (server, worker, tunnel)' }
      : { id: 'all', key: 'a', icon: '▶', label: 'START ALL', short: 'START ALL', bg: 'green', fg: 'black', hoverBg: 'cyan', disabled: false, hint: `Start ${allWhat}${i.tunnelInAll ? '' : ' (set TUNNEL_URL to include the tunnel)'}` },
    { id: 'restart', key: 'r', icon: '↻', label: `RESTART ${target}`, short: 'RESTART', bg: 'blue', fg: 'white', hoverBg: 'cyan', disabled: false, hint: `Stop then start the ${target} (last one you toggled)` },
    { id: 'kill', key: 'x', icon: '✖', label: `KILL ${target}`, short: 'KILL', bg: focusedActive ? 'magenta' : 'gray', fg: 'white', hoverBg: 'red', disabled: !focusedActive, hint: `SIGKILL the ${target} now — a running job is interrupted` },
    { id: 'help', key: '?', icon: '?', label: 'HELP', short: 'HELP', bg: 'gray', fg: 'white', hoverBg: 'blue', disabled: false, hint: 'Keys, filters and what each panel shows' },
    {
      id: 'queue',
      key: 'u',
      icon: '≡',
      label: 'FAILED JOBS',
      short: i.failedJobs > 0 ? `QUEUE ${i.failedJobs}` : 'QUEUE',
      bg: i.failedJobs > 0 ? 'yellow' : 'gray',
      fg: i.failedJobs > 0 ? 'black' : 'white',
      hoverBg: 'blue',
      disabled: false,
      hint: i.failedJobs > 0 ? `${i.failedJobs} failed job(s) — open the list to retry one` : 'No failed jobs',
    },
  ];
}

/** Printed text of a button: ` ▶ START SERVER `. */
export function actionText(a: ActionView): string {
  return ` ${a.icon} ${a.short} `;
}
