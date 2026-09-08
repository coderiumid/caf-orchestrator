import { basename, dirname } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ProjectConfig } from '../../config/project-registry.js';
import { repoIdFromCloneUrl } from '../db/pipeline-instrumentation.js';
import { logger } from '../logging/logger.js';

export interface OrchestrationStateChangeEvent {
  repoId: string;
  ticketId: string;
  eventType: 'add' | 'change' | 'unlink';
  timestamp: string;
}

const FS_EVENTS = ['add', 'change', 'unlink'] as const;

/** `.../.caf/tasks/<ticketKey>/orchestration-state.json` — the ticket key is the parent directory name (see taskDir() in report-reader.ts). */
function ticketIdFromPath(path: string): string {
  return basename(dirname(path));
}

/**
 * CAF-DASHBOARD-01 Task 4: one chokidar watcher per configured project,
 * rooted at that project's own `workspaceDir` — projects never share or nest
 * workspaceDir (enforced by project-config.schema.ts's cross-project check),
 * so each watcher's events are unambiguously that project's repo, no path
 * parsing needed to tell repos apart. Works under both workspace modes:
 * persistent (`persistent-<repo>/...`, stable across runs) and ephemeral
 * (`job-<uuid>/...`, exists only for the run's duration) — either way, the
 * glob matches while a run is live and picking up its state changes; an
 * ephemeral job's directory is removed by `cleanupWorkspace` only after
 * `execute()` returns, by which point any change has already been broadcast.
 */
export function startOrchestrationStateWatchers(
  projects: ProjectConfig[],
  onEvent: (event: OrchestrationStateChangeEvent) => void,
): FSWatcher[] {
  return projects.map((project) => {
    const repoId = repoIdFromCloneUrl(project.repoCloneUrl);
    const pattern = `${project.workspaceDir}/**/.caf/tasks/*/orchestration-state.json`;
    // The glob root is workspaceDir — a cloned target repo, which can contain
    // .git (thousands of loose objects) and node_modules if deps were
    // installed. Without excluding these, chokidar recurses into and watches
    // every one of those files/dirs too (inotify watch per dir on Linux),
    // which can exhaust fs.inotify.max_user_watches or spike memory on a
    // small VPS while a pipeline run is actively writing/checking out files.
    const watcher = chokidar.watch(pattern, {
      ignoreInitial: true,
      ignored: ['**/.git/**', '**/node_modules/**'],
    });

    for (const eventType of FS_EVENTS) {
      watcher.on(eventType, (path: string) => {
        onEvent({ repoId, ticketId: ticketIdFromPath(path), eventType, timestamp: new Date().toISOString() });
      });
    }

    watcher.on('error', (err) => {
      logger.error(
        'Orchestration-state watcher error',
        err instanceof Error ? err : new Error(String(err)),
        { repoId, workspaceDir: project.workspaceDir },
      );
    });

    return watcher;
  });
}
