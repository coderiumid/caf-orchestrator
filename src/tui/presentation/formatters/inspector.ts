import type { FloorEvent, FloorStep } from '../../../presentation/web/agent-floor/event-normalizer.js';
import { agentStates } from '../../application/view-models/inspector.js';
import { runType, statusColor, statusLabel } from '../../application/view-models/run-list.js';
import type { RunDetailView } from '../../domain/interfaces/data-source.interface.js';
import { formatCost, formatElapsed } from '../../shared/format.js';
import { escapeTags } from './markup.js';

const STEPS: readonly FloorStep[] = ['plan', 'spec', 'impl', 'qa', 'review', 'pr'];

/** Latest status per step from the normalized floor events: ○ untouched, ◐ active, ✔ pass, ✘ fail. */
export function stepLadder(floor: readonly FloorEvent[]): string {
  const state = new Map<FloorStep, string>();
  for (const e of floor) if (e.type === 'step') state.set(e.step, e.status);
  return STEPS.map((s) => {
    const st = state.get(s);
    const mark = st === 'pass' ? '{green-fg}✔{/}' : st === 'fail' ? '{red-fg}✘{/}' : st === 'active' ? '{cyan-fg}◐{/}' : '{gray-fg}○{/}';
    return `${mark} ${s}`;
  }).join('  →  ');
}

/** Last known state per agent, from agent_state events. */
export function renderInspector(d: RunDetailView, now: number = Date.now()): string {
  const { api, events, floor } = d;
  const lines: string[] = [];
  lines.push(`{bold}${escapeTags(api.ticketId)}{/bold}  ${escapeTags(api.ticketTitle)}`);
  lines.push(`{${statusColor(api)}-fg}${statusLabel(api)}{/}  type=${runType(api)}  repo=${escapeTags(api.repoId)}  attempt=${api.attempt ?? '-'}`);
  lines.push(
    `elapsed ${formatElapsed(api.startedAt, api.endedAt, now)}   cost ${formatCost(api.totalCostUsd)}   PR ${api.prNumber !== null ? `#${api.prNumber}` : '-'}   branch ai-agent/${escapeTags(api.ticketId)}`,
  );
  if (api.waitingFor) lines.push(`{yellow-fg}Waiting for: ${api.waitingFor}{/}`);
  if (api.acSummary) {
    const a = api.acSummary;
    lines.push(`AC: {green-fg}${a.pass} pass{/}  {red-fg}${a.fail} fail{/}  {yellow-fg}${a.unverified} unverified{/}  / ${a.total}`);
  }
  if (api.reviewResult) {
    lines.push(
      api.reviewResult.type === 'verdict'
        ? `Review verdict: ${api.reviewResult.verdict}${api.reviewResult.postedAsComment ? ' (posted as comment)' : ''}`
        : `Fix review: fixed ${api.reviewResult.fixed}, skipped ${api.reviewResult.skipped}, n/a ${api.reviewResult.notApplicable}`,
    );
  }
  lines.push('', stepLadder(floor), '');

  const agents = agentStates(floor);
  if (agents.length > 0) lines.push(`Agents: ${agents.map(([a, s]) => `${a}=${s}`).join('  ')}`, '');

  lines.push('{bold}Events{/bold}');
  for (const e of events) {
    const t = new Date(e.createdAt).toTimeString().slice(0, 8);
    const bits = [
      e.agentName,
      e.pivPhase,
      e.eventType,
      e.retryCount !== null ? `retry=${e.retryCount}` : '',
      e.outcome ? `outcome=${e.outcome}` : '',
      e.exitCode !== null ? `exit=${e.exitCode}` : '',
      e.costUsd !== null ? formatCost(e.costUsd) : '',
      e.artifactLink ? `→ ${escapeTags(e.artifactLink)}` : '',
    ].filter(Boolean);
    lines.push(`{gray-fg}${t}{/} ${bits.join('  ')}`);
  }
  if (events.length === 0) lines.push('{gray-fg}(no agent events yet){/}');
  lines.push('', '{gray-fg}Esc close · o open PR in browser{/}');
  return lines.join('\n');
}
