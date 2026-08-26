/**
 * Internal client implementation: the bounded event queue, background
 * batching flusher, and the session/segment builder object graph. Not part
 * of the public surface directly — wired up and re-exported from
 * src/index.ts.
 */

import type {
  IngestEvent,
  IngestRequest,
  IngestResponse,
  Section,
  SectionRole,
  SegmentKind,
  SegmentOutcome,
  SegmentWithSections,
  ServiceKind,
  Session,
} from '@context-trace/types';
import { estimateTokens, fnv1a64, generateId } from '@context-trace/types';

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BATCH = 100;
const DEFAULT_MAX_QUEUE = 5000;
const DEFAULT_MAX_SESSIONS = 1000;
const MAX_SEND_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;
/**
 * Browsers cap keepalive request bodies at 64KB (shared across in-flight
 * keepalive requests). Chunk lifecycle flushes below it with headroom for
 * the envelope and multi-byte characters.
 */
const KEEPALIVE_BODY_LIMIT = 57_344;

export interface ClientOptions {
  /** Base URL of the context-trace server, e.g. 'http://localhost:4720'. */
  endpoint: string;
  apiKey?: string;
  /** Background flush interval in ms. Set to 0 to disable the timer entirely. Default 2000. */
  flushIntervalMs?: number;
  /** Max events sent per HTTP request. Default 100. */
  maxBatch?: number;
  /** Max events buffered before the oldest events are dropped. Default 5000. */
  maxQueue?: number;
  /**
   * Max distinct session ids cached for the startSession/session handle
   * cache (see `session(id)`). Bounds memory for long-lived clients that
   * see many session ids over time. On overflow the least-recently-used
   * session id is evicted. Default 1000.
   */
  maxSessions?: number;
  /** Called for dropped events, exhausted retries, and other non-fatal warnings. Never thrown from. */
  onError?: (err: Error) => void;
  /** When false, every capture call is a no-op and nothing is queued or sent. Default true. */
  enabled?: boolean;
}

export interface StartSessionOptions {
  /** Explicit session id; generated (ULID-like) if omitted. */
  id?: string;
  name: string;
  agent?: string;
  metadata?: Record<string, unknown>;
}

export interface SegmentOptions {
  /** Explicit segment id; generated if omitted. */
  id?: string;
  /** Explicit 0-based index; wins over the session's auto-counter. */
  index?: number;
  label?: string;
  /** Defaults to 'llm_call'. */
  kind?: SegmentKind;
  model?: string;
  /** ISO 8601 timestamp; defaults to now. */
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface SectionInput {
  /** Stable identity across segments, e.g. 'mem:user-profile'. */
  key: string;
  /** Contributor name, e.g. 'memory'. */
  service: string;
  serviceKind: ServiceKind;
  role?: SectionRole;
  content?: string;
  /** Defaults to estimateTokens(content ?? ''). */
  tokens?: number;
  metadata?: Record<string, unknown>;
}

export interface SegmentBuilder {
  readonly id: string;
  readonly index: number;
  /**
   * Enqueue a section for this segment. Safe to call from interleaved async
   * callbacks; the final `position` is assigned at record() time in call
   * (arrival) order. contentHash and the default token estimate are
   * computed immediately from `content`.
   */
  section(input: SectionInput): SegmentBuilder;
  /**
   * Finalize the segment snapshot and enqueue it. Idempotent: a second call
   * is a no-op that reports a warning via onError instead of throwing.
   */
  record(): void;
  /**
   * Attach a model-call result (latency, response text, scores, error) to
   * this segment. Valid only after `record()` — calling before it reports a
   * warning via onError and does not emit anything, since the server has no
   * segment id to correlate against yet.
   */
  outcome(outcome: SegmentOutcome): void;
}

export interface SessionHandle {
  readonly id: string;
  /** Start building a new segment (context snapshot) in this session. */
  segment(options?: SegmentOptions): SegmentBuilder;
  /**
   * Attach a model-call result to a segment by id, for stateless hook
   * contexts that only have a session id + segment id to correlate against
   * (rather than holding the originating `SegmentBuilder` in memory).
   */
  outcome(segmentId: string, outcome: SegmentOutcome): void;
  /** Mark the session ended. */
  end(endedAt?: string): void;
}

export interface Client {
  /** Start a new session; emits `session.started` immediately. */
  startSession(options: StartSessionOptions): SessionHandle;
  /**
   * Re-bind to an already-started (or not-yet-seen) session by id, without
   * emitting `session.started`. Intended for stateless hook contexts that
   * only have a session id to correlate against.
   */
  session(id: string): SessionHandle;
  /** Drain the queue, sending batches of up to maxBatch events. Never throws. */
  flush(): Promise<void>;
  /** Stop the background timer and flush. Never throws. */
  shutdown(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Don't let a pending backoff sleep keep a Node process alive after the
    // host is otherwise done. Guarded so this works unmodified in browsers,
    // where timers have no unref().
    const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof maybeUnref === 'function') {
      maybeUnref.call(timer);
    }
  });
}

