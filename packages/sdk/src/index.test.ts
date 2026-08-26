import type { IngestEvent, IngestRequest } from '@context-trace/types';
import { estimateTokens, fnv1a64 } from '@context-trace/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './index.js';

function makeOkResponse(): Response {
  return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
}

function eventsFromCall(call: [string, RequestInit?]): IngestEvent[] {
  const init = call[1];
  const body = JSON.parse(String(init?.body)) as IngestRequest;
  return body.events;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('event batching', () => {
  it('emits session.started before segment.recorded, in a single flush', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 'support-chat', agent: 'triage-bot' });
    const seg = session.segment({ label: 'turn 1', kind: 'llm_call' });
    seg.section({ key: 'system', service: 'prompts', serviceKind: 'system', content: 'hi' });
    seg.record();

    await ct.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:4720/v1/ingest');
    const events = eventsFromCall(call);
    expect(events.map((e) => e.type)).toEqual(['session.started', 'segment.recorded']);
  });
});

describe('record() idempotency', () => {
  it('ignores a second record() call and reports via onError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, onError });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.record();
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.filter((e) => e.type === 'segment.recorded');
    expect(recorded).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

describe('positions from call order', () => {
  it('assigns section position by call order, even under interleaved async calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });

    seg.section({ key: 'first', service: 'a', serviceKind: 'other', content: '1' });
    await Promise.resolve();
    seg.section({ key: 'second', service: 'b', serviceKind: 'other', content: '2' });
    await Promise.resolve();
    seg.section({ key: 'third', service: 'c', serviceKind: 'other', content: '3' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recordedEvent = events.find((e) => e.type === 'segment.recorded');
    expect(recordedEvent?.type).toBe('segment.recorded');
    if (recordedEvent?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recordedEvent.data.sections.map((s) => [s.key, s.position])).toEqual([
      ['first', 0],
      ['second', 1],
      ['third', 2],
    ]);
  });
});

describe('duplicate section keys', () => {
  it('dedupes by key at record() time, last write wins, and warns via onError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, onError });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'mem:profile', service: 'memory', serviceKind: 'memory', content: 'v1' });
    seg.section({ key: 'other', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.section({ key: 'mem:profile', service: 'memory', serviceKind: 'memory', content: 'v2' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recordedEvent = events.find((e) => e.type === 'segment.recorded');
    if (recordedEvent?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recordedEvent.data.sections.map((s) => [s.key, s.content, s.position])).toEqual([
      ['mem:profile', 'v2', 0],
      ['other', 'x', 1],
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

describe('retry then drop', () => {
  it('retries on failure with backoff, then drops the batch and calls onError', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, onError });
    const session = ct.startSession({ name: 's' });
    session.end();

    const flushPromise = ct.flush();
    // Drain all pending backoff timers as the retries occur.
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    // The dropped batch must not be retried on a subsequent flush.
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(makeOkResponse());
    await ct.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('non-retryable HTTP errors', () => {
  it('drops immediately on a 4xx other than 408/429, without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, onError });
    const session = ct.startSession({ name: 's' });
    session.end();

    await ct.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('still retries a 429', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, onError });
    const session = ct.startSession({ name: 's' });
    session.end();

    const flushPromise = ct.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('partial rejection', () => {
  it('reports via onError when the server accepts 200 but rejects some events', async () => {
    const rejectResponse = new Response(
      JSON.stringify({ accepted: 1, rejected: [{ index: 1, reason: 'unknown sessionId' }] }),
      { status: 200 },
    );
    const fetchMock = vi.fn().mockResolvedValue(rejectResponse);
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, onError });
    const session = ct.startSession({ name: 's' }); // index 0: session.started
    const seg = session.segment({ kind: 'llm_call' }); // index 1: segment.recorded
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.record();

    await ct.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('unknown sessionId');
  });

  it('tolerates a non-JSON 200 response without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, onError });
    ct.startSession({ name: 's' });

    await expect(ct.flush()).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('enabled: false', () => {
  it('no-ops everything and never calls fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', enabled: false });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.record();
    session.end();

    await ct.flush();
    await ct.shutdown();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches nothing: repeated session() calls for the same id never share a counter', () => {
    // If a handle were being cached, this second segment() would come back
    // with index 1 (continuing the shared counter) instead of 0.
    const ct = createClient({ endpoint: 'http://localhost:4720', enabled: false });
    const first = ct.session('sid').segment();
    const second = ct.session('sid').segment();
    expect(first.index).toBe(0);
    expect(second.index).toBe(0);
  });
});

describe('flush', () => {
  it('drains the whole queue, batching by maxBatch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, maxBatch: 2 });
    const session = ct.startSession({ name: 's' }); // 1 event
    for (let i = 0; i < 5; i++) {
      const seg = session.segment({ kind: 'llm_call' });
      seg.section({ key: `k${i}`, service: 'svc', serviceKind: 'other', content: 'x' });
      seg.record();
    } // 5 more events => 6 total, batches of 2 => 3 requests

    await ct.flush();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const totalEvents = fetchMock.mock.calls.reduce(
      (sum, call) => sum + eventsFromCall(call as unknown as [string, RequestInit?]).length,
      0,
    );
    expect(totalEvents).toBe(6);
  });
});

describe('bounded queue', () => {
  it('drops the oldest event on overflow and reports via onError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      maxQueue: 3,
      onError,
    });
    const session = ct.startSession({ name: 's' }); // event 1: session.started
    for (let i = 0; i < 4; i++) {
      const seg = session.segment({ kind: 'llm_call' });
      seg.section({ key: `k${i}`, service: 'svc', serviceKind: 'other', content: 'x' });
      seg.record();
    } // events 2..5, over the maxQueue=3 bound repeatedly

    expect(onError).toHaveBeenCalled();

    await ct.flush();
    const events = fetchMock.mock.calls.flatMap((call) =>
      eventsFromCall(call as unknown as [string, RequestInit?]),
    );
    expect(events).toHaveLength(3);
    // The oldest events (session.started, then earliest segments) were dropped;
    // the most recently recorded segments survive.
    const recorded = events.filter((e) => e.type === 'segment.recorded');
    expect(recorded).toHaveLength(3);
    if (recorded[0]?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded[0].data.sections[0]?.key).toBe('k1');
  });
});

describe('ct.session() re-bind', () => {
  it('does not emit session.started', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const session = ct.session('existing-session-id');
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    expect(events.map((e) => e.type)).toEqual(['segment.recorded']);
    expect(events[0]?.type).toBe('segment.recorded');
    if (events[0]?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(events[0].data.sessionId).toBe('existing-session-id');
  });

  it('caches the handle per session id, so repeated calls share one segment auto-counter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });

    // Simulates a stateless hook adapter re-binding on every invocation
    // instead of holding a SessionHandle in memory across calls.
    const seg1 = ct.session('shared-session').segment({ kind: 'llm_call' });
    seg1.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg1.record();

    const seg2 = ct.session('shared-session').segment({ kind: 'llm_call' });
    seg2.section({ key: 'b', service: 'svc', serviceKind: 'other', content: 'y' });
    seg2.record();

    await ct.flush();

    const events = fetchMock.mock.calls.flatMap((call) =>
      eventsFromCall(call as unknown as [string, RequestInit?]),
    );
    const recorded = events.filter((e) => e.type === 'segment.recorded');
    expect(recorded).toHaveLength(2);
    if (recorded[0]?.type !== 'segment.recorded' || recorded[1]?.type !== 'segment.recorded') {
      throw new Error('unreachable');
    }
    expect(recorded[0].data.index).toBe(0);
    expect(recorded[1].data.index).toBe(1);
  });
});

describe('session handle cache (bounded by maxSessions, LRU eviction)', () => {
  it('evicts the least-recently-used session id past maxSessions, keeping a recently-used counter intact', () => {
    // segment() assigns its index synchronously before anything is queued
    // or sent, so this test needs no fetch stub or flush() call.
    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, maxSessions: 2 });

    ct.session('s1').segment(); // cache (oldest -> newest): [s1]
    const s2First = ct.session('s2').segment(); // cache: [s1, s2]
    expect(s2First.index).toBe(0);

    // Inserting s3 pushes the cache past maxSessions: 2, evicting the
    // least-recently-used id. Neither s1 nor s2 was re-accessed since being
    // cached, so insertion order is LRU order and s1 (oldest) is evicted.
    ct.session('s3').segment(); // cache: [s2, s3]

    // s2 is still cached: its handle (and segment auto-counter) survives.
    const s2Second = ct.session('s2').segment();
    expect(s2Second.index).toBe(1);

    // s1 was evicted: re-binding mints a fresh handle whose counter starts
    // over at 0 (it would be 1, matching s2's pattern, had it survived).
    const s1Second = ct.session('s1').segment();
    expect(s1Second.index).toBe(0);
  });
});

describe('segment outcome', () => {
  it('emits segment.outcome after record(), with the right shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.record();
    seg.outcome({ latencyMs: 842, responseText: 'hi there', model: 'claude-sonnet-5' });

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const outcomeEvent = events.find((e) => e.type === 'segment.outcome');
    expect(outcomeEvent?.type).toBe('segment.outcome');
    if (outcomeEvent?.type !== 'segment.outcome') throw new Error('unreachable');
    expect(outcomeEvent.data.sessionId).toBe(session.id);
    expect(outcomeEvent.data.segmentId).toBe(seg.id);
    expect(outcomeEvent.data.outcome).toEqual({
      latencyMs: 842,
      responseText: 'hi there',
      model: 'claude-sonnet-5',
    });
  });

  it('warns via onError and does not emit when called before record()', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, onError });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.outcome({ latencyMs: 100 });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.record();
    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    expect(events.find((e) => e.type === 'segment.outcome')).toBeUndefined();
  });

  it('session.outcome(segmentId, o) emits for stateless correlation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    ct.session('existing-session-id').outcome('some-segment-id', { error: 'timeout' });

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    expect(events).toHaveLength(1);
    const outcomeEvent = events[0];
    expect(outcomeEvent?.type).toBe('segment.outcome');
    if (outcomeEvent?.type !== 'segment.outcome') throw new Error('unreachable');
    expect(outcomeEvent.data).toEqual({
      sessionId: 'existing-session-id',
      segmentId: 'some-segment-id',
      outcome: { error: 'timeout' },
    });
  });
});

describe('option validation', () => {
  it('falls back to the default maxBatch instead of looping forever on maxBatch: 0', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0, maxBatch: 0 });
    const session = ct.startSession({ name: 's' });
    for (let i = 0; i < 3; i++) {
      const seg = session.segment({ kind: 'llm_call' });
      seg.section({ key: `k${i}`, service: 'svc', serviceKind: 'other', content: 'x' });
      seg.record();
    }

    await expect(ct.flush()).resolves.toBeUndefined();

    // Falls back to the default batch size (100), so all 4 events go out
    // in a single request rather than an infinite loop of empty splices.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    expect(events).toHaveLength(4);
  });
});

