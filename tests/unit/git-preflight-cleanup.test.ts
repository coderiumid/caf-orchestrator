import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaceRoot = mkdtempSync(join(tmpdir(), 'caf-orchestrator-preflight-root-'));

vi.mock('../../src/config/index.js', () => ({
  config: { workspace: { dir: workspaceRoot }, GITHUB_TOKEN: undefined },
}));

const { GitService } = await import('../../src/infrastructure/git/git.service.js');
const { logger } = await import('../../src/infrastructure/logging/logger.js');

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

describe('GitService.preflightCleanup (real local repo)', () => {
  let bareDir: string;
  let workDir: string;

  beforeAll(() => {
    bareDir = mkdtempSync(join(tmpdir(), 'caf-orchestrator-preflight-bare-'));
    sh('git init --bare', bareDir);

    workDir = join(workspaceRoot, 'repo');
    sh(`git clone ${bareDir} ${workDir}`, workspaceRoot);
    sh('git config user.email test@example.com', workDir);
    sh('git config user.name test', workDir);
    sh('git checkout -b main', workDir);
    writeFileSync(join(workDir, 'file.txt'), 'v1\n');
    sh('git add -A', workDir);
    sh('git commit -m init', workDir);
    sh('git push origin main', workDir);
  });

  afterAll(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  });

  it('discards uncommitted changes, resets to origin/main, and logs an audit trail before the reset', async () => {
    writeFileSync(join(workDir, 'file.txt'), 'dirty change\n');
    writeFileSync(join(workDir, 'untracked.txt'), 'new file\n');

    const warnSpy = vi.spyOn(logger, 'warn');
    const service = new GitService();

    const result = await service.preflightCleanup(workDir, 'main', workspaceRoot);

    expect(result.hadUncommittedChanges).toBe(true);
    expect(result.branchBeforeReset).toBe('main');
    expect(result.statusBeforeReset).toContain('file.txt');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('discarding uncommitted changes'),
      undefined,
      expect.objectContaining({
        branch: 'main',
        status: expect.stringContaining('file.txt'),
      }),
    );

    expect(sh('git status --short', workDir).trim()).toBe('');
    expect(sh('cat file.txt', workDir).trim()).toBe('v1');

    warnSpy.mockRestore();
  });

  it('runs cleanup without an audit-trail warn log when the workspace is already clean', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const service = new GitService();

    const result = await service.preflightCleanup(workDir, 'main', workspaceRoot);

    expect(result.hadUncommittedChanges).toBe(false);
    expect(result.statusBeforeReset).toBe('');
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
