/**
 * In-process pub/sub for the live tail (SSE) endpoint. One process, one bus: no
 * cross-instance fan-out is needed since v0.2 explicitly excludes a global live feed.
 */
export type LiveEventKind = 'segment' | 'outcome' | 'session';

export interface LiveMessage {
  event: LiveEventKind;
  data: unknown;
}

type Listener = (msg: LiveMessage) => void;

export class SessionBus {
  private listeners = new Map<string, Set<Listener>>();

  /** Subscribes to a session's live events; returns an idempotent unsubscribe function. */
  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => this.unsubscribe(sessionId, listener);
  }

  unsubscribe(sessionId: string, listener: Listener): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(sessionId);
  }

  emit(sessionId: string, msg: LiveMessage): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const listener of set) listener(msg);
  }

  listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }
}
