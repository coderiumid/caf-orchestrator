import 'dotenv/config';
import { resolve } from 'node:path';
import { configSchema, type AppConfig } from './schema.js';
import { readYamlConfig } from './yaml-config.js';
import { ProjectRegistry } from './project-registry.js';

const YAML_CONFIG_PATH = resolve(process.cwd(), 'caf.config.yaml');

function loadConfig(): Readonly<AppConfig> {
  const yamlRaw = readYamlConfig(YAML_CONFIG_PATH);
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