describe('content modes', () => {
  it('full mode ships content unchanged (regression)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'hello world' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    const section = recorded.data.sections[0];
    expect(section?.content).toBe('hello world');
    expect(section?.contentHash).toBe(fnv1a64('hello world'));
    expect(section?.tokens).toBe(estimateTokens('hello world'));
  });

  it('hash-only mode omits content but preserves contentHash matching full-mode hash, and preserves tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      contentMode: 'hash-only',
    });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'hello world', tokens: 7 });
    seg.record();

    await ct.flush();

    const rawBody = String(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit?])[1]?.body,
    );
    expect(rawBody).not.toContain('hello world');

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    const section = recorded.data.sections[0];
    expect(section?.content).toBeUndefined();
    expect(section?.contentHash).toBe(fnv1a64('hello world'));
    expect(section?.tokens).toBe(7);
  });

  it('per-segment contentMode override wins over the client default (client full, segment hash-only)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call', contentMode: 'hash-only' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'secret' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sections[0]?.content).toBeUndefined();
    expect(recorded.data.sections[0]?.contentHash).toBe(fnv1a64('secret'));
  });

  it('per-segment contentMode override wins over the client default (client hash-only, segment full)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      contentMode: 'hash-only',
    });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call', contentMode: 'full' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'visible' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sections[0]?.content).toBe('visible');
  });
});

