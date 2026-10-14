import { describe, it, expect } from 'vitest';
import { pivPhaseForAgent } from '../../src/infrastructure/db/pipeline-instrumentation.js';
import { KNOWN_AGENT_NAMES, validateAgentModelOverrides } from '../../src/config/schema.js';
import type { AgentEvent, PipelineRun } from '../../src/infrastructure/db/pipeline-run.repository.js';
import { normalizeRun, type FloorEvent } from '../../src/presentation/web/agent-floor/event-normalizer.js';

// CAF-SDD-04a AC-6: caf-validator is a first-class gate agent for config,
// instrumentation and the Agent Floor.

const T0 = Date.parse('2026-10-14T09:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'ganjardbc/umkm-pos:GAN-1',
    repoId: 'ganjardbc/umkm-pos',
    ticketId: 'GAN-1',
    ticketTitle: 'Some ticket',
    startedAt: at(0),
    endedAt: null,
    finalStatus: null,
    attempt: 1,
    prNumber: null,
    ...overrides,
  };
}

function makeRows(specs: Array<[string, AgentEvent['eventType'], Partial<AgentEvent>?]>): AgentEvent[] {
  return specs.map(([agentName, eventType, extra], index) => ({
    id: index + 1,
    pipelineRunId: 'ganjardbc/umkm-pos:GAN-1',
    agentName,
    pivPhase: agentName === 'caf-planner' ? 'plan' : agentName === 'caf-backend' ? 'implement' : 'verify',
    eventType,
    retryCount: null,
    costUsd: eventType === 'end' ? 0.1 : null,
    artifactLink: null,
    createdAt: at((index + 1) * 10),
    attempt: 1,
    exitCode: eventType === 'end' ? 0 : null,
    outcome: eventType === 'end' ? 'OK' : null,
    verifyDetails: null,
    ...extra,
  }));
}

const files = (events: FloorEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'handoff' ? [e.file] : e.type === 'step' && e.note ? [e.note] : []));

describe('caf-validator in config, instrumentation and Agent Floor', () => {
  it('is a known agent for agents.modelOverrides', () => {
    expect(KNOWN_AGENT_NAMES).toContain('caf-validator');
    expect(validateAgentModelOverrides({ 'caf-validator': 'm1' }, ['m1']).errors).toEqual([]);
  });

  it('is recorded in the verify PIV phase, like caf-qa', () => {
    expect(pivPhaseForAgent('caf-validator')).toBe('verify');
    expect(pivPhaseForAgent('caf-qa')).toBe('verify');
  });

  it('Agent Floor shows caf-validator as the QA desk and hands off validate-report.md', () => {
    const run = makeRun({ finalStatus: 'SUCCESS', endedAt: at(90), prNumber: 5 });
    const events = normalizeRun(
      run,
      makeRows([
        ['caf-planner', 'start'],
        ['caf-planner', 'end'],
        ['caf-backend', 'start'],
        ['caf-backend', 'end'],
        ['caf-validator', 'start'],
        ['caf-validator', 'end'],
        ['caf-reviewer', 'start'],
        ['caf-reviewer', 'end'],
      ]),
    );

    expect(events).toContainEqual(expect.objectContaining({ type: 'agent_state', agent: 'qa', state: 'verifying' }));
    expect(files(events)).toContain('validate-report.md');
    expect(files(events)).not.toContain('qa-report.md');
  });

  it('Agent Floor maps a caf-validator retry and gate_exhausted to the qa gate with validate-report.md', () => {
    const run = makeRun({ finalStatus: 'NEEDS_HUMAN', endedAt: at(120) });
    const events = normalizeRun(
      run,
      makeRows([
        ['caf-planner', 'start'],
        ['caf-planner', 'end'],
        ['caf-backend', 'start'],
        ['caf-backend', 'end'],
        ['caf-validator', 'start'],
        ['caf-validator', 'end'],
        ['caf-validator', 'retry', { retryCount: 1 }],
        ['caf-backend', 'start'],
        ['caf-backend', 'end'],
        ['caf-validator', 'start'],
        ['caf-validator', 'end'],
        ['caf-validator', 'gate_exhausted', { artifactLink: '.caf/tasks/GAN-1/validate-report.md' }],
      ]),
    );

    expect(events).toContainEqual(expect.objectContaining({ type: 'agent_state', agent: 'qa', state: 'retrying', gate: 'qa' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent_state', agent: 'qa', state: 'blocked', gate: 'qa' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'run_finished', gate: 'qa' }));
    expect(files(events)).not.toContain('qa-report.md');
  });
});
