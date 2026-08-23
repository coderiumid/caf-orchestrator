import { describe, it, expect } from 'vitest';
import { configSchema } from '../../src/config/schema.js';

const baseEnv = {
  REDIS_URL: 'redis://localhost:6379',
  LINEAR_WEBHOOK_SECRET: 'test-webhook-secret',
  LINEAR_API_KEY: 'test-linear-api-key',
  GITHUB_TOKEN: 'test-github-token',
  GITHUB_WEBHOOK_SECRET: 'test-github-webhook-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
  linear: {
    readyStateId: '3b76f298-054b-4de8-8ea6-071dcadefeb4',
  },
  repo: {
    cloneUrl: 'https://example.com/test-org/test-repo.git',
  },
};

describe('configSchema — required structural fields', () => {
  it('rejects a merged input missing linear.readyStateId', () => {
    const result = configSchema.safeParse({ ...baseEnv, linear: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'linear.readyStateId');
      expect(issue).toBeDefined();
    }
  });

  it('rejects a merged input missing repo.cloneUrl', () => {
    const result = configSchema.safeParse({ ...baseEnv, repo: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'repo.cloneUrl');
      expect(issue).toBeDefined();
    }
  });

  it('parses successfully with just the required fields set, applying structural defaults', () => {
    const result = configSchema.safeParse(baseEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.server.port).toBe(3000);
      expect(result.data.queue.jobAttempts).toBe(3);
      expect(result.data.agents.qa.maxRetries).toBe(1);
      expect(result.data.agents.reviewer.maxRetries).toBe(1);
    }
  });
});

describe('configSchema OPENROUTER validation', () => {
  it('defaults openai.useOpenai to false, OPENAI_API_KEY unset, and openai.baseUrl to the OpenRouter default', () => {
    const result = configSchema.safeParse(baseEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.openai.useOpenai).toBe(false);
      expect(result.data.openai.baseUrl).toBe('https://openrouter.ai/api');
    }
  });

  it('accepts a custom openai.baseUrl', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      openai: {
        useOpenai: true,
        baseUrl: 'https://custom.openrouter.example/api',
      },
      OPENAI_API_KEY: 'sk-or-test-key',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.openai.baseUrl).toBe('https://custom.openrouter.example/api');
    }
  });

  it('leaves openai.defaultModel unset by default and accepts it when provided', () => {
    const defaultResult = configSchema.safeParse(baseEnv);
    expect(defaultResult.success).toBe(true);
    if (defaultResult.success) {
      expect(defaultResult.data.openai.defaultModel).toBeUndefined();
    }

    const withModel = configSchema.safeParse({
      ...baseEnv,
      openai: {
        useOpenai: true,
        defaultModel: 'ag/claude-sonnet-4-6',
        allowedModels: ['ag/claude-sonnet-4-6'],
      },
      OPENAI_API_KEY: 'sk-or-test-key',
    });
    expect(withModel.success).toBe(true);
    if (withModel.success) {
      expect(withModel.data.openai.defaultModel).toBe('ag/claude-sonnet-4-6');
    }
  });

  it('rejects a non-URL openai.baseUrl', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      openai: { baseUrl: 'not-a-url' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'openai.baseUrl');
      expect(issue).toBeDefined();
    }
  });

  it('accepts openai.useOpenai=true when OPENAI_API_KEY is set', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      openai: { useOpenai: true },
      OPENAI_API_KEY: 'sk-or-test-key',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.openai.useOpenai).toBe(true);
      expect(result.data.OPENAI_API_KEY).toBe('sk-or-test-key');
    }
  });

  it('rejects openai.useOpenai=true when OPENAI_API_KEY is missing', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      openai: { useOpenai: true },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'OPENAI_API_KEY');
      expect(issue).toBeDefined();
    }
  });

  it('defaults openai.allowedModels to an empty list (fail-closed)', () => {
    const result = configSchema.safeParse(baseEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.openai.allowedModels).toEqual([]);
    }
  });

  it('accepts an openai.defaultModel that exactly matches an entry in allowedModels', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      openai: {
        useOpenai: true,
        defaultModel: 'ag/gemini-3.5-flash-low',
        allowedModels: ['ag/gemini-3.5-flash-low'],
      },
      OPENAI_API_KEY: 'sk-or-test-key',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an openai.defaultModel not present in allowedModels, even with a matching prefix', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      openai: {
        useOpenai: true,
        defaultModel: 'ag/gemini-3.5-flash-extra-low',
        allowedModels: ['ag/gemini-3.5-flash-low'],
      },
      OPENAI_API_KEY: 'sk-or-test-key',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'openai.defaultModel');
      expect(issue).toBeDefined();
    }
  });

  it('rejects an openai.defaultModel when allowedModels is left at the empty default', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      openai: { useOpenai: true, defaultModel: 'ag/gemini-3.5-flash-low' },
      OPENAI_API_KEY: 'sk-or-test-key',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed agents.modelOverrides map with known agents and allowlisted exact models', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      openai: { allowedModels: ['ag/claude-sonnet-4-6', 'ag/gemini-3.5-flash-low'] },
      agents: { modelOverrides: { 'caf-planner': 'ag/claude-sonnet-4-6', 'caf-qa': 'ag/gemini-3.5-flash-low' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects agents.modelOverrides with an unknown agent name', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      openai: { allowedModels: ['ag/claude-sonnet-4-6'] },
      agents: { modelOverrides: { 'not-a-real-agent': 'ag/claude-sonnet-4-6' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'agents.modelOverrides');
      expect(issue?.message).toContain('unknown agent');
    }
  });

  it('rejects agents.modelOverrides with a model not present in allowedModels', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      openai: { allowedModels: ['ag/claude-sonnet-4-6'] },
      agents: { modelOverrides: { 'caf-qa': 'gpt-4o' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'agents.modelOverrides');
      expect(issue?.message).toContain('must be one of');
    }
  });
});