describe('redact', () => {
  it('rewrites content before hashing, so contentHash reflects the redacted content (order: redact -> hash -> strip)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      redact: (s) => ({ ...s, content: s.content?.replace('SECRET', '[REDACTED]') }),
    });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'my SECRET value' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    const section = recorded.data.sections[0];
    expect(section?.content).toBe('my [REDACTED] value');
    expect(section?.contentHash).toBe(fnv1a64('my [REDACTED] value'));
    expect(section?.contentHash).not.toBe(fnv1a64('my SECRET value'));
  });

  it('returning null drops the section and keeps remaining positions contiguous from 0', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      redact: (s) => (s.key === 'drop-me' ? null : s),
    });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'first', service: 'svc', serviceKind: 'other', content: 'a' });
    seg.section({ key: 'drop-me', service: 'svc', serviceKind: 'other', content: 'b' });
    seg.section({ key: 'third', service: 'svc', serviceKind: 'other', content: 'c' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sections.map((s) => [s.key, s.position])).toEqual([
      ['first', 0],
      ['third', 1],
    ]);
  });

  it('fails closed: a throwing redact drops the section and reports via onError, with no content on the wire', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      onError,
      redact: (s) => {
        if (s.key === 'boom') throw new Error('redactor exploded');
        return s;
      },
    });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'ok', service: 'svc', serviceKind: 'other', content: 'fine' });
    seg.section({ key: 'boom', service: 'svc', serviceKind: 'other', content: 'top secret payload' });
    seg.record();

    await ct.flush();

    const rawBody = String(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit?])[1]?.body,
    );
    expect(rawBody).not.toContain('top secret payload');

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sections.map((s) => s.key)).toEqual(['ok']);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain('redactor exploded');
  });

  it('per-segment redact override wins over the client default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      redact: () => {
        throw new Error('client-level redact should never run for this segment');
      },
    });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({
      kind: 'llm_call',
      redact: (s) => ({ ...s, content: 'overridden' }),
    });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'original' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sections[0]?.content).toBe('overridden');
  });

  it('a segment without a redact override (client default undefined) leaves content untouched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'plain' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sections[0]?.content).toBe('plain');
  });

  it('replaces rather than merges: a returned section omitting content drops it, never falling back to the original', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      // Deliberately returns a new object with no `content` field at all,
      // simulating a redactor that strips fields by omission rather than
      // by spreading the original and overriding just `content`.
      redact: (s) => ({ key: s.key, service: s.service, serviceKind: s.serviceKind }),
    });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({
      key: 'a',
      service: 'svc',
      serviceKind: 'other',
      content: 'sk-live-DEADBEEF-super-secret',
    });
    seg.record();

    await ct.flush();

    const rawBody = String(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit?])[1]?.body,
    );
    expect(rawBody).not.toContain('sk-live-DEADBEEF-super-secret');

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sections[0]?.content).toBeUndefined();
  });
});

