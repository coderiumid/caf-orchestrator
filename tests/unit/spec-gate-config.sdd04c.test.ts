import { describe, it, expect } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { projectsSchema } from '../../src/config/project-config.schema.js';
import { resolveSpecGateLabel } from '../../src/config/project-registry.js';

// CAF-SDD-04c AC-1: spec-gate label, default `spec-approval` for GitHub and Linear.

const baseEnv = {
  REDIS_URL: 'redis://localhost:6379',
  LINEAR_WEBHOOK_SECRET: 'test-webhook-secret',
  LINEAR_API_KEY: 'test-linear-api-key',
  GITHUB_TOKEN: 'test-github-token',
  GITHUB_WEBHOOK_SECRET: 'test-github-webhook-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
  linear: { readyStateId: '3b76f298-054b-4de8-8ea6-071dcadefeb4' },
};

const project = {
  ticketPrefix: 'GAN',
  repoCloneUrl: 'git@github.com:ganjardbc/umkm-pos.git',
  baseBranch: 'main',
  workspaceDir: '/tmp/caf-orchestrator/workspace/a',
  agents: { modelOverrides: {} },
};

describe('AC-1 spec gate label config', () => {
  it('defaults github.specGateLabel and linear.specGateLabel to spec-approval', () => {
    const result = configSchema.safeParse(baseEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.github.specGateLabel).toBe('spec-approval');
      expect(result.data.linear.specGateLabel).toBe('spec-approval');
    }
  });

  it('uses the configured labels when set', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      linear: { ...baseEnv.linear, specGateLabel: 'needs-spec-review' },
      github: { specGateLabel: 'spec-review' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.github.specGateLabel).toBe('spec-review');
      expect(result.data.linear.specGateLabel).toBe('needs-spec-review');
    }
  });

  it('rejects an empty label', () => {
    expect(configSchema.safeParse({ ...baseEnv, github: { specGateLabel: '' } }).success).toBe(false);
  });

  it('resolveSpecGateLabel falls back to the global label, and a per-project label wins', () => {
    const parsed = projectsSchema.parse({
      plain: project,
      custom: {
        ...project,
        ticketPrefix: 'DUM',
        workspaceDir: '/tmp/caf-orchestrator/workspace/b',
        github: { specGateLabel: 'gh-gate' },
        linear: { specGateLabel: 'ln-gate' },
      },
    });
    const globals = { github: { specGateLabel: 'spec-approval' }, linear: { specGateLabel: 'spec-approval' } };
    expect(resolveSpecGateLabel(parsed.plain, 'github', globals)).toBe('spec-approval');
    expect(resolveSpecGateLabel(parsed.plain, 'linear', globals)).toBe('spec-approval');
    expect(resolveSpecGateLabel(parsed.custom, 'github', globals)).toBe('gh-gate');
    expect(resolveSpecGateLabel(parsed.custom, 'linear', globals)).toBe('ln-gate');
  });

  it('resolveSpecGateLabel still yields spec-approval when the global config has none', () => {
    const parsed = projectsSchema.parse({ plain: project });
    expect(resolveSpecGateLabel(parsed.plain, 'github', {})).toBe('spec-approval');
  });
});
