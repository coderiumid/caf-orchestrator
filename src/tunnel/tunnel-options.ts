/**
 * Cloudflare tunnel settings, shared by `pnpm tunnel` and the TUI. Pure (no
 * I/O, no config/index.ts) so both can import it without a full env.
 *
 *   TUNNEL_NAME        tunnel to run (default: ai-code-review)
 *   TUNNEL_URL         public https URL the tunnel is routed to (display + webhook hints)
 *   TUNNEL_TARGET_URL  local origin to expose (default: http://localhost:<server.port>)
 *   CLOUDFLARED_BIN    cloudflared binary (default: cloudflared)
 *
 * CLI flags --name, --url and --target override the env.
 */

export const DEFAULT_TUNNEL_NAME = 'ai-code-review';
export const DEFAULT_CLOUDFLARED_BIN = 'cloudflared';

export interface TunnelOptions {
  name: string;
  /** Public https origin (no trailing slash), or null when TUNNEL_URL is not set. */
  publicUrl: string | null;
  targetUrl: string;
  command: string;
  /** `tunnel run --url <target> <name>` — passed as argv, never through a shell. */
  args: string[];
  /** Webhook endpoints behind the public URL; null without a public URL. */
  webhookUrls: { linear: string; github: string; health: string } | null;
}

export type TunnelResolution = { ok: true; options: TunnelOptions } | { ok: false; error: string };

export interface TunnelInput {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  serverPort: number;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Reads `--key value` and `--key=value`. A later occurrence wins; unknown flags are reported. */
export function parseTunnelArgs(argv: readonly string[]): { flags: Partial<Record<'name' | 'url' | 'target', string>>; unknown: string[] } {
  const flags: Partial<Record<'name' | 'url' | 'target', string>> = {};
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^--/, '');
    if (!arg.startsWith('--') || !(key === 'name' || key === 'url' || key === 'target')) {
      unknown.push(arg);
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') unknown.push(arg);
    else flags[key] = value;
  }
  return { flags, unknown };
}

function parseUrl(raw: string, label: string, protocols: readonly string[]): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `${label} is not a valid URL: ${raw}` };
  }
  if (!protocols.includes(url.protocol)) return { ok: false, error: `${label} must use ${protocols.map((p) => p.replace(':', '')).join(' or ')}: ${raw}` };
  return { ok: true, url };
}

export function resolveTunnelOptions(input: TunnelInput): TunnelResolution {
  const { flags, unknown } = parseTunnelArgs(input.argv);
  if (unknown.length > 0) return { ok: false, error: `Unknown or incomplete argument: ${unknown.join(' ')} (use --name, --url, --target)` };

  const name = (flags.name ?? input.env.TUNNEL_NAME ?? DEFAULT_TUNNEL_NAME).trim();
  if (!NAME_PATTERN.test(name)) return { ok: false, error: `TUNNEL_NAME "${name}" must be letters, digits, ".", "_" or "-" (max 64)` };

  let publicUrl: string | null = null;
  const rawPublic = (flags.url ?? input.env.TUNNEL_URL ?? '').trim();
  if (rawPublic) {
    const parsed = parseUrl(rawPublic, 'TUNNEL_URL', ['https:']);
    if (!parsed.ok) return parsed;
    publicUrl = parsed.url.origin;
  }

  const rawTarget = (flags.target ?? input.env.TUNNEL_TARGET_URL ?? '').trim() || `http://localhost:${input.serverPort}`;
  const target = parseUrl(rawTarget, 'TUNNEL_TARGET_URL', ['http:', 'https:']);
  if (!target.ok) return target;
  const targetUrl = target.url.origin;

  const command = (input.env.CLOUDFLARED_BIN ?? '').trim() || DEFAULT_CLOUDFLARED_BIN;
  return {
    ok: true,
    options: {
      name,
      publicUrl,
      targetUrl,
      command,
      args: ['tunnel', 'run', '--url', targetUrl, name],
      webhookUrls: publicUrl ? { linear: `${publicUrl}/webhooks/linear`, github: `${publicUrl}/webhooks/github`, health: `${publicUrl}/health` } : null,
    },
  };
}

/** One printable line: `cloudflared tunnel run --url http://localhost:3030 ai-code-review`. */
export function describeCommand(o: TunnelOptions): string {
  return [o.command, ...o.args].join(' ');
}

export const CLOUDFLARED_INSTALL_HINT = 'cloudflared not found. Install it (macOS: brew install cloudflared) or set CLOUDFLARED_BIN to its path.';
