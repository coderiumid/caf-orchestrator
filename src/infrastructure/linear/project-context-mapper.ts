import type { ProjectConfig } from '../../config/project-registry.js';
import type { JobProjectContext } from '../../domain/interfaces/queue.interface.js';

/** Maps config-layer ProjectConfig to the domain-owned JobProjectContext carried on job payloads. */
export function toJobProjectContext(project: ProjectConfig): JobProjectContext {
  return {
    repoCloneUrl: project.repoCloneUrl,
    baseBranch: project.baseBranch,
    workspaceDir: project.workspaceDir,
    agents: {
      modelOverrides: project.agents.modelOverrides,
    },
  };
}
