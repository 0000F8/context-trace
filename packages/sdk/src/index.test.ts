import type { IngestEvent, IngestRequest } from '@context-trace/types';
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
});