function backoffDelay(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

/** Thrown by send() for a non-2xx HTTP response; carries the status for retry classification. */
class IngestHttpError extends Error {
  constructor(public readonly status: number) {
    super(`context-trace: ingest request failed with status ${status}`);
  }
}

/** 4xx other than 408 (timeout) and 429 (rate limit) won't succeed on retry. */
function isRetryable(err: unknown): boolean {
  if (err instanceof IngestHttpError) {
    if (err.status === 408 || err.status === 429) return true;
    return err.status < 400 || err.status >= 500;
  }
  return true;
}

/**
 * Validate a numeric option: NaN, non-finite, or below `min` (e.g. a
 * maxBatch of 0, which would make drain() splice zero-length chunks
 * forever) falls back to the default instead of being clamped, since a
 * value that low almost certainly indicates a misconfiguration rather than
 * an intentional tiny bound.
 */
function sanitizeOption(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value) || value < min) {
    return fallback;
  }
  return Math.floor(value);
}

export class ClientImpl implements Client {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly flushIntervalMs: number;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly maxSessions: number;
  private readonly onErrorCb: ((err: Error) => void) | undefined;
  private readonly enabled: boolean;

  private queue: IngestEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private onVisibilityChange: (() => void) | null = null;
  private onPageHide: (() => void) | null = null;
  /**
   * Cached per-id session handles, so repeated startSession/session calls
   * for the same id (e.g. one per hook invocation in a stateless callback
   * adapter) share one segment auto-counter instead of each minting a
   * fresh handle whose segment() always starts back at index 0. Bounded by
   * maxSessions with LRU eviction (insertion order + re-insert-on-access,
   * since Map iterates in insertion order) — evicted ids are never removed
   * on session.end(), only on overflow, so a late segment recorded after
   * end() can't accidentally reset an in-cache counter back to 0.
   */
  private readonly sessions = new Map<string, SessionHandleImpl>();

