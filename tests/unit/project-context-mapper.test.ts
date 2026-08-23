import { describe, it, expect } from 'vitest';
import { toJobProjectContext } from '../../src/infrastructure/linear/project-context-mapper.js';
import type { ProjectConfig } from '../../src/config/project-registry.js';

describe('toJobProjectContext', () => {
  it('maps ProjectConfig fields to JobProjectContext, dropping ticketPrefix', () => {
    const project: ProjectConfig = {
      ticketPrefix: 'GAN',
      repoCloneUrl: 'git@github.com:ganjardbc/umkm-pos.git',
      baseBranch: 'main',
      workspaceDir: '/tmp/caf-orchestrator/workspace/umkm-pos',
      agents: { modelOverrides: { planner: 'some-model' } },
    };

    expect(toJobProjectContext(project)).toEqual({
      repoCloneUrl: 'git@github.com:ganjardbc/umkm-pos.git',
      baseBranch: 'main',
      workspaceDir: '/tmp/caf-orchestrator/workspace/umkm-pos',
      agents: { modelOverrides: { planner: 'some-model' } },
    });
  });
});
