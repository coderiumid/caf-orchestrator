import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Reads and parses the structural (non-secret) config YAML file. Kept separate
 * from process.env loading (index.ts) so the missing-file / parse-error paths
 * can be unit tested without touching the real filesystem path.
 */
export function readYamlConfig(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new Error(
        `Config file not found at ${filePath}. Copy caf.config.example.yaml to caf.config.yaml and fill in the structural (non-secret) config values.`,
      );
    }
    throw err;
  }

  try {
    return parseYaml(raw) ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${filePath} as YAML: ${message}`);
  }
}