describe('configSchema — Claude Code CLI auth guard', () => {
  it('rejects useOpenai=false with no CLAUDE_CODE_OAUTH_TOKEN', () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _omit, ...envWithoutToken } = baseEnv;
    const result = configSchema.safeParse(envWithoutToken);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'CLAUDE_CODE_OAUTH_TOKEN');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('No valid Claude Code CLI auth path configured');
    }
  });

  it('accepts CLAUDE_CODE_OAUTH_TOKEN alone with useOpenai left at its false default', () => {
    const result = configSchema.safeParse(baseEnv);
    expect(result.success).toBe(true);
  });

  it('accepts openai.useOpenai=true + OPENAI_API_KEY with no CLAUDE_CODE_OAUTH_TOKEN', () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _omit, ...envWithoutToken } = baseEnv;
    const result = configSchema.safeParse({
      ...envWithoutToken,
      openai: { useOpenai: true },
      OPENAI_API_KEY: 'sk-or-test-key',
    });
    expect(result.success).toBe(true);
  });

  it('rejects both openai.useOpenai=false explicitly and CLAUDE_CODE_OAUTH_TOKEN missing', () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _omit, ...envWithoutToken } = baseEnv;
    const result = configSchema.safeParse({ ...envWithoutToken, openai: { useOpenai: false } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'CLAUDE_CODE_OAUTH_TOKEN');
      expect(issue).toBeDefined();
    }
  });
});

describe('configSchema — dashboard basic-auth pairing', () => {
  it('defaults dashboard.enabled to false and allows omitting auth fields', () => {
    const result = configSchema.safeParse(baseEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dashboard.enabled).toBe(false);
    }
  });

  it('rejects dashboard.enabled=true without dashboard.basicAuthUser', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      dashboard: { enabled: true },
      DASHBOARD_BASIC_AUTH_PASSWORD: 'secret',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'dashboard.basicAuthUser');
      expect(issue).toBeDefined();
    }
  });

  it('rejects dashboard.enabled=true without DASHBOARD_BASIC_AUTH_PASSWORD', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      dashboard: { enabled: true, basicAuthUser: 'admin' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'DASHBOARD_BASIC_AUTH_PASSWORD');
      expect(issue).toBeDefined();
    }
  });

  it('accepts dashboard.enabled=true with both basicAuthUser and password set', () => {
    const result = configSchema.safeParse({
      ...baseEnv,
      dashboard: { enabled: true, basicAuthUser: 'admin' },
      DASHBOARD_BASIC_AUTH_PASSWORD: 'secret',
    });
    expect(result.success).toBe(true);
  });
});