describe('content mode validation (fail closed)', () => {
  it('throws on an unrecognized client-level contentMode instead of silently using full', () => {
    expect(() =>
      createClient({
        endpoint: 'http://localhost:4720',
        flushIntervalMs: 0,
        // @ts-expect-error deliberately invalid at the type level too
        contentMode: 'redacted',
      }),
    ).toThrow(/invalid contentMode/i);
  });

  it('throws on an unrecognized per-segment contentMode override instead of silently downgrading to full', () => {
    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      contentMode: 'hash-only',
    });
    const session = ct.startSession({ name: 's' });
    expect(() =>
      session.segment({
        kind: 'llm_call',
        // @ts-expect-error deliberately invalid at the type level too
        contentMode: 'hush-only', // plausible typo of 'hash-only'
      }),
    ).toThrow(/invalid contentMode/i);
  });

  it('accepts the "hash_only" (underscore) spelling as an alias at the client level', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      // @ts-expect-error 'hash_only' isn't in the TS union, but must still work at runtime
      contentMode: 'hash_only',
    });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'secret' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sections[0]?.content).toBeUndefined();
  });

  it('accepts the "hash_only" (underscore) spelling as a per-segment override alias', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 's' });
    // @ts-expect-error 'hash_only' isn't in the TS union, but must still work at runtime
    const seg = session.segment({ kind: 'llm_call', contentMode: 'hash_only' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'secret' });
    seg.record();

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const recorded = events.find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sections[0]?.content).toBeUndefined();
  });

  it('regression: valid contentMode values ("full" and "hash-only") never throw, at either level', () => {
    expect(() => createClient({ endpoint: 'http://localhost:4720', contentMode: 'full' })).not.toThrow();
    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      contentMode: 'hash-only',
    });
    const session = ct.startSession({ name: 's' });
    expect(() => session.segment({ contentMode: 'full' })).not.toThrow();
    expect(() => session.segment({ contentMode: 'hash-only' })).not.toThrow();
    expect(() => createClient({ endpoint: 'http://localhost:4720' })).not.toThrow(); // omitted entirely
  });
});

