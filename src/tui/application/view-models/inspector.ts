import type { FloorEvent } from '../../../presentation/web/agent-floor/event-normalizer.js';

export function agentStates(floor: readonly FloorEvent[]): Array<[string, string]> {
  const map = new Map<string, string>();
  for (const e of floor) if (e.type === 'agent_state') map.set(e.agent, e.state);
  return [...map.entries()];
}

/** GitHub PR URL from repoId "owner/repo" + PR number; null when either is unknown. */
export function prUrl(repoId: string, prNumber: number | null): string | null {
  if (prNumber === null || !/^[\w.-]+\/[\w.-]+$/.test(repoId)) return null;
  return `https://github.com/${repoId}/pull/${prNumber}`;
}
