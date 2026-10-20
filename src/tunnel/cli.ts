import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { readYamlConfig } from '../config/yaml-config.js';
import { CLOUDFLARED_INSTALL_HINT, describeCommand, resolveTunnelOptions } from './tunnel-options.js';

/**
 * `pnpm tunnel [--name <tunnel>] [--url <https public url>] [--target <local origin>]`
 *
 * Runs `cloudflared tunnel run --url <target> <name>` in the foreground. Config
 * comes from .env (TUNNEL_NAME / TUNNEL_URL / TUNNEL_TARGET_URL / CLOUDFLARED_BIN),
 * the target defaults to this app's own server.port, and flags win over env.
 * Deliberately avoids config/index.ts so it works without the full app env.
 */

function serverPort(repoRoot: string): number {
  try {
    const yaml = readYamlConfig(resolve(repoRoot, 'caf.config.yaml')) as { server?: { port?: number } };
    return yaml.server?.port ?? 3000;
  } catch {
    return 3000;
  }
}

function main(): void {
  const repoRoot = process.cwd();
  loadDotenv({ path: resolve(repoRoot, '.env'), quiet: true });

  const resolved = resolveTunnelOptions({ env: process.env, argv: process.argv.slice(2), serverPort: serverPort(repoRoot) });
  if (!resolved.ok) {
    console.error(`tunnel: ${resolved.error}`);
    process.exit(2);
  }
  const o = resolved.options;

  const probe = spawnSync(o.command, ['--version'], { stdio: 'ignore' });
  if (probe.error) {
    console.error(`tunnel: ${CLOUDFLARED_INSTALL_HINT}`);
    process.exit(127);
  }

  console.log(`tunnel  ${o.name}`);
  console.log(`origin  ${o.targetUrl}`);
  if (o.webhookUrls && o.publicUrl) {
    console.log(`public  ${o.publicUrl}`);
    console.log(`        Linear webhook  ${o.webhookUrls.linear}`);
    console.log(`        GitHub webhook  ${o.webhookUrls.github}`);
  } else {
    console.log('public  (set TUNNEL_URL in .env to print the webhook URLs)');
  }
  console.log(`$ ${describeCommand(o)}\n`);

  const child = spawn(o.command, o.args, { stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('error', (err) => {
    console.error(`tunnel: failed to start ${o.command}: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

main();