describe('hash-only outcome (responseText)', () => {
  it('hash-only mode omits responseText but keeps latencyMs/model/scores/error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      contentMode: 'hash-only',
    });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.record();
    seg.outcome({
      responseText: 'sensitive model output',
      latencyMs: 842,
      model: 'claude-sonnet-5',
      scores: { helpfulness: 0.9 },
      error: 'timeout',
    });

    await ct.flush();

    const rawBody = String(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit?])[1]?.body,
    );
    expect(rawBody).not.toContain('sensitive model output');

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const outcomeEvent = events.find((e) => e.type === 'segment.outcome');
    if (outcomeEvent?.type !== 'segment.outcome') throw new Error('unreachable');
    expect(outcomeEvent.data.outcome.responseText).toBeUndefined();
    expect(outcomeEvent.data.outcome.latencyMs).toBe(842);
    expect(outcomeEvent.data.outcome.model).toBe('claude-sonnet-5');
    expect(outcomeEvent.data.outcome.scores).toEqual({ helpfulness: 0.9 });
    expect(outcomeEvent.data.outcome.error).toBe('timeout');
  });

  it('full mode still sends responseText (regression)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.record();
    seg.outcome({ responseText: 'visible model output' });

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const outcomeEvent = events.find((e) => e.type === 'segment.outcome');
    if (outcomeEvent?.type !== 'segment.outcome') throw new Error('unreachable');
    expect(outcomeEvent.data.outcome.responseText).toBe('visible model output');
  });

  it('per-segment hash-only override applies to that segment\'s outcome (client default full)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call', contentMode: 'hash-only' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.record();
    seg.outcome({ responseText: 'should be withheld', latencyMs: 10 });

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const outcomeEvent = events.find((e) => e.type === 'segment.outcome');
    if (outcomeEvent?.type !== 'segment.outcome') throw new Error('unreachable');
    expect(outcomeEvent.data.outcome.responseText).toBeUndefined();
    expect(outcomeEvent.data.outcome.latencyMs).toBe(10);
  });

  it('per-segment full override applies to that segment\'s outcome (client default hash-only)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      contentMode: 'hash-only',
    });
    const session = ct.startSession({ name: 's' });
    const seg = session.segment({ kind: 'llm_call', contentMode: 'full' });
    seg.section({ key: 'a', service: 'svc', serviceKind: 'other', content: 'x' });
    seg.record();
    seg.outcome({ responseText: 'should ship' });

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const outcomeEvent = events.find((e) => e.type === 'segment.outcome');
    if (outcomeEvent?.type !== 'segment.outcome') throw new Error('unreachable');
    expect(outcomeEvent.data.outcome.responseText).toBe('should ship');
  });

  it('session.outcome(segmentId, o) strips responseText per the client-level contentMode (no segment context available)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const ct = createClient({
      endpoint: 'http://localhost:4720',
      flushIntervalMs: 0,
      contentMode: 'hash-only',
    });
    ct.session('existing-session-id').outcome('some-segment-id', {
      responseText: 'stateless correlation output',
      error: 'boom',
    });

    await ct.flush();

    const events = eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?]);
    const outcomeEvent = events[0];
    if (outcomeEvent?.type !== 'segment.outcome') throw new Error('unreachable');
    expect(outcomeEvent.data.outcome.responseText).toBeUndefined();
    expect(outcomeEvent.data.outcome.error).toBe('boom');
  });
});

