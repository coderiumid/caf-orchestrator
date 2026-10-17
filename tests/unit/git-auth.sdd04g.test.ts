import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const TOKEN = 'ghp_SECRETTOKEN123';
const B64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const workspaceRoot = mkdtempSync(join(tmpdir(), 'caf-sdd04g-'));

const cfg: { workspace: { dir: string }; GITHUB_TOKEN: string | undefined } = {
  workspace: { dir: workspaceRoot },
  GITHUB_TOKEN: TOKEN,
};
vi.mock('../../src/config/index.js', () => ({ config: cfg }));

const logged: unknown[] = [];
vi.mock('../../src/infrastructure/logging/logger.js', () => {
  const rec = (...a: unknown[]) => void logged.push(a);
  return { logger: { debug: rec, info: rec, warn: rec, error: rec } };
});

interface Call {
  args: string[];
  env: NodeJS.ProcessEnv;
}
const calls: Call[] = [];
let versionOutput: string | undefined;
let networkMode: 'ok' | 'fail' = 'ok';

// Wraps the real spawn: records every git call; network calls that carry the
// auth env are replaced by a fake child (no real GitHub), `--version` can be
// stubbed. Everything else (local commands) runs against real git.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      calls.push({ args: [...args], env: opts.env });
      const o = opts as never;
      if (args[0] === '--version' && versionOutput) {
        return actual.spawn(process.execPath, ['-e', `console.log(${JSON.stringify(versionOutput)})`], o);
      }
      if (opts.env.GIT_CONFIG_COUNT) {
        const script =
          networkMode === 'fail'
            ? `console.error('fatal: auth failed for ' + ${JSON.stringify(TOKEN)} + ' header ' + ${JSON.stringify(B64)}); process.exit(128)`
            : 'process.exit(0)';
        return actual.spawn(process.execPath, ['-e', script], o);
      }
      return (actual.spawn as (...a: unknown[]) => unknown)(cmd, args, opts);
    }) as typeof actual.spawn,
  };
});

const { GitService, buildGitAuthEnv, toCleanRepoUrl, resetGitVersionCheck } = await import(
  '../../src/infrastructure/git/git.service.js'
);

const sh = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const NETWORK = new Set(['clone', 'push', 'fetch', 'ls-remote']);

beforeEach(() => {
  calls.length = 0;
  logged.length = 0;
  versionOutput = undefined;
  networkMode = 'ok';
  cfg.GITHUB_TOKEN = TOKEN;
  resetGitVersionCheck();
});
afterEach(() => resetGitVersionCheck());
afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }));

function makeBareRemote(): string {
  const base = mkdtempSync(join(tmpdir(), 'caf-sdd04g-remote-'));
  const bare = join(base, 'r.git');
  const seed = join(base, 'seed');
  sh(['init', '-q', '--bare', bare], base);
  sh(['init', '-q', '-b', 'main', seed], base);
  sh(['-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-q', '--allow-empty', '-m', 'i'], seed);
  sh(['push', '-q', bare, 'main'], seed);
  return bare;
}

describe('AC-1: clone leaves no credential in .git/config', () => {
  it('clones a plain URL and .git/config has no userinfo, token or x-access-token', async () => {
    const bare = makeBareRemote();
    const target = join(workspaceRoot, 'ac1');
    await new GitService().clone(bare, 'main', target, workspaceRoot);

    const gitConfig = readFileSync(join(target, '.git', 'config'), 'utf-8');
    expect(sh(['config', '--get', 'remote.origin.url'], target)).toBe(bare);
    expect(gitConfig).not.toContain(TOKEN);
    expect(gitConfig).not.toContain('x-access-token');
    expect(gitConfig).not.toContain(B64);
  });

  it('passes the clean URL (no userinfo) to git clone, even if the caller gave a token URL', async () => {
    await new GitService().clone(`https://x-access-token:old@github.com/o/r.git`, 'main', join(workspaceRoot, 'ac1b'), workspaceRoot);
    const clone = calls.find((c) => c.args[0] === 'clone')!;
    expect(clone.args).toContain('https://github.com/o/r.git');
    expect(clone.args.join(' ')).not.toMatch(/@github\.com/);
  });
});

