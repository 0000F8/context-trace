# @context-trace/sdk

Zero-runtime-dependency TypeScript client for capturing LLM context
assemblies (sessions, segments, sections) and shipping them to a
[context-trace](../../README.md) server. Batched, non-blocking, and
failure-tolerant: every capture call is a synchronous enqueue, and it never
throws into your host app.

## Install

Inside this monorepo, the package is already linked via npm workspaces:

```json
{ "dependencies": { "@context-trace/sdk": "0.1.0" } }
```

If you're consuming it from an npm registry instead:

```sh
npm install @context-trace/sdk
```

## Quick start

```ts
import { createClient } from '@context-trace/sdk';

const ct = createClient({ endpoint: 'http://localhost:4720' });

const session = ct.startSession({ name: 'support-chat', agent: 'triage-bot' });
const seg = session.segment({ label: 'turn 1', kind: 'llm_call', model: 'claude-sonnet-5' });
seg.section({ key: 'system', service: 'prompts', serviceKind: 'system', role: 'system', content: '...' });
seg.section({ key: 'mem:profile', service: 'memory', serviceKind: 'memory', content: '...', tokens: 512 });
seg.record();          // snapshot enqueued; positions auto-assigned in call order
session.end();
await ct.flush();      // drain queue (also on timer); ct.shutdown() = flush + stop timer
```

## Options

`createClient(options)`:

| Option            | Type                     | Default   | Description |
|-------------------|--------------------------|-----------|-------------|
| `endpoint`        | `string`                 | required  | Base URL of the context-trace server, e.g. `'http://localhost:4720'`. |
| `apiKey`          | `string?`                | -         | Sent as `x-api-key` header when set. Matches server `CT_API_KEY`. |
| `flushIntervalMs` | `number?`                | `2000`    | Background flush interval. Set `0` to disable the timer (manual `flush()` only). The timer is `unref()`'d where supported so it never keeps a Node process alive. |
| `maxBatch`        | `number?`                | `100`     | Max events per `POST /v1/ingest` request. |
| `maxQueue`        | `number?`                | `5000`    | Max events buffered. On overflow, the **oldest** event is dropped and `onError` is called. |
| `onError`         | `(err: Error) => void`   | -         | Called for dropped events, exhausted retries, and idempotency warnings (e.g. double `record()`). Never throws — an error thrown from your handler is swallowed. |
| `enabled`         | `boolean?`               | `true`    | When `false`, every capture call is a complete no-op: nothing is queued, no timer starts, `fetch` is never called. |

## API

- `ct.startSession(options)` — starts a new session and immediately enqueues `session.started`. Returns a `SessionHandle`.
  - `options: { id?, name, agent?, metadata? }` — `id` is generated (ULID-like) if omitted.
