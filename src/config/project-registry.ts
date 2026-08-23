import { projectsSchema, type ProjectConfig } from './project-config.schema.js';
import { readYamlConfig } from './yaml-config.js';

export type { ProjectConfig };

/**
 * Registry of per-project structural config, keyed by ticketPrefix (not
 * project name). Standalone in this checkpoint — nothing wires it into
 * config/index.ts, the webhook handler, or the pipeline use-case yet.
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

  /** Reads and validates the `projects:` section of a caf.config.yaml-shaped file at filePath. */
  static load(filePath: string): ProjectRegistry {
    const raw = readYamlConfig(filePath);
    const projects = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).projects : undefined;
    return ProjectRegistry.fromRawProjects(projects);
  }

  getByPrefix(prefix: string): ProjectConfig | undefined {
    return this.byPrefix.get(prefix);
  }

  getAll(): ProjectConfig[] {
    return [...this.byPrefix.values()];
  }
}
