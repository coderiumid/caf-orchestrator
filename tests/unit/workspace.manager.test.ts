import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const defaultRoot = mkdtempSync(join(tmpdir(), 'caf-orchestrator-default-'));
const projectRoot = mkdtempSync(join(tmpdir(), 'caf-orchestrator-project-'));

vi.mock('../../src/config/index.js', () => ({
  config: { workspace: { dir: defaultRoot } },
}));

const { WorkspaceManager } = await import('../../src/infrastructure/git/workspace.manager.js');

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
});