describe('AC-2: auth env only on network commands', () => {
  it('clone, push, fetch (preflightCleanup) and ls-remote carry the header env; local commands do not', async () => {
    const bare = makeBareRemote();
    const target = join(workspaceRoot, 'ac2');
    const svc = new GitService();
    await svc.clone(bare, 'main', target, workspaceRoot); // local path: no auth, real clone
    sh(['remote', 'set-url', 'origin', 'https://github.com/o/r.git'], target);
    sh(['config', 'user.email', 'a@b'], target);
    sh(['config', 'user.name', 'n'], target);
    calls.length = 0;

    await svc.push(target, 'main', workspaceRoot);
    await svc.preflightCleanup(target, 'main', workspaceRoot);
    await svc.remoteBranchExists('https://github.com/o/r.git', 'main', workspaceRoot);
    await svc.commitAll(target, 'msg', workspaceRoot);
    await svc.getHeadCommit(target);
    await svc.getWorkspaceStatus(target, workspaceRoot);

    for (const c of calls) {
      const authed = Boolean(c.env.GIT_CONFIG_COUNT);
      if (NETWORK.has(c.args[0])) {
        expect(authed, `git ${c.args.join(' ')}`).toBe(true);
        expect(c.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
        expect(c.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${B64}`);
      } else {
        expect(authed, `git ${c.args.join(' ')}`).toBe(false);
        expect(c.env.GIT_CONFIG_VALUE_0).toBeUndefined();
      }
    }
    const names = calls.map((c) => c.args[0]);
    expect(names).toEqual(expect.arrayContaining(['push', 'fetch', 'ls-remote', 'rev-parse', 'status', 'checkout', 'reset', 'clean', 'commit']));
  });
});

describe('AC-3: token never leaks', () => {
  it('keeps token and base64 out of argv, error message and logs when a network command fails', async () => {
    networkMode = 'fail';
    const target = join(workspaceRoot, 'ac3');
    const err = await new GitService().clone('https://github.com/o/r.git', 'main', target, workspaceRoot).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/git clone failed/);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain(B64);
    for (const c of calls) expect(c.args.join(' ')).not.toMatch(new RegExp(`${TOKEN}|${B64}`));
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
    expect(JSON.stringify(logged)).not.toContain(B64);
  });

  it('also redacts on push failure', async () => {
    const bare = makeBareRemote();
    const target = join(workspaceRoot, 'ac3b');
    const svc = new GitService();
    await svc.clone(bare, 'main', target, workspaceRoot);
    sh(['remote', 'set-url', 'origin', 'https://github.com/o/r.git'], target);
    networkMode = 'fail';
    const err = await svc.push(target, 'main', workspaceRoot).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain(B64);
  });
});

describe('AC-4: legacy token-bearing origin is scrubbed before fetch', () => {
  it('rewrites origin to the clean URL, then fetches with auth', async () => {
    const bare = makeBareRemote();
    const target = join(workspaceRoot, 'ac4');
    const svc = new GitService();
    await svc.clone(bare, 'main', target, workspaceRoot);
    sh(['remote', 'set-url', 'origin', `https://x-access-token:${TOKEN}@github.com/o/r.git`], target);
    expect(readFileSync(join(target, '.git', 'config'), 'utf-8')).toContain(TOKEN);
    calls.length = 0;

    await svc.preflightCleanup(target, 'main', workspaceRoot);

    expect(sh(['config', '--get', 'remote.origin.url'], target)).toBe('https://github.com/o/r.git');
    expect(readFileSync(join(target, '.git', 'config'), 'utf-8')).not.toContain(TOKEN);
    const names = calls.map((c) => c.args.slice(0, 2).join(' '));
    expect(names.indexOf('remote set-url')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('remote set-url')).toBeLessThan(calls.findIndex((c) => c.args[0] === 'fetch'));
    expect(calls.find((c) => c.args[0] === 'fetch')!.env.GIT_CONFIG_COUNT).toBe('1');
  });

  it('is idempotent: an already clean origin triggers no set-url', async () => {
    const bare = makeBareRemote();
    const target = join(workspaceRoot, 'ac4b');
    const svc = new GitService();
    await svc.clone(bare, 'main', target, workspaceRoot);
    calls.length = 0;
    await svc.preflightCleanup(target, 'main', workspaceRoot);
    expect(calls.some((c) => c.args[0] === 'remote' && c.args[1] === 'set-url')).toBe(false);
  });
});

describe('AC-6: no auth when there is nothing to authenticate', () => {
  it('returns {} and no header without GITHUB_TOKEN', async () => {
    cfg.GITHUB_TOKEN = undefined;
    expect(await buildGitAuthEnv('https://github.com/o/r.git')).toEqual({});
    await new GitService().remoteBranchExists('https://github.com/o/r.git', 'main', workspaceRoot).catch(() => undefined);
    expect(calls.some((c) => c.env.GIT_CONFIG_COUNT)).toBe(false);
  });

  it('returns {} for a non-github.com URL even with a token, and does not check the git version', async () => {
    expect(await buildGitAuthEnv('https://gitlab.com/o/r.git')).toEqual({});
    expect(await buildGitAuthEnv('/local/path.git')).toEqual({});
    expect(calls.some((c) => c.args[0] === '--version')).toBe(false);
  });
});

describe('AC-7: git older than 2.31', () => {
  it('fails with a clear message naming 2.31', async () => {
    versionOutput = 'git version 2.30.1';
    await expect(buildGitAuthEnv('https://github.com/o/r.git')).rejects.toThrow(/2\.31/);
    await expect(
      new GitService().remoteBranchExists('https://github.com/o/r.git', 'main', workspaceRoot),
    ).rejects.toThrow(/2\.31/);
  });

  it('accepts 2.31 and caches the check', async () => {
    versionOutput = 'git version 2.31.0';
    await buildGitAuthEnv('https://github.com/o/r.git');
    await buildGitAuthEnv('https://github.com/o/r.git');
    expect(calls.filter((c) => c.args[0] === '--version')).toHaveLength(1);
  });
});

describe('toCleanRepoUrl', () => {
  it('strips userinfo and leaves clean/other inputs alone', () => {
    expect(toCleanRepoUrl('https://x-access-token:abc@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(toCleanRepoUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(toCleanRepoUrl('/tmp/x/r.git')).toBe('/tmp/x/r.git');
  });
});
