import 'dotenv/config';
import { resolve } from 'node:path';
import { configSchema, type AppConfig } from './schema.js';
import { readYamlConfig } from './yaml-config.js';
import { ProjectRegistry } from './project-registry.js';

const YAML_CONFIG_PATH = resolve(process.cwd(), 'caf.config.yaml');

function loadConfig(): Readonly<AppConfig> {
  const yamlRaw = readYamlConfig(YAML_CONFIG_PATH);
  // yamlRaw spreads last, so a caf.config.yaml top-level key wins over a same-named
  // env var. Intentional: yaml keys are lower/nested (repo, workspace, agents, ...)
  // and env keys are UPPER_SNAKE, so there's no live collision today — but this is
  // the precedence to keep in mind if that ever changes.
  const merged = { ...process.env, ...(typeof yamlRaw === 'object' && yamlRaw !== null ? yamlRaw : {}) };

  const result = configSchema.safeParse(merged);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }

  return Object.freeze(result.data);
}

export const config: Readonly<AppConfig> = loadConfig();
export type { AppConfig };

export const projectRegistry: ProjectRegistry = ProjectRegistry.load(YAML_CONFIG_PATH);
