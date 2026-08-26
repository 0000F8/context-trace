# context-trace (Python)

Zero-runtime-dependency Python client for capturing LLM context assemblies
(sessions, segments, sections) and shipping them to a
[context-trace](../README.md) server. Batched, non-blocking, and
failure-tolerant: every capture call is a synchronous enqueue, and it never
raises into your host app. This is a Python port of the
[`@context-trace/sdk`](../packages/sdk) TypeScript client — same event
model, same delivery semantics, same wire format.

## Install

```sh
pip install -e sdk-python
```

(Not published to PyPI yet — install from this checkout.)

Requires Python >= 3.8. No runtime dependencies; transport uses
`urllib.request` from the standard library.

## Quick start

```python
from context_trace import ContextTraceClient

ct = ContextTraceClient(endpoint="http://localhost:4720")

session = ct.start_session(name="support-chat", agent="triage-bot")
seg = session.segment(label="turn 1", kind="llm_call", model="claude-sonnet-5")
seg.section(key="system", service="prompts", service_kind="system",
            role="system", content="...")
seg.section(key="mem:profile", service="memory", service_kind="memory",
            content="...", tokens=512)
seg.record()          # snapshot enqueued; positions auto-assigned in call order
seg.outcome(response_text="...", latency_ms=842, model="claude-sonnet-5",
            scores={"helpfulness": 0.9})  # valid only after record()
session.end()

ct.flush()             # drain queue now (also happens on a background timer)
ct.shutdown()          # stop the background timer, then flush
```

## Options

`ContextTraceClient(endpoint, api_key=None, flush_interval=2.0, max_batch=100, max_queue=5000, max_sessions=1000, request_timeout=10.0, on_error=None, enabled=True, content_mode='full', redact=None)`

