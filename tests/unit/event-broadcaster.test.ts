import { describe, it, expect, vi } from 'vitest';
import { EventBroadcaster, type DashboardEvent } from '../../src/presentation/web/sse/event-broadcaster.js';

function makeEvent(overrides: Partial<DashboardEvent> = {}): DashboardEvent {
  return { repoId: 'ganjardbc/umkm-pos', ticketId: 'CAF-1', eventType: 'add', timestamp: '2026-09-07T00:00:00.000Z', ...overrides };
}

describe('EventBroadcaster', () => {
  it('writes an SSE-framed event to every subscribed client', () => {
    const broadcaster = new EventBroadcaster();
    const writeA = vi.fn();
    const writeB = vi.fn();
    broadcaster.subscribe({ write: writeA });
    broadcaster.subscribe({ write: writeB });

    const event = makeEvent();
    broadcaster.broadcast(event);

    const expectedFrame = `data: ${JSON.stringify(event)}\n\n`;
    expect(writeA).toHaveBeenCalledWith(expectedFrame);
    expect(writeB).toHaveBeenCalledWith(expectedFrame);
  });

  it('stops delivering to a client after it unsubscribes', () => {
    const broadcaster = new EventBroadcaster();
    const write = vi.fn();
    const unsubscribe = broadcaster.subscribe({ write });

    unsubscribe();
    broadcaster.broadcast(makeEvent());

    expect(write).not.toHaveBeenCalled();
  });

  it('drops a client whose write throws, without affecting other clients', () => {
    const broadcaster = new EventBroadcaster();
    const brokenWrite = vi.fn(() => {
      throw new Error('socket closed');
    });
    const goodWrite = vi.fn();
    broadcaster.subscribe({ write: brokenWrite });
    broadcaster.subscribe({ write: goodWrite });

    broadcaster.broadcast(makeEvent());
    expect(goodWrite).toHaveBeenCalledTimes(1);
    expect(broadcaster.clientCount).toBe(1);

    broadcaster.broadcast(makeEvent());
    expect(brokenWrite).toHaveBeenCalledTimes(1);
    expect(goodWrite).toHaveBeenCalledTimes(2);
  });

  it('reports an accurate clientCount', () => {
    const broadcaster = new EventBroadcaster();
    expect(broadcaster.clientCount).toBe(0);
    const unsubscribe = broadcaster.subscribe({ write: vi.fn() });
    expect(broadcaster.clientCount).toBe(1);
    unsubscribe();
    expect(broadcaster.clientCount).toBe(0);
  });
});
