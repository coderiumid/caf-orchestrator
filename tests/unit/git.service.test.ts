import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

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