- `ct.session(id)` — re-binds to an already-started (or not-yet-seen) session by id **without** emitting `session.started`. For stateless hook contexts that only have a session id to correlate against (e.g. a webhook handler that doesn't hold a `SessionHandle` in memory across invocations). The client caches one handle per session id, so every `startSession`/`session` call for the same id **within one client instance** returns the same underlying handle and shares its segment auto-counter — calling `ct.session(id)` repeatedly and then `segment()` with no explicit index still produces correctly incrementing indexes (0, 1, 2, ...) instead of every call landing on index 0.
- `session.segment(options?)` — starts building a segment (one full context snapshot). Returns a `SegmentBuilder`.
  - `options: { id?, index?, label?, kind?, model?, timestamp?, metadata? }` — `kind` defaults to `'llm_call'`. `index` defaults to the session's internal 0-based auto-counter; passing an explicit `index` **wins** over the counter and advances it so later auto-assigned segments don't collide.
  - The auto-counter is per session **handle**, which is now cached per id within one client instance (see `ct.session(id)` above) — but it is *not* shared across processes. If your hooks run in more than one process (e.g. a worker pool) or you create more than one client, pass an explicit `index` yourself (e.g. the framework's own step/turn number) so segments from different processes don't collide.
- `segment.section(input)` — enqueues one contributing section. Chainable. Safe to call repeatedly from interleaved async callbacks.
  - `input: { key, service, serviceKind, role?, content?, tokens?, metadata? }` — `contentHash` is computed from `content ?? ''` immediately. `tokens` defaults to `estimateTokens(content ?? '')` when omitted.
  - Section `position` is **not** set here — it's assigned at `record()` time from call order (arrival order), so it's stable even under interleaved async calls.
- `segment.record()` — finalizes the segment (assigns positions, computes the snapshot) and enqueues `segment.recorded`. **Idempotent**: a second call on the same builder is a no-op that reports a warning via `onError` instead of throwing. If two `section()` calls used the same `key`, the last one wins (its content replaces the earlier one in the same ordinal slot) and a warning is reported via `onError` — the server rejects a segment snapshot outright if it contains a duplicate key, so the SDK resolves it client-side first.
- `session.end(endedAt?)` — enqueues `session.ended`.
- `ct.flush()` — `Promise<void>`. Drains the queue, sending batches of up to `maxBatch` events. Concurrent calls share one in-flight drain. Never rejects — network failures are retried and eventually dropped internally (see below).
- `ct.shutdown()` — `Promise<void>`. Stops the background timer, then flushes.

Only `flush()` and `shutdown()` return promises. Everything else (`startSession`, `session`, `segment`, `section`, `record`, `end`) is fully synchronous.

## Delivery semantics

- **Batching**: events are sent in arrival order, split into chunks of `maxBatch`.
- **Retry**: network errors, `408`, `429`, and `5xx` responses are retried with exponential backoff (200ms, 400ms — 3 attempts total), then dropped and reported via `onError`. Other `4xx` responses (e.g. `400`, `401`, `404`) are treated as permanent — they're reported via `onError` and the batch is dropped immediately, without burning retries on a request that can't succeed. A dropped batch is never retried again on a later `flush()`.
- **Partial rejection**: a `200` response can still partially reject a batch (`{ accepted, rejected: [{ index, reason }] }` — e.g. one malformed event mixed in with good ones). Those drops are never silent: the SDK reports one summarized `Error` via `onError` listing each rejected event's type and reason. A non-JSON or unparsable response body is tolerated (no `onError` call, since there's nothing meaningful to report).
- **Backpressure**: the queue is bounded by `maxQueue`. On overflow the oldest queued event is dropped (not the newest) and `onError` fires, so recent activity is preserved over stale activity.
- **Option validation**: `maxBatch` and `maxQueue` are floored to whole numbers and must be `>= 1`; `flushIntervalMs` must be `>= 0`. A `NaN`, non-finite, or out-of-range value (including `maxBatch: 0`, which would otherwise make `flush()` loop forever splicing zero-length batches) is ignored and the default is used instead.
- **Never throws**: capture calls never throw, and `flush()`/`shutdown()` never reject. All failures surface only via `onError`.
- **`enabled: false`**: turns the client into a complete no-op — useful for disabling tracing in tests or specific environments without changing call sites.

## Runtime

Node 18+ (needs global `fetch`) or any modern browser. No `node:*` imports in
any runtime code path — the package is safe to bundle for the browser.

## Framework hooks

The primary intended use is being driven from framework callback hooks
(LangChain-style `handleChainStart`/`handleLLMStart`/`handleLLMEnd`, or
equivalents in other agent frameworks), where a segment builder is opened in
one hook and closed in a later, possibly-interleaved one. Below is a
generic, framework-independent adapter shape — no dependency on LangChain
itself, just the shape of its callback handler interface.

Because `ct.session(id)` caches its handle per id, re-binding on every hook
invocation (rather than threading a `SessionHandle` through closures) is
safe **within one process**: plain `session.segment({ kind, model })` with
no explicit `index` still produces correctly incrementing indexes, since
the cached handle's auto-counter is shared across calls. That single-process
guarantee doesn't extend across a worker pool or multiple client instances,
though — the counter lives in that one client's memory. If your hooks can
run in more than one process, pass an explicit `index` yourself (e.g. the
framework's own step/turn number) instead of relying on the auto-counter.

```ts
import { createClient, type SegmentBuilder, type SessionHandle } from '@context-trace/sdk';

const ct = createClient({ endpoint: 'http://localhost:4720', onError: console.warn });

/**
 * Generic async callback-handler adapter, shaped like a LangChain
 * BaseCallbackHandler. Swap the method names/signatures for whatever your
 * framework's hook interface actually looks like — the mapping pattern
 * (chain start -> session, LLM start -> segment, LLM end -> record) is what
 * matters, not the exact types below.
 */
class ContextTraceCallbackHandler {
  private sessions = new Map<string, SessionHandle>();
  private segments = new Map<string, SegmentBuilder>();

  // Called once per top-level chain/agent run.
  async handleChainStart(run: { runId: string; name: string }): Promise<void> {
    const session = ct.startSession({ id: run.runId, name: run.name });
    this.sessions.set(run.runId, session);
  }

  // Called before each model call; may fire multiple times per chain run,
  // and concurrently across parallel branches.
  async handleLLMStart(run: {
    runId: string;
    parentRunId: string;
    model: string;
    prompts: Array<{ role: string; content: string }>;
  }): Promise<void> {
    // ct.session(id) is cached per id, so re-binding here even without the
    // local `this.sessions` lookup would still share one segment
    // auto-counter with handleChainStart's handle — safe within this
    // process. No explicit `index` needed here. If handleLLMStart could run
    // in a *different* process/worker than handleChainStart, pass an
    // explicit `index` (e.g. run.stepNumber) instead, since the
    // auto-counter doesn't cross process boundaries.
    const session = this.sessions.get(run.parentRunId) ?? ct.session(run.parentRunId);
    const segment = session.segment({ id: run.runId, kind: 'llm_call', model: run.model });

    for (const [i, message] of run.prompts.entries()) {
      segment.section({
        key: `history:${i}`,
        service: 'chat-history',
        serviceKind: 'history',
        role: message.role as 'system' | 'user' | 'assistant' | 'tool',
        content: message.content,
      });
    }

    this.segments.set(run.runId, segment);
  }

  // Called when the model call finishes. May race with other in-flight
  // handleLLMStart calls for sibling branches — that's fine, each segment
  // builder is independent.
  async handleLLMEnd(run: { runId: string; output: string }): Promise<void> {
    const segment = this.segments.get(run.runId);
    if (!segment) return;

    segment.section({
      key: 'output',
      service: 'model',
      serviceKind: 'other',
      role: 'assistant',
      content: run.output,
    });
    segment.record(); // idempotent — safe even if a retry calls this twice
    this.segments.delete(run.runId);
  }

  async handleChainEnd(run: { runId: string }): Promise<void> {
    this.sessions.get(run.runId)?.end();
    this.sessions.delete(run.runId);
  }
}
```

Because every capture call is synchronous and non-throwing, it's safe to
call directly from hot hook paths without `await` or try/catch — the SDK
handles batching, retries, and failure isolation on its own background
timer.

## Out of scope (v1)

No Python SDK, no OpenTelemetry/OTLP interop, no live streaming — see the
root README and spec for the full project scope.
