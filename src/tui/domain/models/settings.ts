import type { TunnelOptions } from '../../../tunnel/tunnel-options.js';

export interface TuiSettings {
  repoRoot: string;
  serverPort: number;
  redisUrl: string;
  dbPath: string;
  agentTimeoutMs: number;
  retryLimits: { qa: number | null; reviewer: number | null };
  pipelineTriggerEnabled: boolean | null;
  /** Cloudflare tunnel settings (TUNNEL_* in .env); null when they are invalid — see tunnelError. */
  tunnel: TunnelOptions | null;
  tunnelError: string | null;
}
