import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const workspaceRoot = '/tmp/caf-orchestrator-test-workspace-root';

vi.mock('../../src/config/index.js', () => ({
  config: { workspace: { dir: workspaceRoot }, GITHUB_TOKEN: undefined },
}));

const { GitService } = await import('../../src/infrastructure/git/git.service.js');

describe('GitService path-escape and branch-name guards', () => {
  it('rejects a clone targetDir outside the default workspace root', async () => {
    const service = new GitService();

    await expect(service.clone('https://github.com/o/r.git', 'main', '/etc/passwd')).rejects.toThrow(
      /Path escape attempt detected/,
    );
  });

  it('rejects a clone targetDir outside a given per-project workspaceRoot even though it is inside the default root', async () => {
    const service = new GitService();
    const otherProjectRoot = '/tmp/caf-orchestrator-other-project';

    await expect(
      service.clone('https://github.com/o/r.git', 'main', join(workspaceRoot, 'job-1', 'repo'), otherProjectRoot),
    ).rejects.toThrow(/Path escape attempt detected/);
  });

  it('accepts a targetDir that resolves inside the given workspaceRoot', async () => {
    const service = new GitService();
    const otherProjectRoot = '/tmp/caf-orchestrator-other-project';
    const targetDir = join(otherProjectRoot, 'job-1', 'repo');

    // Escapes the guard, then fails on the actual `git` spawn (no such binary
    // path/repo) — proves the guard itself did not block a legitimate path.
    await expect(
      service.clone('https://github.com/o/r.git', 'main', targetDir, otherProjectRoot),
    ).rejects.toThrow(/git (clone|spawn error)/);
  });

  it('rejects an unsafe branch name (shell-metacharacter-bearing) before spawning git', async () => {
    const service = new GitService();

    await expect(
      service.createBranch(join(workspaceRoot, 'job-1', 'repo'), 'main; rm -rf /'),
    ).rejects.toThrow(/Unsafe branch name rejected/);
  });

  it('rejects a path-escape attempt on push', async () => {
    const service = new GitService();

    await expect(service.push('/var/tmp/escaped', 'ai-agent/CAF-123')).rejects.toThrow(
      /Path escape attempt detected/,
    );
  });

  it('rejects a path-escape attempt on commitAll', async () => {
    const service = new GitService();

    await expect(service.commitAll('/var/tmp/escaped', 'msg')).rejects.toThrow(/Path escape attempt detected/);
  });
});

describe('GitService.remoteBranchExists (CAF-RESUMEBRANCH-01)', () => {
  it('rejects an unsafe branch name before spawning git', async () => {
    const service = new GitService();

    await expect(
      service.remoteBranchExists('https://github.com/o/r.git', 'main; rm -rf /', workspaceRoot),
    ).rejects.toThrow(/Unsafe branch name rejected/);
  });

  it('returns true when the branch exists on the remote, false when it does not — against a real local repo', async () => {
    // A real local (file://-style plain-path) remote, not a mock, so this
    // exercises the actual `git ls-remote --exit-code` exit-code handling
    // (0 = found, 2 = not found) rather than a stubbed assumption about it.
    const remoteDir = mkdtempSync(join(tmpdir(), 'caf-remote-'));
    const cwdDir = mkdtempSync(join(tmpdir(), 'caf-cwd-'));
    try {
      execFileSync('git', ['init', '--quiet', '--initial-branch=main', remoteDir]);
      execFileSync('git', ['-C', remoteDir, 'config', 'user.email', 'test@test.com']);
      execFileSync('git', ['-C', remoteDir, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', remoteDir, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
      execFileSync('git', ['-C', remoteDir, 'branch', 'ai-agent/CAF-123']);

      const service = new GitService();

      await expect(service.remoteBranchExists(remoteDir, 'ai-agent/CAF-123', cwdDir)).resolves.toBe(true);
      await expect(service.remoteBranchExists(remoteDir, 'ai-agent/CAF-999', cwdDir)).resolves.toBe(false);
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});
