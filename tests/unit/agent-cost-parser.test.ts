import { describe, it, expect } from 'vitest';
import { parseAgentUsage } from '../../src/infrastructure/agent/agent-cost-parser.js';

// Fixture captured from a real `claude -p "..." --output-format json` run
// (CAF-DASHBOARD-01 Task 2 investigation, 2026-09-07) — trimmed to the fields
// the parser reads plus enough surrounding shape to prove it ignores the rest.
const REAL_SAMPLE_STDOUT = JSON.stringify({
  duration_api_ms: 2984,
  stop_reason: 'end_turn',
  session_id: 'f9db1361-e7cd-478b-bdf8-9b7e5c78ea93',
  total_cost_usd: 0.0902806,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 21725,
    cache_read_input_tokens: 16683,
    output_tokens: 4,
  },
  is_error: false,
  num_turns: 1,
  subtype: 'success',
  result: 'hi',
  type: 'result',
  duration_ms: 3104,
});

describe('parseAgentUsage', () => {
  it('extracts cost and token usage from a real claude --output-format json result', () => {
    expect(parseAgentUsage(REAL_SAMPLE_STDOUT)).toEqual({
      costUsd: 0.0902806,
      inputTokens: 2,
      outputTokens: 4,
    });
  });

  it('returns undefined for non-JSON stdout', () => {
    expect(parseAgentUsage('not json at all')).toBeUndefined();
  });

  it('returns undefined for JSON missing total_cost_usd', () => {
    expect(parseAgentUsage(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }))).toBeUndefined();
  });

  it('returns undefined for a JSON array', () => {
    expect(parseAgentUsage(JSON.stringify([1, 2, 3]))).toBeUndefined();
  });

  it('defaults token counts to 0 when usage is missing', () => {
    expect(parseAgentUsage(JSON.stringify({ total_cost_usd: 1.5 }))).toEqual({
      costUsd: 1.5,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('returns undefined for empty stdout', () => {
    expect(parseAgentUsage('')).toBeUndefined();
  });
});
