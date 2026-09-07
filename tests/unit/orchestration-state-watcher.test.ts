import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { startOrchestrationStateWatchers } from '../../src/infrastructure/watch/orchestration-state-watcher.js';
import type { OrchestrationStateChangeEvent } from '../../src/infrastructure/watch/orchestration-state-watcher.js';
import type { ProjectConfig } from '../../src/config/project-registry.js';

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    ticketPrefix: 'CAF',
    repoCloneUrl: 'https://github.com/ganjardbc/umkm-pos.git',
    baseBranch: 'main',
    workspaceDir: mkdtempSync(join(tmpdir(), 'caf-dashboard-01-watch-')),
    agents: { modelOverrides: {} },
    orchestration: {},
    ...overrides,
  };
}

function waitForEvent(events: OrchestrationStateChangeEvent[], count: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (events.length >= count) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${count} event(s), got ${events.length}`));
      setTimeout(check, 50);
    };
    check();
  });
}

describe('startOrchestrationStateWatchers', () => {
  let watchers: FSWatcher[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(watchers.map((w) => w.close()));
    watchers = [];
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tags events with the correct repoId when two repos change independently', async () => {
    const projectA = makeProject({ repoCloneUrl: 'https://github.com/ganjardbc/umkm-pos.git' });
    const projectB = makeProject({ repoCloneUrl: 'https://github.com/ganjardbc/other-repo.git' });
    tmpDirs.push(projectA.workspaceDir, projectB.workspaceDir);

    const events: OrchestrationStateChangeEvent[] = [];
    watchers = startOrchestrationStateWatchers([projectA, projectB], (event) => events.push(event));

    // Let chokidar finish its initial directory scan before writing.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stateDirA = join(projectA.workspaceDir, 'repo', '.caf', 'tasks', 'CAF-1');
    mkdirSync(stateDirA, { recursive: true });
    writeFileSync(join(stateDirA, 'orchestration-state.json'), '{}');

    const stateDirB = join(projectB.workspaceDir, 'job-abc', '.caf', 'tasks', 'CAF-2');
    mkdirSync(stateDirB, { recursive: true });
    writeFileSync(join(stateDirB, 'orchestration-state.json'), '{}');

    await waitForEvent(events, 2);

    const byTicket = new Map(events.map((e) => [e.ticketId, e]));
    expect(byTicket.get('CAF-1')).toMatchObject({ repoId: 'ganjardbc/umkm-pos', eventType: 'add' });
    expect(byTicket.get('CAF-2')).toMatchObject({ repoId: 'ganjardbc/other-repo', eventType: 'add' });
  });

  it('emits an unlink event when orchestration-state.json is removed (e.g. resetOrchestrationState on success)', async () => {
    const project = makeProject();
    tmpDirs.push(project.workspaceDir);

    const events: OrchestrationStateChangeEvent[] = [];
    watchers = startOrchestrationStateWatchers([project], (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stateDir = join(project.workspaceDir, 'persistent-umkm-pos', '.caf', 'tasks', 'CAF-3');
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, 'orchestration-state.json');
    writeFileSync(filePath, '{}');
    await waitForEvent(events, 1);

    unlinkSync(filePath);
    await waitForEvent(events, 2);

    expect(events[1]).toMatchObject({ ticketId: 'CAF-3', eventType: 'unlink' });
  });
});