| Option            | Type                        | Default   | Description |
|-------------------|-----------------------------|-----------|--------------|
| `endpoint`        | `str`                       | required  | Base URL of the context-trace server, e.g. `'http://localhost:4720'`. |
| `api_key`         | `Optional[str]`             | `None`    | Sent as `x-api-key` header when set. Matches server `CT_API_KEY`. |
| `flush_interval`  | `float`                     | `2.0`     | Background flush interval **in seconds**. Set `0` to disable the timer (manual `flush()` only). |
| `max_batch`       | `int`                       | `100`     | Max events per `POST /v1/ingest` request. |
| `max_queue`       | `int`                       | `5000`    | Max events buffered. On overflow, the **oldest** event is dropped and `on_error` is called. |
| `max_sessions`    | `int`                       | `1000`    | Max distinct session ids kept in the `start_session`/`session` handle cache. On overflow, the **least-recently-used** session id is evicted. |
| `request_timeout` | `float`                     | `10.0`    | Per-request socket timeout **in seconds** passed to `urlopen`. Bounds how long a single hung HTTP call can block — lower it if you want `shutdown()` to give up on a stuck endpoint sooner (see "Exit semantics" below). |
| `on_error`        | `Optional[Callable[[Exception], None]]` | `None` | Called for dropped events, exhausted retries, and idempotency warnings. Exceptions raised from it are swallowed — it is never allowed to propagate back into the SDK. |
| `enabled`         | `bool`                      | `True`    | When `False`, every capture call is a complete no-op: nothing is queued, no background thread starts, no atexit hook is registered, no HTTP request is ever made. |
| `content_mode`    | `'full' \| 'hash_only'`     | `'full'`  | See [Privacy modes](#privacy-modes) below. Overridable per segment via `session.segment(content_mode=...)`. |
| `redact`          | `Optional[Callable[[dict], Optional[dict]]]` | `None` | See [Privacy modes](#privacy-modes) below. Overridable per segment via `session.segment(redact=...)`. |

An invalid numeric option (`NaN`, non-finite, or below the minimum — e.g.
`max_batch=0`) is ignored and the default is used instead, exactly like the
TS SDK.

## API

- `ct.start_session(name, id=None, agent=None, metadata=None)` — starts a new
  session and immediately enqueues `session.started`. Returns a
  `SessionHandle`. `id` is generated (ULID-like) if omitted.
- `ct.session(id)` — re-binds to an already-started (or not-yet-seen) session
  by id **without** emitting `session.started`. For stateless hook contexts
  that only have a session id to correlate against. The client caches one
  handle per session id (bounded by `max_sessions`, LRU-evicted), so every
  `start_session`/`session` call for the same id returns the same handle and
  shares its segment auto-counter.
- `session.segment(id=None, index=None, label=None, kind='llm_call', model=None, timestamp=None, metadata=None, content_mode=None, redact=None)`
  — starts building a segment (one full context snapshot). Returns a
  `SegmentBuilder`. Passing an explicit `index` wins over the session's
  internal auto-counter and advances it so later auto-assigned segments
  don't collide. `content_mode`/`redact` default to the client's settings
  when omitted (`None`); an explicit value overrides the client default for
  this segment only — see [Privacy modes](#privacy-modes).
- `segment.section(key, service, service_kind='other', role=None, content=None, tokens=None, metadata=None)`
  — enqueues one contributing section. Chainable (`section(...).section(...)`).
  `content_hash` is computed from `content or ''` immediately; `tokens`
  defaults to `estimate_tokens(content or '')`. Section `position` is **not**
  set here — it's assigned at `record()` time from call (arrival) order.
- `segment.record()` — finalizes the segment (assigns positions, computes
  the snapshot) and enqueues `segment.recorded`. **Idempotent**: a second
  call on the same builder is a no-op that reports a warning via `on_error`
  instead of raising. If two `section()` calls used the same `key`, the last
  one wins (its content replaces the earlier one in the same ordinal slot)
  and a warning is reported via `on_error`.
- `segment.outcome(response_text=None, latency_ms=None, model=None, scores=None, error=None)`
  — attaches a model-call result to an already-recorded segment (e.g. from a
  later hook). **Valid only after `record()`**: calling it before `record()`
  reports a warning via `on_error` and does not enqueue anything. When this
  segment's effective `content_mode` is `'hash_only'`, `response_text` is
  omitted from the wire payload the same way section content is — see
  [Privacy modes](#privacy-modes).
- `session.end(ended_at=None)` — enqueues `session.ended`.
- `ct.flush()` — drains the queue synchronously, sending batches of up to
  `max_batch` events. Never raises — network failures are retried and
  eventually dropped internally (see below).
- `ct.shutdown(join_timeout=5.0, flush_timeout=5.0)` — stops the background
  flusher thread, then performs one bounded, best-effort final flush. See
  "Exit semantics" below for exactly what "bounded" means and why it can't
  be instantaneous against a stuck endpoint.

Every method is synchronous — there's no `asyncio` involved anywhere in this
client.

## Exit semantics

Read this before relying on delivery at process shutdown:

- **Automatic safety net**: when `enabled=True`, the client registers a
  best-effort `atexit` hook at construction time that performs one bounded
  flush attempt if the process exits normally without you ever calling
  `shutdown()`/`flush()`. It is **not a delivery guarantee** — `atexit`
  hooks don't run on `os._exit()`, a `SIGKILL`, or a hard crash, and the
  flush itself is time-boxed (see below), so a sufficiently stuck endpoint
  can still cause queued events to be dropped at exit.
- **Without any shutdown/atexit at all** (e.g. `os._exit()`), whatever is
  sitting in the queue — up to `flush_interval` seconds' worth of activity,
  or up to `max_queue` events — is lost.
- **`shutdown()` is bounded, not instant.** It signals an internal stop
  flag, which makes any in-progress retry ladder (in the background thread
  or in `shutdown()`'s own final flush) abort after its *current* attempt
  instead of sleeping through the remaining backoff steps and burning all 3
  attempts. But a request already in flight when `shutdown()` is called
  can't be interrupted mid-socket-read — only waited out. The bound is
  therefore roughly `join_timeout` (default 5s, waiting for the background
  thread) plus **one request per queued batch** in the final flush — a
  backed-up queue against a slow endpoint drains one bounded request at a
  time, so worst case scales with `ceil(queued events / max_batch) ×
  request_timeout`, not a flat "one more request". Lower `request_timeout`
  (default 10s), call `flush()` periodically to keep the queue shallow, or
  accept the loss and skip `shutdown()` if you need a hard exit bound.
- **If the background thread doesn't stop within `join_timeout`** (almost
  always because a request is still hung past that point), `shutdown()`
  does **not** null out its internal thread reference — it reports this via
  `on_error` and proceeds to its own best-effort final flush anyway, rather
  than pretending the thread already exited.
- **"Never raises into the host app" is about capture calls**, specifically
  `start_session`, `session`, `segment`, `section`, `record`, `outcome`,
  `end`, plus `flush()`/`shutdown()` themselves. It is not a delivery
  guarantee for the events those calls describe — events can still be
  dropped on queue overflow, exhausted retries, or a process that exits
  before a flush completes.

## Delivery semantics

Identical to the TypeScript SDK:

- **Batching**: events are sent in arrival order, split into chunks of
  `max_batch`.
- **Retry**: network errors, `408`, `429`, and `5xx` responses are retried
  with exponential backoff (200ms, 400ms — 3 attempts total), then dropped
  and reported via `on_error`. Other `4xx` responses (`400`, `401`, `404`,
  ...) are treated as permanent — reported via `on_error` and dropped
  immediately, without burning retries on a request that can't succeed.
- **Partial rejection**: a `200` response can still partially reject a batch
  (`{ accepted, rejected: [{ index, reason }] }`). Those drops are surfaced
  as one summarized `Exception` via `on_error` listing each rejected event's
  type and reason. A non-JSON or unparsable response body is tolerated
  silently.
- **Redirects are never followed.** A `3xx` response from `endpoint` is
  treated as an immediate, non-retryable failure, not silently completed
  against the `Location` target. urllib's default opener would otherwise
  transparently follow redirects *and forward the `x-api-key` header to
  wherever they point*, even a different host — a trace sink has no
  legitimate reason to redirect, so this SDK refuses rather than risk
  leaking the key to an unintended (or malicious) endpoint.
- **`endpoint` must be `http://` or `https://`.** Validated once at
  construction time (raises `ValueError` immediately, unlike the
  never-raises guarantee for capture calls) — `file://`, `ftp://`, and
  scheme-less values are rejected before any request is ever attempted.
- **Backpressure**: the queue is bounded by `max_queue`. On overflow the
  oldest queued event is dropped (not the newest) and `on_error` fires.
- **Never raises**: capture calls, `flush()`, and `shutdown()` never raise
  into your app. All failures surface only via `on_error`. **Two
  deliberate exceptions**: an invalid `endpoint` scheme (see above) and an
  unrecognized `content_mode` passed to `ContextTraceClient(...)` or
  `session.segment(...)` both raise `ValueError` synchronously — see
  [Privacy modes](#privacy-modes) for why `content_mode` fails closed
  rather than falling back to a default.
- **`enabled=False`**: turns the client into a complete no-op.

## Privacy modes

By default the SDK ships full section content to the server
(`content_mode='full'`). If you'd rather run composition analytics — diffs,
spans, churn, thrash, dead-weight, over-window findings — **without** the
underlying prompt text ever leaving your process, set `content_mode`
to `'hash_only'` on the client, per segment, or both. Semantics are
identical to the TS SDK's `contentMode`.

```python
ct = ContextTraceClient(
    endpoint="http://localhost:4720",
    content_mode="hash_only",  # every section, on every segment, by default
)

# Opt one specific segment back into full content:
seg = session.segment(content_mode="full")
```

| | `full` (default) | `hash_only` |
| --- | --- | --- |
| Section `content` | Sent | **Not sent** — omitted from the wire payload entirely |
| `contentHash` (fnv1a-64 of the real content) | Sent | Sent |
| `tokens` | Sent | Sent |
| Section `key`, `service`, `serviceKind`, `role` | Sent | Sent |
| Session/segment metadata (`label`, `kind`, `model`, timestamps) | Sent | Sent |
| `outcome(latency_ms=..., model=..., scores=..., error=...)` | Sent | Sent |
| `outcome(response_text=...)` | Sent | **Not sent** — same treatment as section content |

**What `hash_only` guarantees:**

- The section's `content` key is omitted from the wire payload entirely (not
  sent as an empty string — the field is absent). It never leaves this
  process.
- `contentHash` (an `fnv1a64` hash) and `tokens` are still computed and
  shipped, from the real content, so the server can compile diffs, spans,
  token budgets, and every analytics finding exactly as it would in full
  mode.
- `response_text` passed to `segment.outcome(...)` is model output —
  exactly as sensitive as section content — and is withheld the same way:
  omitted from the wire payload whenever the effective `content_mode` for
  that segment is `'hash_only'`. `latency_ms`, `model`, and `scores` are
  metadata, not content, and always ship in both modes.

**What it does NOT guarantee:**

- Section **`key` and `service` still ship** in both modes. They're
  identifiers meant to be stable and human-legible (e.g. `'mem:user-profile'`,
  `'retrieval'`), not payload — don't put secrets, PII, or literal user
  content in them.
- `metadata` on a section or segment is **not** covered by `content_mode` and
  ships as-is in both modes. If it can carry sensitive data in your
  integration, redact it yourself (see below) or don't populate it.
- `error` passed to `segment.outcome(...)` is **not** withheld in either
  mode. Provider error messages can embed secrets (an API key echoed back,
  a raw request body in an SDK exception) — scrub it yourself before
  calling `outcome(error=...)` if that's a concern; the SDK has no way to
  know what a given provider's error strings contain.

**The `redact` callback** runs on every section, in both modes, *before*
hashing and *before* content-mode stripping — so a rewrite changes
`contentHash` too (the hash always reflects what the redactor decided the
"real" content is, not the original). Order is: `redact` → hash → strip. It
receives (and should return) a `dict` with the same field names as
`section()`'s keyword arguments: `key`, `service`, `service_kind`, `role`,
`content`, `tokens`, `metadata`.

```python
def redact(section):
    if section["service"] != "user-input":
        return section
    section = dict(section)
    section["content"] = scrub_pii(section["content"] or "")
    return section

ct = ContextTraceClient(endpoint="http://localhost:4720", redact=redact)
```

- Return the section dict unchanged (or a rewritten copy) to keep it.
- **The returned dict REPLACES the section — it does not merge with the
  original.** A key you omit from your return value is **absent**, not
  silently inherited from the pre-redaction section. Concretely:
  `redact = lambda s: {"key": s["key"], "service": s["service"], "service_kind": s["service_kind"]}`
  drops `content` (and `role`, `tokens`, `metadata`) entirely — it does
  **not** ship the original `content` just because the return value didn't
  mention it. If you mean to keep most fields and change one, copy the
  input and override only what you're changing:
  `redact = lambda s: {**s, "content": scrub(s["content"] or "")}`.
- Return `None` to drop the section entirely — it never reaches the queue,
  and later sections in the same segment keep contiguous `position`s
  starting from 0 (no gap where the dropped section would have been).
- **Fails closed.** If `redact` raises, the SDK reports the exception via
  `on_error` and drops the section — it never falls back to shipping the
  original, unredacted content just because your scrubbing logic broke. If
  you need best-effort redaction that ships *something* rather than
  dropping, catch your own exceptions inside the callback and return a safe
  fallback (e.g. `{**section, "content": "[redaction failed]"}`) instead of
  letting them propagate.

Both `content_mode` and `redact` are overridable per segment via
`session.segment(content_mode=..., redact=...)` — an explicit value there
replaces the client-level default entirely for that one segment snapshot
(it doesn't merge with it), in either direction: a `hash_only` client can
opt one sensitive segment into `'full'`, and a `'full'` client can opt one
segment into `'hash_only'`.

**`content_mode` fails closed on an unrecognized value.** Unlike other SDK
options (which sanitize an out-of-range number to a safe default),
`content_mode` is a privacy control: an unrecognized string — a typo, a bad
value from config — **raises `ValueError`** immediately (from
`ContextTraceClient(...)` for the client-level default, or from
`session.segment(...)` for a per-segment override) instead of silently
falling back to `'full'`. Silently widening a privacy setting on a typo
would be worse than a loud, synchronous failure. This is a deliberate
exception to the constructor/`segment()`'s otherwise non-raising contract
(the endpoint-scheme check is the other one — see below). Both
`'hash_only'` and `'hash-only'` (the TS SDK's spelling) are accepted as
equivalent — only genuinely unrecognized values raise.

## Hashing and token estimation

`context_trace.fnv1a64` and `context_trace.estimate_tokens` are
bit-identical ports of the TS SDK's implementations: they hash/measure
**UTF-16 code units** (matching JavaScript's `String.charCodeAt`/`.length`
semantics) rather than Python code points, so astral-plane characters
(surrogate pairs in JS) hash and estimate identically on both sides. This
matters because `contentHash` values are compared cross-language when the
same underlying content flows through both the TS and Python SDKs into the
same server.

## Framework hooks: a LangChain-style sketch

The primary intended use is being driven from framework callback hooks,
where a segment builder is opened in one hook and closed in a later,
possibly-interleaved one — the same pattern as the TS SDK's [framework
hooks example](../packages/sdk/README.md#framework-hooks). Below is a
generic sketch shaped like a LangChain Python callback handler (no
dependency on `langchain` itself — just the shape of its interface):

```python
from typing import Any, Dict, List, Optional
from context_trace import ContextTraceClient, SegmentBuilder, SessionHandle

ct = ContextTraceClient(endpoint="http://localhost:4720", on_error=print)


class ContextTraceCallbackHandler:
    """Sketch of a LangChain BaseCallbackHandler-shaped adapter."""

    def __init__(self):
        self._sessions: Dict[str, SessionHandle] = {}
        self._segments: Dict[str, SegmentBuilder] = {}

    # Called once per top-level chain/agent run.
    def on_chain_start(self, run_id: str, name: str, **kwargs: Any) -> None:
        self._sessions[run_id] = ct.start_session(id=run_id, name=name)

    # Called before each model call; may fire multiple times per chain run.
    def on_llm_start(
        self,
        run_id: str,
        parent_run_id: str,
        model: str,
        prompts: List[Dict[str, str]],
        **kwargs: Any,
    ) -> None:
        # ct.session(id) is cached per id, so re-binding here even without
        # the local `_sessions` lookup would still share one segment
        # auto-counter with on_chain_start's handle. If your hooks can run
        # in a different process/worker, pass an explicit `index` instead
        # (e.g. the framework's own step number) — the auto-counter doesn't
        # cross process boundaries.
        session = self._sessions.get(parent_run_id) or ct.session(parent_run_id)
        segment = session.segment(id=run_id, kind="llm_call", model=model)

        for i, message in enumerate(prompts):
            segment.section(
                key=f"history:{i}",
                service="chat-history",
                service_kind="history",
                role=message.get("role"),
                content=message.get("content"),
            )
        self._segments[run_id] = segment

    # Called when the model call finishes.
    def on_llm_end(self, run_id: str, output: str, latency_ms: Optional[float] = None,
                    **kwargs: Any) -> None:
        segment = self._segments.pop(run_id, None)
        if segment is None:
            return
        segment.section(key="output", service="model", service_kind="other",
                         role="assistant", content=output)
        segment.record()  # idempotent — safe even if a retry calls this twice
        segment.outcome(response_text=output, latency_ms=latency_ms)

    def on_chain_end(self, run_id: str, **kwargs: Any) -> None:
        session = self._sessions.pop(run_id, None)
        if session is not None:
            session.end()
```

Because every capture call is synchronous and non-raising, it's safe to
call directly from hot hook paths without wrapping in `try`/`except` — the
SDK handles batching, retries, and failure isolation on its own background
thread.

## Runtime

Standard library only. No `pip` dependencies at runtime. Uses
`urllib.request` for transport and a daemon `threading.Thread` for the
background flusher — the thread never keeps your process alive on its own
(it's marked `daemon=True`, matching the TS SDK's `unref()`'d timer).

## Testing this package

Tests use **only the standard library** (`unittest` + `http.server`) — no
`pytest` dependency:

```sh
python3 -m unittest discover -s sdk-python/tests -v
```

## Out of scope

No OpenTelemetry/OTLP interop, no live streaming, no browser support (this
is a server-side/Node-adjacent client) — see the root README and spec for
the full project scope.
