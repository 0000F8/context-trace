import { createClient } from '@context-trace/sdk';
import type { IngestEvent, IngestRequest } from '@context-trace/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextTraceCallbackHandler } from './index.js';

function makeOkResponse(): Response {
  return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
}

function eventsFromCall(call: [string, RequestInit?]): IngestEvent[] {
  const init = call[1];
  const body = JSON.parse(String(init?.body)) as IngestRequest;
  return body.events;
}

function allEvents(fetchMock: ReturnType<typeof vi.fn>): IngestEvent[] {
  return fetchMock.mock.calls.flatMap((call) => eventsFromCall(call as unknown as [string, RequestInit?]));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ContextTraceCallbackHandler', () => {
  it('chainStart -> llmStart -> llmEnd produces session.started, segment.recorded, segment.outcome, session.ended', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const handler = new ContextTraceCallbackHandler({ client, sessionName: 'my-run', agent: 'triage-bot' });

    handler.handleChainStart({ id: ['MyChain'] }, {}, 'run-1');
    handler.handleLLMStart({ id: ['ChatModel'] }, ['hello world'], 'run-2', 'run-1');
    vi.advanceTimersByTime(50);
    handler.handleLLMEnd({ generations: [[{ text: 'hi there' }]] }, 'run-2', 'run-1');
    handler.handleChainEnd({}, 'run-1');

    await client.flush();

    const events = allEvents(fetchMock);
    expect(events.map((e) => e.type)).toEqual([
      'session.started',
      'segment.recorded',
      'segment.outcome',
      'session.ended',
    ]);

    const started = events[0];
    if (started?.type !== 'session.started') throw new Error('unreachable');
    expect(started.data.id).toBe('run-1');
    expect(started.data.name).toBe('my-run');
    expect(started.data.agent).toBe('triage-bot');

    const recorded = events[1];
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.id).toBe('run-2');
    expect(recorded.data.sessionId).toBe('run-1');
    expect(recorded.data.sections.map((s) => [s.key, s.position, s.service, s.serviceKind])).toEqual([
      ['prompt:0', 0, 'prompts', 'system'],
    ]);

    const outcome = events[2];
    if (outcome?.type !== 'segment.outcome') throw new Error('unreachable');
    expect(outcome.data.sessionId).toBe('run-1');
    expect(outcome.data.segmentId).toBe('run-2');
    expect(outcome.data.outcome.responseText).toBe('hi there');
    expect(outcome.data.outcome.latencyMs).toBeGreaterThan(0);
  });

  it('handleChatModelStart captures one section per message, keyed by index and normalized role', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const handler = new ContextTraceCallbackHandler({ client });

    handler.handleChainStart({ id: ['MyChain'] }, {}, 'run-1');
    handler.handleChatModelStart(
      { id: ['ChatOpenAI'] },
      [
        [
          { content: 'be nice', _getType: () => 'system' },
          { content: 'hi', _getType: () => 'human' },
        ],
      ],
      'run-2',
      'run-1',
    );
    handler.handleLLMEnd({ generations: [[{ message: { content: 'hello!' } }]] }, 'run-2', 'run-1');

    await client.flush();

    const recorded = allEvents(fetchMock).find((e) => e.type === 'segment.recorded');
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sections.map((s) => [s.key, s.position, s.role])).toEqual([
      ['msg:0:system', 0, 'system'],
      ['msg:1:user', 1, 'user'],
    ]);

    const outcome = allEvents(fetchMock).find((e) => e.type === 'segment.outcome');
    if (outcome?.type !== 'segment.outcome') throw new Error('unreachable');
    expect(outcome.data.outcome.responseText).toBe('hello!');
  });

  it('handleLLMError records the segment and attaches an error outcome instead of a normal one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const handler = new ContextTraceCallbackHandler({ client });

    handler.handleChainStart({ id: ['MyChain'] }, {}, 'run-1');
    handler.handleLLMStart({ id: ['ChatModel'] }, ['hello'], 'run-2', 'run-1');
    handler.handleLLMError(new Error('rate limited'), 'run-2', 'run-1');

    await client.flush();

    const events = allEvents(fetchMock);
    expect(events.map((e) => e.type)).toEqual(['session.started', 'segment.recorded', 'segment.outcome']);
    const outcome = events[2];
    if (outcome?.type !== 'segment.outcome') throw new Error('unreachable');
    expect(outcome.data.outcome.error).toBe('rate limited');
    expect(outcome.data.outcome.responseText).toBeUndefined();
  });

  it('an LLM call with no surrounding chain run still correlates via client.session(runId)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const handler = new ContextTraceCallbackHandler({ client });

    // No handleChainStart at all: a bare model.invoke() call.
    handler.handleLLMStart({ id: ['ChatModel'] }, ['solo'], 'run-solo');
    handler.handleLLMEnd({ generations: [[{ text: 'ok' }]] }, 'run-solo');

    await client.flush();

    const events = allEvents(fetchMock);
    // No session.started (no root chain run was ever seen), but the segment
    // still ships, bound to a session keyed by the LLM run's own id.
    expect(events.map((e) => e.type)).toEqual(['segment.recorded', 'segment.outcome']);
    const recorded = events[0];
    if (recorded?.type !== 'segment.recorded') throw new Error('unreachable');
    expect(recorded.data.sessionId).toBe('run-solo');
  });

  it('handleChainError ends the session and cleans up, just like handleChainEnd', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const handler = new ContextTraceCallbackHandler({ client });

    handler.handleChainStart({ id: ['MyChain'] }, {}, 'run-1');
    handler.handleLLMStart({ id: ['ChatModel'] }, ['hello'], 'run-2', 'run-1');
    handler.handleLLMEnd({ generations: [[{ text: 'ok' }]] }, 'run-2', 'run-1');
    handler.handleChainError(new Error('boom'), 'run-1');

    await client.flush();

    const events = allEvents(fetchMock);
    expect(events.map((e) => e.type)).toEqual([
      'session.started',
      'segment.recorded',
      'segment.outcome',
      'session.ended',
    ]);
    expect(internals(handler).runToSession.size).toBe(0);
  });

  it('does not leak map entries: runToSession/segments/startedAt are empty after llmEnd/llmError/chainEnd/chainError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({ endpoint: 'http://localhost:4720', flushIntervalMs: 0 });
    const handler = new ContextTraceCallbackHandler({ client });

    // Root run, with a nested chain run, several LLM calls (one erroring),
    // all under the same session — exercises every cleanup path at once.
    handler.handleChainStart({ id: ['RootChain'] }, {}, 'root');
    handler.handleChainStart({ id: ['NestedChain'] }, {}, 'nested', 'root');

    for (let i = 0; i < 5; i++) {
      const runId = `llm-${i}`;
      handler.handleLLMStart({ id: ['ChatModel'] }, [`prompt ${i}`], runId, 'nested');
      if (i === 2) {
        handler.handleLLMError(new Error('transient'), runId, 'nested');
      } else {
        handler.handleLLMEnd({ generations: [[{ text: `reply ${i}` }]] }, runId, 'nested');
      }
      // After each LLM run finishes, its own bookkeeping must be gone —
      // this is what regresses to unbounded growth if finishLlmRun() only
      // clears `segments`/`startedAt` and forgets `runToSession`.
      expect(internals(handler).runToSession.has(runId)).toBe(false);
      expect(internals(handler).segments.has(runId)).toBe(false);
      expect(internals(handler).startedAt.has(runId)).toBe(false);
    }

    // Only the root and nested chain runs should still be tracked.
    expect(internals(handler).runToSession.size).toBe(2);

    handler.handleChainEnd({}, 'nested', 'root');
    expect(internals(handler).runToSession.has('nested')).toBe(false);
    expect(internals(handler).runToSession.size).toBe(1); // root still open

    handler.handleChainEnd({}, 'root');
    expect(internals(handler).runToSession.size).toBe(0);
    expect(internals(handler).segments.size).toBe(0);
    expect(internals(handler).startedAt.size).toBe(0);

    await client.flush();
  });
});

/**
 * Peeks at the handler's private bookkeeping maps for leak assertions.
 * `private` is compile-time only in TS, so this cast is a legitimate way to
 * verify internal cleanup without exposing a test-only public API.
 */
function internals(handler: ContextTraceCallbackHandler): {
  runToSession: Map<string, unknown>;
  segments: Map<string, unknown>;
  startedAt: Map<string, unknown>;
} {
  return handler as unknown as {
    runToSession: Map<string, unknown>;
    segments: Map<string, unknown>;
    startedAt: Map<string, unknown>;
  };
}
