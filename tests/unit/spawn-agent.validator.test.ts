import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DEFAULT_VALIDATOR_ALLOWED_COMMANDS, VALIDATOR_STRIPPED_ENV_KEYS } from '../../src/config/schema.js';

// CAF-SDD-04f AC-1..AC-4: caf-validator runs under dontAsk + allowlist + stripped env;
// every other agent (and restrictBash=false) is unchanged.

const configMock: {
  claude: { command: string };
  OPENAI_API_KEY?: string;
  openai: { useOpenai: boolean; baseUrl: string; defaultModel?: string; allowedModels: string[] };
  agents: {
    modelOverrides: Record<string, string>;
    validator: { restrictBash: boolean; allowedCommands: string[] };
  };
} = {
  claude: { command: 'claude' },
  OPENAI_API_KEY: undefined,
  openai: { useOpenai: false, baseUrl: 'https://openrouter.ai/api', defaultModel: undefined, allowedModels: [] },
  agents: { modelOverrides: {}, validator: { restrictBash: true, allowedCommands: [...DEFAULT_VALIDATOR_ALLOWED_COMMANDS] } },
};

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
}));

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function createFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => void;
    killed: boolean;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.killed = false;
  return proc;
}

async function runAgent(agent: string): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const { SpawnAgentService } = await import('../../src/infrastructure/agent/spawn-agent.service.js');
  const fakeProc = createFakeProc();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(fakeProc);
  const runPromise = new SpawnAgentService().run(agent, '/tmp/workspace', 'prompt');
  setImmediate(() => fakeProc.emit('close', 0, null));
  await runPromise;
  const [, args, options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
  return { args, env: options.env };
}

const SECRET_VALUES: Record<string, string> = {
  REDIS_URL: 'redis://secret-host:6379',
  LINEAR_WEBHOOK_SECRET: 'lws',
  LINEAR_API_KEY: 'lak',
  GITHUB_TOKEN: 'ghp_secret',
  GITHUB_WEBHOOK_SECRET: 'ghws',
  TELEGRAM_BOT_TOKEN: 'tbt',
  TELEGRAM_CHAT_ID: 'tci',
  DASHBOARD_BASIC_AUTH_PASSWORD: 'dbap',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
};

const BYPASS_ARGS = (agent: string) => [
  '--agent', agent, '--print', '--output-format', 'json', '--permission-mode', 'bypassPermissions',
];

describe('SpawnAgentService caf-validator restriction (CAF-SDD-04f)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    configMock.openai = { useOpenai: false, baseUrl: 'https://openrouter.ai/api', defaultModel: undefined, allowedModels: [] };
    configMock.OPENAI_API_KEY = undefined;
    configMock.agents = {
      modelOverrides: {},
      validator: { restrictBash: true, allowedCommands: [...DEFAULT_VALIDATOR_ALLOWED_COMMANDS] },
    };
    Object.assign(process.env, SECRET_VALUES);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  describe('AC-1 arguments', () => {
    it('uses dontAsk, project settings and the default allowlist', async () => {
      const { args } = await runAgent('caf-validator');
      expect(args).toEqual([
        '--agent', 'caf-validator',
        '--print',
        '--output-format', 'json',
        '--permission-mode', 'dontAsk',
        '--setting-sources', 'project',
        '--allowedTools',
        'Bash(pnpm run *)',
        'Bash(pnpm test)',
        'Bash(pnpm test *)',
        'Bash(pnpm --filter * run *)',
        'Bash(pnpm --filter * test)',
        'Bash(pnpm --filter * test *)',
        'Bash(npm run *)',
        'Bash(npm test)',
        'Bash(npm test *)',
        'Edit(.caf/tasks/**)',
      ]);
      expect(args).not.toContain('bypassPermissions');
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('uses a custom allowlist', async () => {
      configMock.agents.validator.allowedCommands = ['make check', 'yarn test'];
      const { args } = await runAgent('caf-validator');
      expect(args.slice(args.indexOf('--allowedTools'))).toEqual([
        '--allowedTools', 'Bash(make check)', 'Bash(yarn test)', 'Edit(.caf/tasks/**)',
      ]);
    });

    it('an empty allowlist leaves only the report write rule (fail-closed)', async () => {
      configMock.agents.validator.allowedCommands = [];
      const { args } = await runAgent('caf-validator');
      expect(args.slice(args.indexOf('--allowedTools'))).toEqual(['--allowedTools', 'Edit(.caf/tasks/**)']);
    });
  });

  describe('AC-2 other agents unchanged', () => {
    const others = ['caf-planner', 'caf-frontend', 'caf-backend', 'caf-qa', 'caf-reviewer', 'caf-documentation'];

    it.each(others)('%s keeps bypassPermissions args and the full env', async (agent) => {
      const { args, env } = await runAgent(agent);
      expect(args).toEqual(BYPASS_ARGS(agent));
      expect(env).toEqual({ ...process.env, CAF_HEADLESS: '1' });
      for (const key of Object.keys(SECRET_VALUES)) expect(env[key]).toBe(SECRET_VALUES[key]);
    });

    it('does not read config.agents.validator for other agents', async () => {
      const saved = configMock.agents;
      configMock.agents = { modelOverrides: {} } as typeof configMock.agents;
      const { args } = await runAgent('caf-qa');
      expect(args).toEqual(BYPASS_ARGS('caf-qa'));
      configMock.agents = saved;
    });
  });

  describe('AC-3 restrictBash false', () => {
    it('gives the validator the old args and env', async () => {
      configMock.agents.validator.restrictBash = false;
      const { args, env } = await runAgent('caf-validator');
      expect(args).toEqual(BYPASS_ARGS('caf-validator'));
      expect(env).toEqual({ ...process.env, CAF_HEADLESS: '1' });
      expect(env.GITHUB_TOKEN).toBe('ghp_secret');
    });
  });

  describe('AC-4 env', () => {
    it('strips every D-7 key and keeps PATH, CAF_HEADLESS and the OAuth token', async () => {
      const { env } = await runAgent('caf-validator');
      for (const key of VALIDATOR_STRIPPED_ENV_KEYS) expect(env).not.toHaveProperty(key);
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.CAF_HEADLESS).toBe('1');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
    });

    it('does not modify the orchestrator process.env', async () => {
      await runAgent('caf-validator');
      for (const key of VALIDATOR_STRIPPED_ENV_KEYS) expect(process.env[key]).toBe(SECRET_VALUES[key]);
    });

    it('keeps the OpenRouter auth variable and base url with openai.useOpenai', async () => {
      configMock.openai.useOpenai = true;
      configMock.OPENAI_API_KEY = 'sk-or-test';
      const { env } = await runAgent('caf-validator');
      expect(env.ANTHROPIC_API_KEY).toBe('sk-or-test');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
      expect(env).not.toHaveProperty('GITHUB_TOKEN');
    });

    it('keeps the model overrides', async () => {
      configMock.openai.allowedModels = ['model-x'];
      configMock.agents.modelOverrides = { 'caf-validator': 'model-x' };
      const { env } = await runAgent('caf-validator');
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('model-x');
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('model-x');
    });
  });
});