describe('browser page lifecycle', () => {
  function stubBrowserEnv(visibility: 'visible' | 'hidden' = 'hidden') {
    const docListeners = new Map<string, () => void>();
    const winListeners = new Map<string, () => void>();
    const doc = {
      visibilityState: visibility,
      addEventListener: (t: string, h: () => void) => docListeners.set(t, h),
      removeEventListener: (t: string) => docListeners.delete(t),
    };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('addEventListener', (t: string, h: () => void) => winListeners.set(t, h));
    vi.stubGlobal('removeEventListener', (t: string) => winListeners.delete(t));
    return { doc, docListeners, winListeners };
  }

  async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  }

  it('flushes with keepalive on pagehide and removes listeners on shutdown', async () => {
    const { docListeners, winListeners } = stubBrowserEnv();
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const ct = createClient({ endpoint: 'http://x', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 'browser' });
    const seg = session.segment({});
    seg.section({ key: 'a', service: 's', serviceKind: 'other', content: 'hello' });
    seg.record();

    winListeners.get('pagehide')!();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit & { keepalive?: boolean };
    expect(init.keepalive).toBe(true);
    expect(eventsFromCall(fetchMock.mock.calls[0] as unknown as [string, RequestInit?])).toHaveLength(2);

    // queue drained: a later flush sends nothing more
    await ct.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await ct.shutdown();
    expect(docListeners.size).toBe(0);
    expect(winListeners.size).toBe(0);
  });

  it('flushes on visibilitychange only when the document is hidden', async () => {
    const { doc, docListeners } = stubBrowserEnv('visible');
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const ct = createClient({ endpoint: 'http://x', flushIntervalMs: 0 });
    ct.startSession({ name: 'vis' });

    docListeners.get('visibilitychange')!();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    doc.visibilityState = 'hidden';
    docListeners.get('visibilitychange')!();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await ct.shutdown();
  });

  it('chunks lifecycle flushes under the 64KB keepalive body budget', async () => {
    const { winListeners } = stubBrowserEnv();
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const ct = createClient({ endpoint: 'http://x', flushIntervalMs: 0 });
    const session = ct.startSession({ name: 'big' });
    for (let i = 0; i < 2; i++) {
      const seg = session.segment({});
      seg.section({ key: 'k' + i, service: 's', serviceKind: 'other', content: 'x'.repeat(40_000) });
      seg.record();
    }

    winListeners.get('pagehide')!();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit & { keepalive?: boolean };
      expect(init.keepalive).toBe(true);
      expect(String(init.body).length).toBeLessThanOrEqual(57_344);
    }
  });

  it('falls back to a plain request when the keepalive send fails', async () => {
    const { winListeners } = stubBrowserEnv();
    const errors: string[] = [];
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('keepalive body too large'))
      .mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    const ct = createClient({ endpoint: 'http://x', flushIntervalMs: 0, onError: (e) => errors.push(e.message) });
    const session = ct.startSession({ name: 'fallback' });
    const seg = session.segment({});
    seg.section({ key: 'a', service: 's', serviceKind: 'other', content: 'y' });
    seg.record();

    winListeners.get('pagehide')!();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = fetchMock.mock.calls[1]![1] as RequestInit & { keepalive?: boolean };
    expect(second.keepalive).toBeUndefined();
    expect(errors).toHaveLength(0);
  });
});
