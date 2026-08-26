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
| `maxSessions`     | `number?`                | `1000`    | Max distinct session ids kept in the `startSession`/`session` handle cache (see `ct.session(id)` below). On overflow, the **least-recently-used** session id is evicted. |
| `onError`         | `(err: Error) => void`   | -         | Called for dropped events, exhausted retries, and idempotency warnings (e.g. double `record()`). Never throws — an error thrown from your handler is swallowed. |
| `enabled`         | `boolean?`               | `true`    | When `false`, every capture call is a complete no-op: nothing is queued, no timer starts, `fetch` is never called. |
| `contentMode`     | `'full' \| 'hash-only'`  | `'full'`  | See [Privacy modes](#privacy-modes) below. Overridable per segment via `session.segment({ contentMode })`. |
| `redact`          | `(section: SectionInput) => SectionInput \| null` | -   | See [Privacy modes](#privacy-modes) below. Overridable per segment via `session.segment({ redact })`. |

## API

- `ct.startSession(options)` — starts a new session and immediately enqueues `session.started`. Returns a `SessionHandle`.
  - `options: { id?, name, agent?, metadata? }` — `id` is generated (ULID-like) if omitted.
- `ct.session(id)` — re-binds to an already-started (or not-yet-seen) session by id **without** emitting `session.started`. For stateless hook contexts that only have a session id to correlate against (e.g. a webhook handler that doesn't hold a `SessionHandle` in memory across invocations). The client caches one handle per session id, so every `startSession`/`session` call for the same id **within one client instance** returns the same underlying handle and shares its segment auto-counter — calling `ct.session(id)` repeatedly and then `segment()` with no explicit index still produces correctly incrementing indexes (0, 1, 2, ...) instead of every call landing on index 0.
  - The cache is bounded by `maxSessions` (default 1000) with least-recently-used eviction, so a long-lived client that sees many distinct session ids over time doesn't grow unboundedly. An id is only ever evicted on overflow — never on `session.end()` — because a segment recorded after `end()` (e.g. a late/out-of-order hook) would otherwise land on a fresh handle and reset its index back to 0. If you can have more than `maxSessions` **concurrently active** sessions (segments still being recorded), either raise `maxSessions` or pass an explicit `index` yourself so an evicted session's segments don't restart at 0 and collide with ones already sent.
  - When `enabled: false`, nothing is cached at all — `session(id)` always returns a fresh, uncached handle, since every downstream capture call is already a no-op.
- `session.segment(options?)` — starts building a segment (one full context snapshot). Returns a `SegmentBuilder`.
  - `options: { id?, index?, label?, kind?, model?, timestamp?, metadata? }` — `kind` defaults to `'llm_call'`. `index` defaults to the session's internal 0-based auto-counter; passing an explicit `index` **wins** over the counter and advances it so later auto-assigned segments don't collide.
  - The auto-counter is per session **handle**, which is now cached per id within one client instance (see `ct.session(id)` above) — but it is *not* shared across processes. If your hooks run in more than one process (e.g. a worker pool) or you create more than one client, pass an explicit `index` yourself (e.g. the framework's own step/turn number) so segments from different processes don't collide.
- `segment.section(input)` — enqueues one contributing section. Chainable. Safe to call repeatedly from interleaved async callbacks.
  - `input: { key, service, serviceKind, role?, content?, tokens?, metadata? }` — `contentHash` is computed from `content ?? ''` immediately. `tokens` defaults to `estimateTokens(content ?? '')` when omitted.
  - Section `position` is **not** set here — it's assigned at `record()` time from call order (arrival order), so it's stable even under interleaved async calls.
- `segment.record()` — finalizes the segment (assigns positions, computes the snapshot) and enqueues `segment.recorded`. **Idempotent**: a second call on the same builder is a no-op that reports a warning via `onError` instead of throwing. If two `section()` calls used the same `key`, the last one wins (its content replaces the earlier one in the same ordinal slot) and a warning is reported via `onError` — the server rejects a segment snapshot outright if it contains a duplicate key, so the SDK resolves it client-side first.
- `segment.outcome(o)` — attaches a model-call result (`{ responseText?, latencyMs?, model?, scores?, error? }`) to this segment and enqueues `segment.outcome`. Valid **only after** `record()`: the server correlates by segment id, which doesn't exist until the segment snapshot has been enqueued. Calling it before `record()` reports a warning via `onError` and enqueues nothing — it does not queue and retry later. When this segment's effective `contentMode` is `'hash-only'`, `responseText` is omitted from the wire payload the same way section content is — see [Privacy modes](#privacy-modes).
- `session.end(endedAt?)` — enqueues `session.ended`.
- `session.outcome(segmentId, o)` — attaches a model-call result to a segment **by id**, for stateless hook contexts that only have a session id and segment id to correlate against (e.g. an `handleLLMEnd`-style callback that didn't keep the originating `SegmentBuilder` in memory, or a hook that runs in a separate process/invocation from the one that recorded the segment). Enqueues the same `segment.outcome` event as `segment.outcome(o)` above — there is no ordering requirement against the matching `segment.recorded` beyond what the server enforces (rejected with `'unknown segment'` if the segment id doesn't exist yet when the event is applied). Same `responseText` withholding in `hash-only` mode, but note this by-id form has no segment builder in hand and so always uses the **client-level** `contentMode`, never a per-segment override — see [Privacy modes](#privacy-modes).
- `ct.flush()` — `Promise<void>`. Drains the queue, sending batches of up to `maxBatch` events. Concurrent calls share one in-flight drain. Never rejects — network failures are retried and eventually dropped internally (see below).
- `ct.shutdown()` — `Promise<void>`. Stops the background timer, then flushes.

Only `flush()` and `shutdown()` return promises. Everything else (`startSession`, `session`, `segment`, `section`, `record`, `end`) is fully synchronous.

## Delivery semantics

- **Batching**: events are sent in arrival order, split into chunks of `maxBatch`.
- **Retry**: network errors, `408`, `429`, and `5xx` responses are retried with exponential backoff (200ms, 400ms — 3 attempts total), then dropped and reported via `onError`. Other `4xx` responses (e.g. `400`, `401`, `404`) are treated as permanent — they're reported via `onError` and the batch is dropped immediately, without burning retries on a request that can't succeed. A dropped batch is never retried again on a later `flush()`.
- **Partial rejection**: a `200` response can still partially reject a batch (`{ accepted, rejected: [{ index, reason }] }` — e.g. one malformed event mixed in with good ones). Those drops are never silent: the SDK reports one summarized `Error` via `onError` listing each rejected event's type and reason. A non-JSON or unparsable response body is tolerated (no `onError` call, since there's nothing meaningful to report).
- **Backpressure**: the queue is bounded by `maxQueue`. On overflow the oldest queued event is dropped (not the newest) and `onError` fires, so recent activity is preserved over stale activity.
- **Outcome correlation**: `segment.outcome(o)` / `session.outcome(segmentId, o)` both just enqueue a `segment.outcome` event — same batching, retry, and drop semantics as any other event. The server does the actual correlation (matching `segmentId` against a previously ingested `segment.recorded`) and rejects the event with `'unknown segment'` if it can't find one; that per-event rejection surfaces through the normal partial-rejection `onError` path above, not as a special case.
- **Option validation**: `maxBatch` and `maxQueue` are floored to whole numbers and must be `>= 1`; `flushIntervalMs` must be `>= 0`. A `NaN`, non-finite, or out-of-range value (including `maxBatch: 0`, which would otherwise make `flush()` loop forever splicing zero-length batches) is ignored and the default is used instead.
- **Never throws**: capture calls never throw, and `flush()`/`shutdown()` never reject. All failures surface only via `onError`.
- **Browser lifecycle flush**: in browsers, hiding or unloading the page triggers an immediate keepalive flush of everything queued (see "Using from a browser"). In Node this path is inert.
- **`enabled: false`**: turns the client into a complete no-op — useful for disabling tracing in tests or specific environments without changing call sites.

## Privacy modes

By default the SDK ships full section content to the server (`contentMode:
'full'`). If you'd rather run composition analytics — diffs, spans, churn,
thrash, dead-weight, over-window findings — **without** the underlying prompt
text ever leaving your process, set `contentMode: 'hash-only'` on the client,
per segment, or both.

```ts
const ct = createClient({
  endpoint: 'http://localhost:4720',
  contentMode: 'hash-only', // every section, on every segment, by default
});

// Opt one specific segment back into full content:
const seg = session.segment({ kind: 'llm_call', contentMode: 'full' });
```

| | `full` (default) | `hash-only` |
| --- | --- | --- |
| Section `content` | Sent | **Not sent** — omitted from the wire payload entirely |
| `contentHash` (fnv1a-64 of the real content) | Sent | Sent |
| `tokens` | Sent | Sent |
| Section `key`, `service`, `serviceKind`, `role` | Sent | Sent |
| Session/segment metadata (`label`, `kind`, `model`, timestamps) | Sent | Sent |
| `SegmentOutcome.latencyMs`, `.model`, `.scores`, `.error` | Sent | Sent |
| `SegmentOutcome.responseText` | Sent | **Not sent** — same treatment as section content |

**What `hash-only` guarantees:**

- `section.content` is omitted from the wire payload entirely (not sent as
  an empty string — the field is absent). It never leaves this process.
- `contentHash` (an `fnv1a64` hash) and `tokens` are still computed and
  shipped, from the real content, so the server can compile diffs, spans,
  token budgets, and every analytics finding exactly as it would in full
  mode — see spec §D and the server's hash-only compile test.
- `SegmentOutcome.responseText` is model output — exactly as sensitive as
  section content — and is withheld the same way: omitted from the wire
  payload for every `segment.outcome()`/`session.outcome(segmentId, ...)`
  call made while the effective `contentMode` for that segment is
  `'hash-only'`. `latencyMs`, `model`, and `scores` are metadata, not
  content, and always ship in both modes.

**What it does NOT guarantee:**

- Section **`key` and `service` still ship** in both modes. They're
  identifiers meant to be stable and human-legible (e.g. `'mem:user-profile'`,
  `'retrieval'`), not payload — don't put secrets, PII, or literal user
  content in them.
- `metadata` on a section or segment is **not** covered by `contentMode` and
  ships as-is in both modes. If it can carry sensitive data in your
  integration, redact it yourself (see below) or don't populate it.
- `SegmentOutcome.error` is **not** withheld in either mode. Provider error
  messages can embed secrets (an API key echoed back, a raw request body in
  an SDK exception) — scrub it yourself before calling `outcome({ error })`
  if that's a concern; the SDK has no way to know what a given provider's
  error strings contain.
- `session.outcome(segmentId, o)` — the stateless, by-id correlation form —
  has no segment builder in hand, so it can't see a per-segment `contentMode`
  override made on the original `segment(...)` call. It always strips
  `responseText` according to the **client-level** `contentMode`, never a
  per-segment override. If you rely on a per-segment override for a segment
  you also close out via `session.outcome(segmentId, ...)`, hold the
  `SegmentBuilder` and call `segment.outcome(...)` on it directly instead.

**The `redact` callback** runs on every section, in both modes, *before*
hashing and *before* content-mode stripping — so a rewrite changes
`contentHash` too (the hash always reflects what the redactor decided the
"real" content is, not the original). Order is: `redact` → hash → strip.

```ts
const ct = createClient({
  endpoint: 'http://localhost:4720',
  redact(section) {
    if (section.service !== 'user-input') return section;
    return { ...section, content: scrubPII(section.content ?? '') };
  },
});
```

- Return the section unchanged (or a rewritten copy) to keep it.
- Return `null` to drop the section entirely — it never reaches the queue,
  and later sections in the same segment keep contiguous `position`s
  starting from 0 (no gap where the dropped section would have been).
- **Fails closed.** If `redact` throws, the SDK reports the error via
  `onError` and drops the section — it never falls back to shipping the
  original, unredacted content just because your scrubbing logic broke. If
  you need best-effort redaction that ships *something* rather than
  dropping, catch your own exceptions inside the callback and return a safe
  fallback (e.g. `{ ...section, content: '[redaction failed]' }`) instead of
  letting them propagate.

Both `contentMode` and `redact` are overridable per segment via
`session.segment({ contentMode, redact })` — an explicit value there
replaces the client-level default for that one segment snapshot (it doesn't
merge with it), in either direction: a `hash-only` client can opt one
sensitive segment into `full`, and a `full` client can opt one segment into
`hash-only`.

## Runtime

Node 18+ (needs global `fetch`) or any modern browser. No `node:*` imports in
any runtime code path — the package is safe to bundle for the browser.

## Using from a browser

The SDK works unmodified in browser apps (ESM import via your bundler; a few
KB, zero dependencies). Two things differ from Node:

**Endpoint.** Two patterns:

- *Same-origin proxy (recommended):* serve your app behind a proxy that
  forwards `/api/` to the trace server (the bundled nginx config does this)
  and pass a relative endpoint — `createClient({ endpoint: '/api' })`. No
  CORS involved.
- *Cross-origin direct:* point at the server host. `POST /v1/ingest` is the
  only CORS-enabled route on the server (`CT_CORS_ORIGIN`, default `*` —
  scope it to your app's origin in production). Read endpoints deliberately
  send no CORS headers.

**Page lifecycle.** The client listens for `visibilitychange` (to `hidden`)
and `pagehide` and eagerly flushes the queue with `fetch(..., { keepalive:
true })`, so events queued moments before a tab closes or backgrounds are
still delivered. Keepalive bodies are chunked under the browser's 64KB
budget; an event too large for that budget alone falls back to a regular
request (best effort). `shutdown()` removes the listeners. One residual
window: a batch already in flight on the *regular* (non-keepalive) flusher
when the page is torn down can still be cancelled by the browser.

**API keys.** Don't embed `CT_API_KEY` in browser code — anything shipped to
the client is public, and the key authorizes writes. Leave ingest open on a
network you control, or front the server with your own authenticated proxy.

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

// handleLLMStart -> handleLLMEnd is exactly the shape `seg.outcome(o)` is for:
// the same handler instance holds the SegmentBuilder from start to end, so
// measuring latency is just a start-time map keyed by runId (see below).

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
  private startedAt = new Map<string, number>();

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
    this.startedAt.set(run.runId, Date.now());
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

    // outcome() is only valid after record() (see API above), so it always
    // comes second — measured latency plus the response text right there.
    const startedAt = this.startedAt.get(run.runId);
    segment.outcome({
      responseText: run.output,
      latencyMs: startedAt !== undefined ? Date.now() - startedAt : undefined,
    });

    this.segments.delete(run.runId);
    this.startedAt.delete(run.runId);
  }

  // Called when the model call errors out instead of completing normally.
  async handleLLMError(run: { runId: string; error: Error }): Promise<void> {
    const segment = this.segments.get(run.runId);
    if (!segment) return;

    segment.record(); // still record whatever context was assembled
    segment.outcome({ error: run.error.message });

    this.segments.delete(run.runId);
    this.startedAt.delete(run.runId);
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
