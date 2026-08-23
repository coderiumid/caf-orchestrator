import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const configMock: {
  claude: { command: string };
  OPENAI_API_KEY?: string;
  openai: { useOpenai: boolean; baseUrl: string; defaultModel?: string };
  agents: { modelOverrides: Record<string, string> };
} = {
  claude: { command: 'claude' },
  OPENAI_API_KEY: undefined,
  openai: { useOpenai: false, baseUrl: 'https://openrouter.ai/api', defaultModel: undefined },
  agents: { modelOverrides: {} },
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
  vi.spyOn(proc.stdin, 'write');
  return proc;
}

describe('SpawnAgentService', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    configMock.openai = { useOpenai: false, baseUrl: 'https://openrouter.ai/api', defaultModel: undefined };
    configMock.OPENAI_API_KEY = undefined;
    configMock.agents = { modelOverrides: {} };
  });

  it('passes process.env unchanged when openai.useOpenai is false', async () => {
    const { SpawnAgentService } = await import('../../src/infrastructure/agent/spawn-agent.service.js');
    const service = new SpawnAgentService();
    const fakeProc = createFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const runPromise = service.run('planner', '/tmp/workspace', 'do the thing');
    setImmediate(() => fakeProc.emit('close', 0, null));
    await runPromise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options.env.PATH).toBe(process.env.PATH);
  });

  it('always sets CAF_HEADLESS=1 regardless of openai.useOpenai', async () => {
    const { SpawnAgentService } = await import('../../src/infrastructure/agent/spawn-agent.service.js');
    const service = new SpawnAgentService();
    const fakeProc = createFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const runPromise = service.run('planner', '/tmp/workspace', 'do the thing');
    setImmediate(() => fakeProc.emit('close', 0, null));
    await runPromise;

    const [, , options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.CAF_HEADLESS).toBe('1');
  });

  it('prepends the headless system-context marker to the prompt written to stdin', async () => {
    const { SpawnAgentService } = await import('../../src/infrastructure/agent/spawn-agent.service.js');
    const service = new SpawnAgentService();
    const fakeProc = createFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const runPromise = service.run('planner', '/tmp/workspace', 'do the thing');
    setImmediate(() => fakeProc.emit('close', 0, null));
    await runPromise;

    const writtenPrompt = (fakeProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(writtenPrompt).toContain(
      '[SYSTEM CONTEXT: Environment = headless. No interactive user available. Do NOT stop and wait for chat confirmation under any circumstance.]',
    );
    expect(writtenPrompt).toContain('do the thing');
    expect(writtenPrompt.indexOf('SYSTEM CONTEXT')).toBeLessThan(writtenPrompt.indexOf('do the thing'));
  });

  it('injects OpenRouter env vars when openai.useOpenai is true and key is set', async () => {
    configMock.openai.useOpenai = true;
    configMock.OPENAI_API_KEY = 'sk-or-test-key';

    const { SpawnAgentService } = await import('../../src/infrastructure/agent/spawn-agent.service.js');
    const service = new SpawnAgentService();
    const fakeProc = createFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const runPromise = service.run('planner', '/tmp/workspace', 'do the thing');
    setImmediate(() => fakeProc.emit('close', 0, null));
    await runPromise;

    const [, , options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    // ANTHROPIC_API_KEY must carry the OpenRouter key — that is what the claude
    // CLI reads when hitting an Anthropic-compatible endpoint.
    expect(options.env.ANTHROPIC_API_KEY).toBe('sk-or-test-key');
    // ANTHROPIC_AUTH_TOKEN is NOT a recognised claude CLI env var; it must not
    // be injected (or at worst be harmlessly undefined).
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(options.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(options.env.PATH).toBe(process.env.PATH);
  });

  it('injects ANTHROPIC_DEFAULT_SONNET_MODEL when openai.defaultModel is set', async () => {
    configMock.openai.useOpenai = true;
    configMock.OPENAI_API_KEY = 'sk-or-test-key';
    configMock.openai.defaultModel = 'anthropic/claude-sonnet-4.5';

    const { SpawnAgentService } = await import('../../src/infrastructure/agent/spawn-agent.service.js');
    const service = new SpawnAgentService();
    const fakeProc = createFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const runPromise = service.run('planner', '/tmp/workspace', 'do the thing');
    setImmediate(() => fakeProc.emit('close', 0, null));
    await runPromise;

    const [, , options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-sonnet-4.5');
  });

  it('uses openai.baseUrl from config instead of a hardcoded value', async () => {
    configMock.openai.useOpenai = true;
    configMock.OPENAI_API_KEY = 'sk-or-test-key';
    configMock.openai.baseUrl = 'https://custom.openrouter.example/api';

    const { SpawnAgentService } = await import('../../src/infrastructure/agent/spawn-agent.service.js');
    const service = new SpawnAgentService();
    const fakeProc = createFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const runPromise = service.run('planner', '/tmp/workspace', 'do the thing');
    setImmediate(() => fakeProc.emit('close', 0, null));
    await runPromise;

    const [, , options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.ANTHROPIC_BASE_URL).toBe('https://custom.openrouter.example/api');
  });

  it('applies a per-agent model override even when openai.useOpenai is false', async () => {
    configMock.agents.modelOverrides = { qa: 'claude-haiku-4-5-20251001' };

    const { SpawnAgentService } = await import('../../src/infrastructure/agent/spawn-agent.service.js');
    const service = new SpawnAgentService();
    const fakeProc = createFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const runPromise = service.run('qa', '/tmp/workspace', 'run qa');
    setImmediate(() => fakeProc.emit('close', 0, null));
    await runPromise;

    const [, , options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(options.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
    // Agents without an override entry must be untouched (still process.env).
    expect(options.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('does not apply another agent\'s override', async () => {
    configMock.agents.modelOverrides = { qa: 'claude-haiku-4-5-20251001' };

    const { SpawnAgentService } = await import('../../src/infrastructure/agent/spawn-agent.service.js');
    const service = new SpawnAgentService();
    const fakeProc = createFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const runPromise = service.run('planner', '/tmp/workspace', 'do the thing');
    setImmediate(() => fakeProc.emit('close', 0, null));
    await runPromise;

    const [, , options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  });

  it('lets a per-agent override win over the global openai.defaultModel', async () => {
    configMock.openai.useOpenai = true;
    configMock.OPENAI_API_KEY = 'sk-or-test-key';
    configMock.openai.defaultModel = 'anthropic/claude-sonnet-4.5';
    configMock.agents.modelOverrides = { qa: 'google/gemini-2.5-pro' };

    const { SpawnAgentService } = await import('../../src/infrastructure/agent/spawn-agent.service.js');
    const service = new SpawnAgentService();
    const fakeProc = createFakeProc();
    spawnMock.mockReturnValue(fakeProc);

    const runPromise = service.run('qa', '/tmp/workspace', 'run qa');
    setImmediate(() => fakeProc.emit('close', 0, null));
    await runPromise;

    const [, , options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('google/gemini-2.5-pro');
    // The global default's other side-effect (routing through OpenRouter) is unaffected.
    expect(options.env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
  });
});
