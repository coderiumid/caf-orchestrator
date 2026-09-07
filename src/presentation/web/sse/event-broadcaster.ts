/**
 * In-memory SSE fan-out for CAF-DASHBOARD-01 Task 4. One process, one
 * broadcaster — every connected /api/events/stream client is a `write`able
 * sink added here; every orchestration-state.json change (per-repo watcher,
 * see orchestration-state-watcher.ts) is broadcast to all of them.
 */

export interface DashboardEvent {
  repoId: string;
  ticketId: string;
  eventType: 'add' | 'change' | 'unlink';
  timestamp: string;
}

export interface SseClient {
  write: (chunk: string) => void;
}

export class EventBroadcaster {
  private readonly clients = new Set<SseClient>();

  /** Registers a client sink; returns an unsubscribe function (call on connection close). */
  subscribe(client: SseClient): () => void {
    this.clients.add(client);
    return () => {
      this.clients.delete(client);
    };
  }

  broadcast(event: DashboardEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        // A dead/closed connection shouldn't take down the broadcast to
        // everyone else — drop it, the 'close' handler on the route will
        // also try to unsubscribe (idempotent, Set#delete on a missing
        // member is a no-op).
        this.clients.delete(client);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export const eventBroadcaster = new EventBroadcaster();
