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

`ContextTraceClient(endpoint, api_key=None, flush_interval=2.0, max_batch=100, max_queue=5000, max_sessions=1000, request_timeout=10.0, on_error=None, enabled=True)`

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
- `session.segment(id=None, index=None, label=None, kind='llm_call', model=None, timestamp=None, metadata=None)`
  — starts building a segment (one full context snapshot). Returns a
  `SegmentBuilder`. Passing an explicit `index` wins over the session's
  internal auto-counter and advances it so later auto-assigned segments
  don't collide.
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
  reports a warning via `on_error` and does not enqueue anything.
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
  into your app. All failures surface only via `on_error`.
- **`enabled=False`**: turns the client into a complete no-op.

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
