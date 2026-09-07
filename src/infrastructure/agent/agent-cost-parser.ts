export interface AgentUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Extracts cost/usage from a `claude --print --output-format json` run's stdout
 * (see spawn-agent.service.ts — every agent is spawned with that flag already).
 * The CLI's JSON result carries `total_cost_usd` and a `usage` object directly —
 * no estimation needed (CAF-DASHBOARD-01 Task 2 investigation confirmed this
 * field is present, so this is a straight parse, not a token-count-based guess).
 *
 * Returns undefined (never throws) on malformed/non-JSON stdout or a missing
 * cost field, so a parse failure degrades to "cost unavailable" for one run
 * rather than taking down the caller.
 */
export function parseAgentUsage(stdout: string): AgentUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;

  const costUsd = obj.total_cost_usd;
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) return undefined;

  const usage = obj.usage;
  const usageObj = typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : {};
  const inputTokens = typeof usageObj.input_tokens === 'number' ? usageObj.input_tokens : 0;
  const outputTokens = typeof usageObj.output_tokens === 'number' ? usageObj.output_tokens : 0;

  return { costUsd, inputTokens, outputTokens };
}