  constructor(options: ClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.flushIntervalMs = sanitizeOption(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 0);
    this.maxBatch = sanitizeOption(options.maxBatch, DEFAULT_MAX_BATCH, 1);
    this.maxQueue = sanitizeOption(options.maxQueue, DEFAULT_MAX_QUEUE, 1);
    this.maxSessions = sanitizeOption(options.maxSessions, DEFAULT_MAX_SESSIONS, 1);
    this.onErrorCb = options.onError;
    this.enabled = options.enabled ?? true;

    if (this.enabled && this.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
      // Don't keep the Node process alive just for the flush timer. Guarded
      // so this works unmodified in browsers, where timers are numbers and
      // have no unref().
      const maybeUnref = (this.timer as unknown as { unref?: () => void }).unref;
      if (typeof maybeUnref === 'function') {
        maybeUnref.call(this.timer);
      }
    }

    // Browser page lifecycle: the interval flusher alone would lose whatever
    // is queued when the tab closes or backgrounds. Flush eagerly (with
    // fetch keepalive) on hide instead. No-op in Node, where `document` and
    // a global addEventListener don't both exist.
    if (
      this.enabled &&
      typeof document !== 'undefined' &&
      typeof globalThis.addEventListener === 'function'
    ) {
      this.onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') this.lifecycleFlush();
      };
      this.onPageHide = () => this.lifecycleFlush();
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      globalThis.addEventListener('pagehide', this.onPageHide);
    }
  }

  reportError(err: unknown): void {
    if (!this.onErrorCb) return;
    const error = err instanceof Error ? err : new Error(String(err));
    try {
      this.onErrorCb(error);
    } catch {
      // The host's error handler misbehaved. We must never throw into the
      // host app, so swallow it here.
    }
  }

  enqueue(event: IngestEvent): void {
    if (!this.enabled) return;
    this.queue.push(event);
    if (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.reportError(new Error('context-trace: queue overflow, dropped oldest event'));
    }
  }

  startSession(options: StartSessionOptions): SessionHandle {
    const id = options.id ?? generateId('ses');
    if (this.enabled) {
      const session: Session = {
        id,
        name: options.name,
        agent: options.agent,
        metadata: options.metadata,
        startedAt: new Date().toISOString(),
      };
      this.enqueue({ type: 'session.started', data: session });
    }
    return this.getOrCreateSessionHandle(id);
  }

  session(id: string): SessionHandle {
    return this.getOrCreateSessionHandle(id);
  }

  private getOrCreateSessionHandle(id: string): SessionHandleImpl {
    if (!this.enabled) {
      // Nothing downstream reads from the cache when disabled (every
      // capture call is already a no-op via enqueue()), so skip caching
      // entirely rather than growing a Map that will never be consulted.
      return new SessionHandleImpl(this, id);
    }

    const existing = this.sessions.get(id);
    if (existing) {
      // Re-insert to mark as most-recently-used: Map iterates in insertion
      // order, so a delete+set moves this id to the "newest" end.
      this.sessions.delete(id);
      this.sessions.set(id, existing);
      return existing;
    }

    const handle = new SessionHandleImpl(this, id);
    this.sessions.set(id, handle);
    if (this.sessions.size > this.maxSessions) {
      const oldestId = this.sessions.keys().next().value;
      if (oldestId !== undefined) {
        this.sessions.delete(oldestId);
      }
    }
    return handle;
  }

  async flush(): Promise<void> {
    if (!this.enabled) return;
    if (this.flushing) return this.flushing;
    const run = this.drain().finally(() => {
      this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatch);
      await this.sendWithRetry(batch);
    }
  }

  private async sendWithRetry(batch: IngestEvent[]): Promise<void> {
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      try {
        await this.send(batch);
        return;
      } catch (err) {
        if (attempt >= MAX_SEND_ATTEMPTS || !isRetryable(err)) {
          this.reportError(err);
          return;
        }
        await sleep(backoffDelay(attempt));
      }
    }
  }

  private async send(batch: IngestEvent[], keepalive = false): Promise<void> {
    const fetchImpl = globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('context-trace: global fetch is not available in this environment');
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const body: IngestRequest = { events: batch };
    const res = await fetchImpl(`${this.endpoint}/v1/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(keepalive ? { keepalive: true } : {}),
    });
    if (!res.ok) {
      throw new IngestHttpError(res.status);
    }
    await this.reportPartialRejections(res, batch);
  }

  /**
   * Page is hiding or unloading: drain the queue NOW, fire-and-forget, in
   * chunks small enough for the browser's 64KB keepalive body budget. An
   * event too large even alone falls back to a regular fetch — modern
   * browsers usually complete a fast same-session request after hide, and
   * best-effort beats certain loss.
   */
  private lifecycleFlush(): void {
    if (!this.enabled || this.queue.length === 0) return;
    const events = this.queue.splice(0, this.queue.length);
    let batch: IngestEvent[] = [];
    let size = 20; // '{"events":[' + ']}' envelope headroom
    for (const event of events) {
      const eventSize = JSON.stringify(event).length + 1;
      if (batch.length > 0 && (size + eventSize > KEEPALIVE_BODY_LIMIT || batch.length >= this.maxBatch)) {
        void this.sendLifecycleBatch(batch);
        batch = [];
        size = 20;
      }
      batch.push(event);
      size += eventSize;
    }
    if (batch.length > 0) void this.sendLifecycleBatch(batch);
  }

  private async sendLifecycleBatch(batch: IngestEvent[]): Promise<void> {
    try {
      await this.send(batch, true);
    } catch {
      try {
        await this.send(batch, false);
      } catch (err) {
        this.reportError(err);
      }
    }
  }

  /**
   * A 200 response can still partially reject the batch (malformed events
   * mixed with good ones): { accepted, rejected: [{ index, reason }] }.
   * Surface those drops via onError instead of silently discarding them.
   * Tolerates a non-JSON or unparsable body.
   */
  private async reportPartialRejections(res: Response, batch: IngestEvent[]): Promise<void> {
    let parsed: IngestResponse | undefined;
    try {
      parsed = (await res.json()) as IngestResponse;
    } catch {
      return;
    }
    const rejected = parsed?.rejected;
    if (!rejected || rejected.length === 0) return;
    const reasons = rejected
      .map(({ index, reason }) => {
        const event = batch[index];
        const label = event ? event.type : `#${index}`;
        return `${label}: ${reason}`;
      })
      .join('; ');
    this.reportError(
      new Error(`context-trace: server rejected ${rejected.length} event(s): ${reasons}`),
    );
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.onVisibilityChange && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
    if (this.onPageHide && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('pagehide', this.onPageHide);
      this.onPageHide = null;
    }
    await this.flush();
  }
}

