import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const defaultRoot = mkdtempSync(join(tmpdir(), 'caf-orchestrator-default-'));
const projectRoot = mkdtempSync(join(tmpdir(), 'caf-orchestrator-project-'));

// Mutable so individual tests can flip workspace.mode between 'ephemeral'/'persistent'.
const mockConfig = { workspace: { dir: defaultRoot, mode: 'ephemeral' as 'ephemeral' | 'persistent' } };

vi.mock('../../src/config/index.js', () => ({
  config: mockConfig,
}));

const { WorkspaceManager } = await import('../../src/infrastructure/git/workspace.manager.js');
const { WorkspaceLockError } = await import('../../src/domain/errors/app-errors.js');

describe('WorkspaceManager', () => {
  afterAll(() => {
    rmSync(defaultRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('creates a workspace under the global default root when no rootDir is given', async () => {
    const manager = new WorkspaceManager();
    const path = await manager.createWorkspace();

    expect(path.startsWith(defaultRoot)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('creates a workspace under a per-project rootDir when given', async () => {
    const manager = new WorkspaceManager();
    const path = await manager.createWorkspace(projectRoot);

    expect(path.startsWith(projectRoot)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('validatePath accepts a path inside the given rootDir and rejects one outside it', () => {
    const manager = new WorkspaceManager();

    expect(manager.validatePath(join(projectRoot, 'job-1'), projectRoot)).toBe(true);
    expect(manager.validatePath(join(defaultRoot, 'job-1'), projectRoot)).toBe(false);
  });

  it('validatePath falls back to the global default root when rootDir is omitted', () => {
    const manager = new WorkspaceManager();

    expect(manager.validatePath(join(defaultRoot, 'job-1'))).toBe(true);
    expect(manager.validatePath(join(projectRoot, 'job-1'))).toBe(false);
  });

  it('cleanupWorkspace throws on a path-escape attempt rather than deleting outside the root', async () => {
    const manager = new WorkspaceManager();
    const escapePath = join(projectRoot, '..');

    await expect(manager.cleanupWorkspace(escapePath, projectRoot)).rejects.toThrow(/escape attempt/);
  });

  it('cleanupWorkspace removes a workspace created under a custom rootDir', async () => {
    const manager = new WorkspaceManager();
    const path = await manager.createWorkspace(projectRoot);
    expect(existsSync(path)).toBe(true);

    await manager.cleanupWorkspace(path, projectRoot);

    expect(existsSync(path)).toBe(false);
  });

  describe('persistent mode (workspacePurpose: ticket-pipeline)', () => {
    afterAll(() => {
      mockConfig.workspace.mode = 'ephemeral';
    });

    it('ephemeral job-<uuid> dir when workspace.mode is persistent but workspacePurpose is pr-review', async () => {
      mockConfig.workspace.mode = 'persistent';
      const manager = new WorkspaceManager();

      const path = await manager.createWorkspace(projectRoot, 'pr-review', 'some-repo');

      expect(path).toMatch(/job-/);
      await manager.cleanupWorkspace(path, projectRoot, 'pr-review');
      expect(existsSync(path)).toBe(false);
    });

    it('ephemeral job-<uuid> dir when workspacePurpose is ticket-pipeline but workspace.mode is ephemeral', async () => {
      mockConfig.workspace.mode = 'ephemeral';
      const manager = new WorkspaceManager();

      const path = await manager.createWorkspace(projectRoot, 'ticket-pipeline', 'some-repo');

      expect(path).toMatch(/job-/);
      await manager.cleanupWorkspace(path, projectRoot, 'ticket-pipeline');
      expect(existsSync(path)).toBe(false);
    });

    it('reuses a stable persistent-<repo> dir and does not remove it on cleanup', async () => {
      mockConfig.workspace.mode = 'persistent';
      const manager = new WorkspaceManager();

      const firstPath = await manager.createWorkspace(projectRoot, 'ticket-pipeline', 'repo-reuse');
      expect(firstPath).toBe(join(projectRoot, 'persistent-repo-reuse'));
      expect(existsSync(firstPath)).toBe(true);

      await manager.cleanupWorkspace(firstPath, projectRoot, 'ticket-pipeline');
      expect(existsSync(firstPath)).toBe(true);

      const secondPath = await manager.createWorkspace(projectRoot, 'ticket-pipeline', 'repo-reuse');
      expect(secondPath).toBe(firstPath);

      await manager.cleanupWorkspace(secondPath, projectRoot, 'ticket-pipeline');
    });

    it('rejects a second createWorkspace for the same repo while the first job still holds the lock', async () => {
      mockConfig.workspace.mode = 'persistent';
      const manager = new WorkspaceManager();

      const path = await manager.createWorkspace(projectRoot, 'ticket-pipeline', 'repo-lock');

      await expect(manager.createWorkspace(projectRoot, 'ticket-pipeline', 'repo-lock')).rejects.toThrow(WorkspaceLockError);

      await manager.cleanupWorkspace(path, projectRoot, 'ticket-pipeline');
      await expect(manager.createWorkspace(projectRoot, 'ticket-pipeline', 'repo-lock')).resolves.toBe(path);
      await manager.cleanupWorkspace(path, projectRoot, 'ticket-pipeline');
    });

    it('throws when workspacePurpose is ticket-pipeline + persistent mode but repoIdentifier is missing', async () => {
      mockConfig.workspace.mode = 'persistent';
      const manager = new WorkspaceManager();

      await expect(manager.createWorkspace(projectRoot, 'ticket-pipeline')).rejects.toThrow(/repoIdentifier/);
    });
  });
});
