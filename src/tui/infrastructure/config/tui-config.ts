import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { configSchema } from '../../../config/schema.js';
import { readYamlConfig } from '../../../config/yaml-config.js';
import { resolveTunnelOptions } from '../../../tunnel/tunnel-options.js';
import type { TuiSettings } from '../../domain/models/settings.js';

/**
 * Side-effect-free twin of config/index.ts: same env + YAML merge and the same
 * schema, but returns the problems instead of throwing at import time, so the
 * TUI can show them in a modal instead of dying (or letting the child
 * processes die with an opaque crash).
 */

function tunnelSettings(env: NodeJS.ProcessEnv, serverPort: number): Pick<TuiSettings, 'tunnel' | 'tunnelError'> {
  const r = resolveTunnelOptions({ env, argv: [], serverPort });
  return r.ok ? { tunnel: r.options, tunnelError: null } : { tunnel: null, tunnelError: r.error };
}

export type TuiConfigResult = { ok: true; settings: TuiSettings } | { ok: false; errors: string[]; settings: TuiSettings | null };

export function loadTuiConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env): TuiConfigResult {
  const envPath = resolve(repoRoot, '.env');
  const yamlPath = resolve(repoRoot, 'caf.config.yaml');
  const errors: string[] = [];

  if (!existsSync(envPath)) errors.push(`.env not found at ${envPath} (copy .env.example)`);
  else loadDotenv({ path: envPath, processEnv: env, quiet: true });

  let yamlRaw: unknown = {};
  try {
    yamlRaw = readYamlConfig(yamlPath);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  const merged = { ...env, ...(typeof yamlRaw === 'object' && yamlRaw !== null ? yamlRaw : {}) };
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    // Best-effort settings so the TUI still opens (and shows the problems) when config is broken.
    const y = (typeof yamlRaw === 'object' && yamlRaw !== null ? yamlRaw : {}) as {
      server?: { port?: number };
      db?: { path?: string };
      claude?: { agentTimeoutMs?: number };
    };
    return {
      ok: false,
      errors,
      settings: {
        repoRoot,
        serverPort: y.server?.port ?? 3000,
        redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
        dbPath: resolve(repoRoot, y.db?.path ?? './data/caf-dashboard.sqlite'),
        agentTimeoutMs: y.claude?.agentTimeoutMs ?? 1_800_000,
        retryLimits: { qa: null, reviewer: null },
        pipelineTriggerEnabled: null,
        ...tunnelSettings(env, y.server?.port ?? 3000),
      },
    };
  }

  const c = parsed.data;
  const settings: TuiSettings = {
    repoRoot,
    serverPort: c.server.port,
    redisUrl: c.REDIS_URL,
    dbPath: resolve(repoRoot, c.db.path),
    agentTimeoutMs: c.claude.agentTimeoutMs,
    retryLimits: { qa: c.agents?.qa?.maxRetries ?? null, reviewer: c.agents?.reviewer?.maxRetries ?? null },
    pipelineTriggerEnabled: typeof c.ENABLE_PIPELINE_TRIGGER === 'boolean' ? c.ENABLE_PIPELINE_TRIGGER : null,
    ...tunnelSettings(env, c.server.port),
  };
  return errors.length > 0 ? { ok: false, errors, settings } : { ok: true, settings };
}
