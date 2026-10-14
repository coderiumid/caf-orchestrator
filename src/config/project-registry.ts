import { projectsSchema, type ProjectConfig } from './project-config.schema.js';
import { readYamlConfig } from './yaml-config.js';

export type { ProjectConfig };

/**
 * Registry of per-project structural config, keyed by ticketPrefix (not
 * project name). Wired into config/index.ts (exported as `projectRegistry`),
 * the webhook handler (looks up by ticket prefix), and carried through the
 * pipeline use-case via the job's `projectConfig`.
 */
export class ProjectRegistry {
  private constructor(private readonly byPrefix: Map<string, ProjectConfig>) {}

  /** Validates a raw `projects:` map (e.g. already-parsed YAML) and builds a registry. Throws with all validation errors collected, not just the first. */
  static fromRawProjects(raw: unknown): ProjectRegistry {
    const result = projectsSchema.safeParse(raw ?? {});
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  - projects${issue.path.length > 0 ? `.${issue.path.join('.')}` : ''}: ${issue.message}`)
        .join('\n');
      throw new Error(`Project registry validation failed:\n${issues}`);
    }

    const byPrefix = new Map<string, ProjectConfig>();
    for (const project of Object.values(result.data)) {
      byPrefix.set(project.ticketPrefix, project);
    }
    return new ProjectRegistry(byPrefix);
  }

  /**
   * Reads and validates the `projects:` section of a caf.config.yaml-shaped file at
   * filePath. Fails fast if the section is missing or empty — unlike
   * `fromRawProjects` (which tolerates an empty map for callers that build a
   * registry incrementally), a registry loaded at startup with zero projects
   * means no ticket prefix could ever match, so the pipeline would silently
   * never trigger for any webhook with no error anywhere.
   */
  static load(filePath: string): ProjectRegistry {
    const raw = readYamlConfig(filePath);
    const projects = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).projects : undefined;
    const registry = ProjectRegistry.fromRawProjects(projects);
    if (registry.getAll().length === 0) {
      throw new Error(
        `Project registry validation failed:\n  - projects: at least one project must be configured under "projects:" in ${filePath} — an empty/missing registry means no ticket could ever trigger the pipeline`,
      );
    }
    return registry;
  }

  getByPrefix(prefix: string): ProjectConfig | undefined {
    return this.byPrefix.get(prefix);
  }

  getAll(): ProjectConfig[] {
    return [...this.byPrefix.values()];
  }
}

/** Per-repo orchestration.maxOrchestrationRetries wins when set; otherwise falls back to the global default (config.orchestration.maxOrchestrationRetries). */
export function resolveMaxOrchestrationRetries(project: ProjectConfig, globalDefault: number): number {
  return project.orchestration.maxOrchestrationRetries ?? globalDefault;
}

export const DEFAULT_SPEC_GATE_LABEL = 'spec-approval';

/**
 * Label that puts a ticket behind the spec-approval gate (CAF-SDD-04c): the
 * project's own label for that tracker wins, then the global one, then the
 * `spec-approval` default (also what a partial config mock without the key gets).
 */
export function resolveSpecGateLabel(
  project: ProjectConfig,
  source: 'github' | 'linear',
  globals: { github?: { specGateLabel?: string }; linear?: { specGateLabel?: string } },
): string {
  return project[source]?.specGateLabel ?? globals[source]?.specGateLabel ?? DEFAULT_SPEC_GATE_LABEL;
}
