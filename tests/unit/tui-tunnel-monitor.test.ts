import { describe, expect, it, vi } from 'vitest';
import { TunnelMonitor } from '../../src/tui/application/services/tunnel-monitor.js';

describe('TunnelMonitor', () => {
  it('stays unknown and does not probe unless the tunnel runs with a public URL', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const m = new TunnelMonitor(probe, () => 0);
    await m.update(false, 'https://x.example');
    await m.update(true, null);
    expect(m.reach).toBe('unknown');
    expect(probe).not.toHaveBeenCalled();
  });

  it('probes <url>/health and records the answer', async () => {
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    let now = 100_000;
    const m = new TunnelMonitor(probe, () => now);
    await m.update(true, 'https://x.example');
    expect(probe).toHaveBeenCalledWith('https://x.example/health');
    expect(m.reach).toBe('up');
    now += 10_000;
    await m.update(true, 'https://x.example');
    expect(m.reach).toBe('down');
  });

  it('throttles probes to the interval', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    let now = 100_000;
    const m = new TunnelMonitor(probe, () => now, 10_000);
    await m.update(true, 'https://x.example');
    now += 4_000;
    await m.update(true, 'https://x.example');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('forgets the answer when the tunnel stops, so a restart is probed at once', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    let now = 100_000;
    const m = new TunnelMonitor(probe, () => now);
    await m.update(true, 'https://x.example');
    await m.update(false, 'https://x.example');
    expect(m.reach).toBe('unknown');
    now += 1_000;
    await m.update(true, 'https://x.example');
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
