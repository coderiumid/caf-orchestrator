import { describe, it, expect } from 'vitest';
import { configSchema, DEFAULT_VALIDATOR_ALLOWED_COMMANDS } from '../../src/config/schema.js';

// CAF-SDD-04f AC-6: agents.validator defaults and startup validation.

const base = {
  REDIS_URL: 'redis://localhost:6379',
  LINEAR_WEBHOOK_SECRET: 'test-webhook-secret',
  LINEAR_API_KEY: 'test-linear-api-key',
  GITHUB_TOKEN: 'test-github-token',
  GITHUB_WEBHOOK_SECRET: 'test-github-webhook-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
  linear: { readyStateId: '3b76f298-054b-4de8-8ea6-071dcadefeb4' },
};

const withValidator = (validator: unknown) => configSchema.safeParse({ ...base, agents: { validator } });

function messages(result: ReturnType<typeof withValidator>): string {
  return result.success ? '' : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
}

describe('agents.validator config', () => {
  it('defaults to restrictBash true and the D-4 list when agents.validator is absent', () => {
    const result = configSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents.validator.restrictBash).toBe(true);
      expect(result.data.agents.validator.allowedCommands).toEqual([
        'pnpm run *', 'pnpm test', 'pnpm test *',
        'pnpm --filter * run *', 'pnpm --filter * test', 'pnpm --filter * test *',
        'npm run *', 'npm test', 'npm test *',
      ]);
      expect(result.data.agents.validator.allowedCommands).toEqual([...DEFAULT_VALIDATOR_ALLOWED_COMMANDS]);
    }
  });

  it('defaults when only agents.qa is given', () => {
    const result = configSchema.safeParse({ ...base, agents: { qa: { maxRetries: 2 } } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.agents.validator.restrictBash).toBe(true);
  });

  it('does not allow npx, pnpm dlx or pnpm exec by default', () => {
    const joined = DEFAULT_VALIDATOR_ALLOWED_COMMANDS.join('\n');
    expect(joined).not.toMatch(/npx|dlx|exec|yarn|bun|make/);
  });

  it('accepts an empty allowedCommands (fail-closed)', () => {
    const result = withValidator({ allowedCommands: [] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.agents.validator.allowedCommands).toEqual([]);
  });

  it('accepts restrictBash false and a custom list', () => {
    const result = withValidator({ restrictBash: false, allowedCommands: ['make check'] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents.validator.restrictBash).toBe(false);
      expect(result.data.agents.validator.allowedCommands).toEqual(['make check']);
    }
  });

  it.each([
    ['an empty entry', ['']],
    ['a whitespace-only entry', ['   ']],
    ['only *', ['*']],
    ['a Bash wrapper', ['Bash(pnpm run *)']],
    ['bare Bash', ['Bash']],
  ])('rejects %s naming the key', (_label, allowedCommands) => {
    const result = withValidator({ allowedCommands });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('agents.validator.allowedCommands');
  });

  it.each([
    ['a string', 'pnpm test'],
    ['a list with a non-string', ['pnpm test', 5]],
  ])('rejects %s naming the key', (_label, allowedCommands) => {
    const result = withValidator({ allowedCommands });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('agents.validator.allowedCommands');
  });
});