class SessionHandleImpl implements SessionHandle {
  private segmentCounter = 0;

  constructor(
    private readonly client: ClientImpl,
    public readonly id: string,
  ) {}

  segment(options: SegmentOptions = {}): SegmentBuilder {
    const explicitIndex = options.index;
    const index = explicitIndex ?? this.segmentCounter;
    if (explicitIndex !== undefined) {
      if (explicitIndex >= this.segmentCounter) this.segmentCounter = explicitIndex + 1;
    } else {
      this.segmentCounter += 1;
    }
    const id = options.id ?? generateId('seg');
    const timestamp = options.timestamp ?? new Date().toISOString();
    return new SegmentBuilderImpl(
      this.client,
      this.id,
      id,
      index,
      options.kind ?? 'llm_call',
      timestamp,
      options.label,
      options.model,
      options.metadata,
    );
  }

  outcome(segmentId: string, outcome: SegmentOutcome): void {
    this.client.enqueue({
      type: 'segment.outcome',
      data: { sessionId: this.id, segmentId, outcome },
    });
  }

  end(endedAt?: string): void {
    this.client.enqueue({
      type: 'session.ended',
      data: { sessionId: this.id, endedAt: endedAt ?? new Date().toISOString() },
    });
  }
}

class SegmentBuilderImpl implements SegmentBuilder {
  private readonly sections: Section[] = [];
  private recorded = false;

  constructor(
    private readonly client: ClientImpl,
    private readonly sessionId: string,
    public readonly id: string,
    public readonly index: number,
    private readonly kind: SegmentKind,
    private readonly timestamp: string,
    private readonly label: string | undefined,
    private readonly model: string | undefined,
    private readonly metadata: Record<string, unknown> | undefined,
  ) {}

  section(input: SectionInput): SegmentBuilder {
    try {
      if (this.recorded) {
        this.client.reportError(
          new Error(`context-trace: section() called after record() on segment ${this.id}`),
        );
        return this;
      }
      const content = input.content;
      const contentHash = fnv1a64(content ?? '');
      const tokens = input.tokens ?? estimateTokens(content ?? '');
      this.sections.push({
        key: input.key,
        service: input.service,
        serviceKind: input.serviceKind,
        role: input.role,
        position: 0, // reassigned in call order at record() time
        content,
        contentHash,
        tokens,
        metadata: input.metadata,
      });
    } catch (err) {
      this.client.reportError(err);
    }
    return this;
  }

  record(): void {
    try {
      if (this.recorded) {
        this.client.reportError(
          new Error(`context-trace: record() called more than once on segment ${this.id}`),
        );
        return;
      }
      this.recorded = true;
      const sections = this.dedupeByKey(this.sections).map((section, position) => ({
        ...section,
        position,
      }));
      const segment: SegmentWithSections = {
        id: this.id,
        sessionId: this.sessionId,
        index: this.index,
        label: this.label,
        kind: this.kind,
        model: this.model,
        timestamp: this.timestamp,
        metadata: this.metadata,
        sections,
      };
      this.client.enqueue({ type: 'segment.recorded', data: segment });
    } catch (err) {
      this.client.reportError(err);
    }
  }

  outcome(outcome: SegmentOutcome): void {
    try {
      if (!this.recorded) {
        this.client.reportError(
          new Error(`context-trace: outcome() called before record() on segment ${this.id}`),
        );
        return;
      }
      this.client.enqueue({
        type: 'segment.outcome',
        data: { sessionId: this.sessionId, segmentId: this.id, outcome },
      });
    } catch (err) {
      this.client.reportError(err);
    }
  }

  /**
   * A duplicate `key` within one segment makes the server discard the
   * whole snapshot (sections are keyed per segment). Collapse duplicates
   * here instead: the last write for a key wins its content, but keeps the
   * ordinal slot of its first appearance so unrelated positions don't
   * shuffle around a duplicate that shows up later in the call order.
   */
  private dedupeByKey(sections: Section[]): Section[] {
    const slotByKey = new Map<string, number>();
    const result: Section[] = [];
    let duplicateCount = 0;
    for (const section of sections) {
      const existingSlot = slotByKey.get(section.key);
      if (existingSlot !== undefined) {
        result[existingSlot] = section;
        duplicateCount += 1;
      } else {
        slotByKey.set(section.key, result.length);
        result.push(section);
      }
    }
    if (duplicateCount > 0) {
      this.client.reportError(
        new Error(
          `context-trace: segment ${this.id} had ${duplicateCount} duplicate section key(s); last write wins`,
        ),
      );
    }
    return result;
  }
}
