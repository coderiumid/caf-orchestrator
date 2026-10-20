export type TunnelReach = 'up' | 'down' | 'unknown';

/**
 * Whether the tunnel's public URL answers through Cloudflare. It is a real
 * request to the internet, so it is throttled; it resets to 'unknown' whenever
 * the tunnel is not running, so the next start is probed immediately.
 */
export class TunnelMonitor {
  reach: TunnelReach = 'unknown';
  private lastProbeAt = 0;

  constructor(
    private readonly probe: (url: string) => Promise<boolean>,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 10_000,
  ) {}

  async update(running: boolean, publicUrl: string | null): Promise<void> {
    if (!running || !publicUrl) {
      this.reach = 'unknown';
      this.lastProbeAt = 0;
      return;
    }
    const t = this.now();
    if (t - this.lastProbeAt < this.intervalMs) return;
    this.lastProbeAt = t;
    this.reach = (await this.probe(`${publicUrl}/health`)) ? 'up' : 'down';
  }
}
