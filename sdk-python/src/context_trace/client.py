"""
Python port of the context-trace TS SDK's client core (see
``packages/sdk/src/client.ts``): a bounded event queue, a background
batching flusher on a daemon thread, and the session/segment builder object
graph. Zero runtime dependencies — transport is ``urllib.request``.

Every public capture call (``start_session``, ``session``, ``segment``,
``section``, ``record``, ``outcome``, ``end``) is synchronous and never
raises into the host app; failures are reported only via the ``on_error``
callback passed to the constructor.
"""

import atexit
import json
import math
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from .utils import estimate_tokens, fnv1a64, generate_id

_DEFAULT_FLUSH_INTERVAL_SECONDS = 2.0
_DEFAULT_MAX_BATCH = 100
_DEFAULT_MAX_QUEUE = 5000
_DEFAULT_MAX_SESSIONS = 1000
_MAX_SEND_ATTEMPTS = 3
_BACKOFF_BASE_SECONDS = 0.2  # 200ms, 400ms for attempts 1 and 2 (3 attempts total)
_DEFAULT_REQUEST_TIMEOUT_SECONDS = 10.0
_DEFAULT_SHUTDOWN_JOIN_TIMEOUT_SECONDS = 5.0
_DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_SECONDS = 5.0


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    millis = now.microsecond // 1000
    return now.strftime("%Y-%m-%dT%H:%M:%S") + f".{millis:03d}Z"


def _sanitize_float_option(value: Optional[float], fallback: float, minimum: float) -> float:
    """
    NaN, non-finite, or below `minimum` falls back to the default instead of
    being clamped, mirroring the TS SDK's `sanitizeOption` — a value that
    low almost certainly indicates a misconfiguration.
    """
    try:
        if value is None:
            return fallback
        fv = float(value)
        if not math.isfinite(fv) or fv < minimum:
            return fallback
        return fv
    except (TypeError, ValueError):
        return fallback


def _sanitize_int_option(value: Optional[int], fallback: int, minimum: int) -> int:
    fv = _sanitize_float_option(value, fallback, minimum)
    return int(math.floor(fv))


def _normalize_content_mode(value: str, context: str) -> str:
    """
    Validate a `content_mode`. Unlike `_sanitize_*_option` above, an
    unrecognized value here does NOT fall back to a default — it raises.
    `content_mode` is a privacy control: silently normalizing a typo to
    "full" would ship content the caller believed was being withheld, with
    no signal that anything went wrong. Fail closed instead: refuse to
    construct a client, or open a segment, with an unrecognized mode.
    `None` is a distinct case (means "not overridden, use the
    fallback/default") and is handled by the caller before this function is
    reached — it is never passed in as `value` here.

    Accepts `"hash-only"` (hyphen) as an alias for `"hash_only"` in addition
    to raising on genuinely unknown values, since the TS SDK's canonical
    spelling is `'hash-only'` and this is the one cross-language footgun
    worth closing outright rather than just documenting.
    """
    if value == "full":
        return "full"
    if value in ("hash_only", "hash-only"):
        return "hash_only"
    raise ValueError(
        f"context-trace: invalid content_mode {value!r} ({context}); "
        "expected 'full' or 'hash_only'"
    )


class IngestHttpError(Exception):
    """Raised by _send() for a non-2xx HTTP response; carries the status for retry classification."""

    def __init__(self, status: int):
        super().__init__(f"context-trace: ingest request failed with status {status}")
        self.status = status


def _is_retryable(err: BaseException) -> bool:
    """408 (timeout) and 429 (rate limit) are retryable; 5xx and network
    errors are retryable. Everything else — other 4xx, and 3xx (redirects,
    which we refuse to follow; see _NoRedirectHandler) — is treated as a
    permanent failure that won't succeed by hitting the same endpoint
    again."""
    if isinstance(err, IngestHttpError):
        if err.status in (408, 429):
            return True
        return err.status >= 500
    return True


def _backoff_delay(attempt: int) -> float:
    return _BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """
    Refuses to follow HTTP redirects for ingest requests. urllib's default
    opener transparently follows 3xx responses *and forwards all original
    request headers to the new location* — including the `x-api-key`
    header — even when the redirect target is a different scheme, host, or
    port. A malicious or misconfigured endpoint could use that to exfiltrate
    the API key. A trace sink has no legitimate reason to redirect, so
    treat any 3xx as an explicit, non-retryable failure instead of quietly
    completing the request against an unintended host.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)


class ContextTraceClient:
    """The main SDK entry point: owns the queue, the background flusher
    thread, and the cache of session handles."""

    def __init__(
        self,
        endpoint: str,
        api_key: Optional[str] = None,
        flush_interval: float = 2.0,
        max_batch: int = 100,
        max_queue: int = 5000,
        max_sessions: int = 1000,
        request_timeout: float = _DEFAULT_REQUEST_TIMEOUT_SECONDS,
        on_error: Optional[Callable[[Exception], None]] = None,
        enabled: bool = True,
        content_mode: str = "full",
        redact: Optional[Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]] = None,
    ):
        self._endpoint = endpoint.rstrip("/")
        # Reject anything but http(s) up front: this is a configuration
        # error, not a runtime capture failure, so it raises immediately
        # rather than being silently sanitized like the numeric options
        # below. In particular this blocks file:// and ftp:// endpoints,
        # which urllib would otherwise happily "POST" to with surprising
        # (and in file://'s case, locally dangerous) results.
        scheme = urllib.parse.urlsplit(self._endpoint).scheme.lower()
        if scheme not in ("http", "https"):
            raise ValueError(
                f"context-trace: endpoint must start with 'http://' or 'https://' (got {endpoint!r})"
            )
        # A dedicated opener that never follows redirects — see
        # _NoRedirectHandler for why. Built once and reused for every
        # request rather than per-call.
        self._opener = urllib.request.build_opener(_NoRedirectHandler)
        self._api_key = api_key
        self._flush_interval = _sanitize_float_option(
            flush_interval, _DEFAULT_FLUSH_INTERVAL_SECONDS, 0
        )
        self._max_batch = _sanitize_int_option(max_batch, _DEFAULT_MAX_BATCH, 1)
        self._max_queue = _sanitize_int_option(max_queue, _DEFAULT_MAX_QUEUE, 1)
        self._max_sessions = _sanitize_int_option(max_sessions, _DEFAULT_MAX_SESSIONS, 1)
        # Per-request socket timeout passed to urlopen. Keeps a single hung
        # HTTP call bounded so shutdown() (which allows only one attempt per
        # batch — see _send_with_retry) can't be stuck on it indefinitely.
        self._request_timeout = _sanitize_float_option(
            request_timeout, _DEFAULT_REQUEST_TIMEOUT_SECONDS, 0.001
        )
        self._on_error = on_error
        self._enabled = bool(enabled)
        # Client-level defaults, overridable per segment (see
        # SessionHandle.segment). An unrecognized content_mode raises
        # rather than silently falling back to "full" — see
        # _normalize_content_mode.
        self._content_mode = _normalize_content_mode(
            content_mode, "ContextTraceClient(content_mode=...)"
        )
        self._redact = redact

        # Single lock guarding the queue and the session-handle cache (and,
        # via SessionHandle, each handle's own segment auto-counter) so the
        # client is safe to drive from multiple threads at once (e.g. a
        # background flusher thread plus caller threads).
        self._lock = threading.RLock()
        self._flush_lock = threading.Lock()
        self._queue: List[Dict[str, Any]] = []
        self._sessions: "OrderedDict[str, SessionHandle]" = OrderedDict()

        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._shutdown_done = False
        self._atexit_registered = False
        if self._enabled and self._flush_interval > 0:
            self._thread = threading.Thread(target=self._run_flusher, daemon=True)
            self._thread.start()
        if self._enabled:
            # Best-effort safety net for processes that exit without ever
            # calling shutdown()/flush() explicitly. Bounded and idempotent
            # — see _atexit_flush. Not a delivery guarantee: atexit hooks
            # don't run on os._exit(), SIGKILL, or a hard crash.
            atexit.register(self._atexit_flush)
            self._atexit_registered = True

    # -- internal helpers ---------------------------------------------------

    def _run_flusher(self) -> None:
        # Event.wait(timeout) returns False on timeout, True if stop_event
        # was set in the meantime — loop until told to stop. Runs as a
        # daemon thread, so it never keeps the process alive on its own.
        while not self._stop_event.wait(self._flush_interval):
            self.flush()

    def _report_error(self, err: BaseException) -> None:
        if not self._on_error:
            return
        error = err if isinstance(err, Exception) else Exception(str(err))
        try:
            self._on_error(error)
        except Exception:
            # The host's error handler misbehaved. We must never raise into
            # the host app, so swallow it here.
            pass

    def _enqueue(self, event: Dict[str, Any]) -> None:
        if not self._enabled:
            return
        overflow = False
        with self._lock:
            self._queue.append(event)
            if len(self._queue) > self._max_queue:
                self._queue.pop(0)
                overflow = True
        if overflow:
            self._report_error(Exception("context-trace: queue overflow, dropped oldest event"))

    # -- public API -----------------------------------------------------

    def start_session(
        self,
        name: str,
        id: Optional[str] = None,
        agent: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> "SessionHandle":
        try:
            sid = id or generate_id("ses")
            if self._enabled:
                session: Dict[str, Any] = {"id": sid, "name": name, "startedAt": _now_iso()}
                if agent is not None:
                    session["agent"] = agent
                if metadata is not None:
                    session["metadata"] = metadata
                self._enqueue({"type": "session.started", "data": session})
            return self._get_or_create_session_handle(sid)
        except Exception as err:
            self._report_error(err)
            return SessionHandle(self, id or "")

    def session(self, id: str) -> "SessionHandle":
        try:
            return self._get_or_create_session_handle(id)
        except Exception as err:
            self._report_error(err)
            return SessionHandle(self, id)

    def _get_or_create_session_handle(self, id: str) -> "SessionHandle":
        if not self._enabled:
            # Nothing downstream reads from the cache when disabled (every
            # capture call is already a no-op via _enqueue), so skip
            # caching entirely.
            return SessionHandle(self, id)

        with self._lock:
            existing = self._sessions.get(id)
            if existing is not None:
                self._sessions.move_to_end(id)  # mark as most-recently-used
                return existing

            handle = SessionHandle(self, id)
            self._sessions[id] = handle
            if len(self._sessions) > self._max_sessions:
                self._sessions.popitem(last=False)  # evict least-recently-used
            return handle

    def flush(self) -> None:
        if not self._enabled:
            return
        try:
            with self._flush_lock:
                self._drain()
        except Exception as err:
            self._report_error(err)

    def _drain(self) -> None:
        while True:
            with self._lock:
                if not self._queue:
                    return
                batch = self._queue[: self._max_batch]
                del self._queue[: self._max_batch]
            self._send_with_retry(batch)

    def _send_with_retry(self, batch: List[Dict[str, Any]]) -> None:
        for attempt in range(1, _MAX_SEND_ATTEMPTS + 1):
            try:
                parsed = self._send(batch)
            except Exception as err:
                # `_stop_event` is checked here (not just at the top of the
                # loop) so a shutdown() in progress aborts the ladder right
                # after the attempt that's already in flight completes,
                # instead of sleeping through a full backoff step first.
                if (
                    attempt >= _MAX_SEND_ATTEMPTS
                    or not _is_retryable(err)
                    or self._stop_event.is_set()
                ):
                    self._report_error(err)
                    return
                # stop_event.wait() doubles as an interruptible sleep: it
                # returns immediately once shutdown() sets the event,
                # instead of blocking through the rest of the backoff delay.
                self._stop_event.wait(_backoff_delay(attempt))
                continue
            # Response-body parsing happens outside the retried section: a
            # malformed 'rejected' payload must never be mistaken for a
            # send failure, which would otherwise trigger a retry that
            # re-POSTs a batch the server already accepted.
            self._safe_report_partial_rejections(parsed, batch)
            return

    def _send(self, batch: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        body = json.dumps({"events": batch}).encode("utf-8")
        req = urllib.request.Request(
            f"{self._endpoint}/v1/ingest",
            data=body,
            method="POST",
            headers={"content-type": "application/json"},
        )
        if self._api_key:
            req.add_header("x-api-key", self._api_key)
        try:
            # Use the dedicated no-redirect opener (see _NoRedirectHandler)
            # rather than the module-level urllib.request.urlopen, whose
            # default opener follows 3xx responses and forwards the
            # x-api-key header to wherever they point.
            with self._opener.open(req, timeout=self._request_timeout) as resp:
                status = resp.getcode()
                raw = resp.read()
        except urllib.error.HTTPError as err:
            status = err.code
            raw = err.read()
        # A non-HTTPError, non-URLError exception (shouldn't normally
        # happen) and a plain URLError (network failure, no status) both
        # propagate up uncaught here — the generic default in
        # `_is_retryable` treats them as retryable, matching the TS SDK.
        if status is None or status < 200 or status >= 300:
            raise IngestHttpError(status)
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def _safe_report_partial_rejections(
        self, parsed: Optional[Dict[str, Any]], batch: List[Dict[str, Any]]
    ) -> None:
        try:
            self._report_partial_rejections(parsed, batch)
        except Exception as err:
            self._report_error(err)

    def _report_partial_rejections(
        self, parsed: Optional[Dict[str, Any]], batch: List[Dict[str, Any]]
    ) -> None:
        """
        A 200 response can still partially reject the batch (malformed
        events mixed with good ones): { accepted, rejected: [{ index,
        reason }] }. Surface those drops via on_error instead of silently
        discarding them. Tolerates a missing/unparsable body.
        """
        if not parsed:
            return
        rejected = parsed.get("rejected")
        if not rejected:
            return
        reasons = []
        for item in rejected:
            idx = item.get("index")
            reason = item.get("reason")
            event = batch[idx] if isinstance(idx, int) and 0 <= idx < len(batch) else None
            label = event["type"] if event else f"#{idx}"
            reasons.append(f"{label}: {reason}")
        self._report_error(
            Exception(
                f"context-trace: server rejected {len(rejected)} event(s): " + "; ".join(reasons)
            )
        )

    def shutdown(
        self,
        join_timeout: float = _DEFAULT_SHUTDOWN_JOIN_TIMEOUT_SECONDS,
        flush_timeout: float = _DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_SECONDS,
    ) -> None:
        """
        Stop the background flusher thread, then perform one bounded
        best-effort flush. Signals `_stop_event` first so the retry ladder
        in `_send_with_retry` (background thread or this final flush)
        aborts after its current attempt instead of working through the
        full 3-attempt/backoff sequence — this is what keeps shutdown()
        from blocking for tens of seconds against a slow/hanging endpoint.
        It can still take up to roughly `join_timeout` + one in-flight
        request (bounded by `request_timeout`), since a request already in
        progress when shutdown() is called can't be interrupted mid-flight.
        """
        try:
            self._stop_event.set()
            if self._thread is not None:
                self._thread.join(timeout=join_timeout)
                if self._thread.is_alive():
                    # Still running (almost certainly blocked on a slow
                    # request past join_timeout) — don't null the
                    # reference, since that would misreport the thread as
                    # stopped to anything checking it.
                    self._report_error(
                        Exception(
                            "context-trace: background flush thread did not stop within "
                            f"{join_timeout}s (a request may still be in flight)"
                        )
                    )
                else:
                    self._thread = None
            self._shutdown_flush(flush_timeout)
        except Exception as err:
            self._report_error(err)
        finally:
            self._shutdown_done = True
            if self._atexit_registered:
                try:
                    atexit.unregister(self._atexit_flush)
                except Exception:
                    pass

    def _shutdown_flush(self, timeout: float) -> None:
        """
        Best-effort final drain: bounded by `timeout` when acquiring the
        shared flush lock, in case the background thread is still mid-drain
        against a slow endpoint (its in-flight request can't be canceled,
        only waited out or abandoned). If the lock can't be acquired in
        time, this reports and returns rather than blocking — queued events
        are left for a future flush() rather than guaranteed delivered.
        """
        if not self._enabled:
            return
        acquired = self._flush_lock.acquire(timeout=timeout)
        if not acquired:
            self._report_error(
                Exception(
                    "context-trace: shutdown flush skipped; a previous flush is still "
                    "in progress against a slow endpoint"
                )
            )
            return
        try:
            self._drain()
        except Exception as err:
            self._report_error(err)
        finally:
            self._flush_lock.release()

    def _atexit_flush(self) -> None:
        """
        Registered via atexit at construction time (when enabled): a
        bounded, best-effort safety net so queued events aren't silently
        lost just because the host process exited without calling
        shutdown()/flush() explicitly. Idempotent — a prior explicit
        shutdown() unregisters this, and this itself only runs once.
        Deliberately never raises: the interpreter is already tearing down.
        """
        if self._shutdown_done:
            return
        try:
            self._stop_event.set()
            self._shutdown_flush(_DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_SECONDS)
        except Exception:
            pass
        finally:
            self._shutdown_done = True


class SessionHandle:
    """Handle bound to one session id, with its own segment auto-counter."""

    def __init__(self, client: ContextTraceClient, id: str):
        self._client = client
        self.id = id
        self._segment_counter = 0

    def segment(
        self,
        id: Optional[str] = None,
        index: Optional[int] = None,
        label: Optional[str] = None,
        kind: str = "llm_call",
        model: Optional[str] = None,
        timestamp: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        content_mode: Optional[str] = None,
        redact: Optional[Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]] = None,
    ) -> "SegmentBuilder":
        with self._client._lock:
            if index is not None:
                idx = index
                if index >= self._segment_counter:
                    self._segment_counter = index + 1
            else:
                idx = self._segment_counter
                self._segment_counter += 1
        seg_id = id or generate_id("seg")
        ts = timestamp or _now_iso()
        # Per-segment override wins in both directions: an explicit
        # content_mode/redact here replaces the client default entirely for
        # this segment, rather than merging with it. An unrecognized
        # content_mode raises here (see _normalize_content_mode) rather
        # than silently downgrading this segment to "full" — a deliberate
        # exception to segment()'s usual non-raising contract, since
        # silently widening a privacy control is worse than a loud failure.
        effective_content_mode = (
            self._client._content_mode
            if content_mode is None
            else _normalize_content_mode(content_mode, "session.segment(content_mode=...)")
        )
        effective_redact = self._client._redact if redact is None else redact
        return SegmentBuilder(
            self._client,
            self.id,
            seg_id,
            idx,
            kind,
            ts,
            label,
            model,
            metadata,
            effective_content_mode,
            effective_redact,
        )

    def end(self, ended_at: Optional[str] = None) -> None:
        try:
            self._client._enqueue(
                {
                    "type": "session.ended",
                    "data": {"sessionId": self.id, "endedAt": ended_at or _now_iso()},
                }
            )
        except Exception as err:
            self._client._report_error(err)


class SegmentBuilder:
    """Accumulates sections for one segment snapshot; finalized by record()."""

    def __init__(
        self,
        client: ContextTraceClient,
        session_id: str,
        id: str,
        index: int,
        kind: str,
        timestamp: str,
        label: Optional[str],
        model: Optional[str],
        metadata: Optional[Dict[str, Any]],
        content_mode: str = "full",
        redact: Optional[Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]] = None,
    ):
        self._client = client
        self._session_id = session_id
        self.id = id
        self.index = index
        self._kind = kind
        self._timestamp = timestamp
        self._label = label
        self._model = model
        self._metadata = metadata
        self._content_mode = content_mode
        self._redact = redact
        self._lock = threading.Lock()
        self._sections: List[Dict[str, Any]] = []
        self._recorded = False

    def section(
        self,
        key: str,
        service: str,
        service_kind: str = "other",
        role: Optional[str] = None,
        content: Optional[str] = None,
        tokens: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> "SegmentBuilder":
        try:
            with self._lock:
                if self._recorded:
                    self._client._report_error(
                        Exception(
                            f"context-trace: section() called after record() on segment {self.id}"
                        )
                    )
                    return self

                if self._redact is not None:
                    section_input: Dict[str, Any] = {
                        "key": key,
                        "service": service,
                        "service_kind": service_kind,
                        "role": role,
                        "content": content,
                        "tokens": tokens,
                        "metadata": metadata,
                    }
                    try:
                        result = self._redact(section_input)
                    except Exception as err:
                        # Fail closed: never ship content a failing redactor
                        # was meant to scrub. Drop the section entirely
                        # instead of falling back to the pre-redaction input.
                        self._client._report_error(
                            Exception(
                                f'context-trace: redact() raised for section "{key}" on '
                                f"segment {self.id}; dropping the section (fail closed): {err}"
                            )
                        )
                        return self
                    if result is None:
                        return self  # dropped; position stays contiguous
                    # Full replacement, mirroring the TS SDK: the dict
                    # `redact` returns IS the section going forward, not a
                    # set of overrides merged onto the pre-redaction
                    # section. A field the callback omits from its return
                    # value is therefore absent here — NOT silently
                    # inherited from the original `content`/etc. above. A
                    # redactor that means to keep a field unchanged must
                    # return it explicitly (e.g. build the return value
                    # from `dict(section_input)` and only override what it
                    # actually wants to change).
                    key = result.get("key")
                    service = result.get("service")
                    service_kind = result.get("service_kind")
                    role = result.get("role")
                    content = result.get("content")
                    tokens = result.get("tokens")
                    metadata = result.get("metadata")

                # contentHash and tokens are always derived from the real
                # (redacted) content, computed before any hash-only
                # stripping below.
                content_hash = fnv1a64(content or "")
                tok = tokens if tokens is not None else estimate_tokens(content or "")
                section: Dict[str, Any] = {
                    "key": key,
                    "service": service,
                    "serviceKind": service_kind,
                    "position": 0,  # reassigned in call order at record() time
                    "contentHash": content_hash,
                    "tokens": tok,
                }
                if role is not None:
                    section["role"] = role
                if content is not None and self._content_mode != "hash_only":
                    section["content"] = content
                if metadata is not None:
                    section["metadata"] = metadata
                self._sections.append(section)
        except Exception as err:
            self._client._report_error(err)
        return self

    def record(self) -> None:
        segment: Optional[Dict[str, Any]] = None
        try:
            with self._lock:
                if self._recorded:
                    self._client._report_error(
                        Exception(
                            f"context-trace: record() called more than once on segment {self.id}"
                        )
                    )
                    return
                self._recorded = True
                sections = self._dedupe_by_key(self._sections)
                for position, section in enumerate(sections):
                    section["position"] = position
                segment = {
                    "id": self.id,
                    "sessionId": self._session_id,
                    "index": self.index,
                    "kind": self._kind,
                    "timestamp": self._timestamp,
                    "sections": sections,
                }
                if self._label is not None:
                    segment["label"] = self._label
                if self._model is not None:
                    segment["model"] = self._model
                if self._metadata is not None:
                    segment["metadata"] = self._metadata
        except Exception as err:
            self._client._report_error(err)
            return
        if segment is not None:
            self._client._enqueue({"type": "segment.recorded", "data": segment})

    def _dedupe_by_key(self, sections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        A duplicate `key` within one segment makes the server discard the
        whole snapshot. Collapse duplicates here instead: the last write
        for a key wins its content, but keeps the ordinal slot of its first
        appearance.
        """
        slot_by_key: Dict[str, int] = {}
        result: List[Dict[str, Any]] = []
        duplicate_count = 0
        for section in sections:
            key = section["key"]
            existing_slot = slot_by_key.get(key)
            if existing_slot is not None:
                result[existing_slot] = section
                duplicate_count += 1
            else:
                slot_by_key[key] = len(result)
                result.append(section)
        if duplicate_count > 0:
            self._client._report_error(
                Exception(
                    f"context-trace: segment {self.id} had {duplicate_count} duplicate "
                    "section key(s); last write wins"
                )
            )
        return result

    def outcome(
        self,
        response_text: Optional[str] = None,
        latency_ms: Optional[float] = None,
        model: Optional[str] = None,
        scores: Optional[Dict[str, float]] = None,
        error: Optional[str] = None,
    ) -> None:
        try:
            with self._lock:
                recorded = self._recorded
            if not recorded:
                self._client._report_error(
                    Exception(
                        f"context-trace: outcome() called before record() on segment {self.id}"
                    )
                )
                return
            outcome_data: Dict[str, Any] = {}
            # responseText is model output, exactly as sensitive as section
            # content, and withheld the same way in hash_only mode. `error`
            # is deliberately NOT stripped: provider error strings can't be
            # hashed usefully the way content can, and scrubbing them is the
            # caller's responsibility (see README).
            if response_text is not None and self._content_mode != "hash_only":
                outcome_data["responseText"] = response_text
            if latency_ms is not None:
                outcome_data["latencyMs"] = latency_ms
            if model is not None:
                outcome_data["model"] = model
            if scores is not None:
                outcome_data["scores"] = scores
            if error is not None:
                outcome_data["error"] = error
            self._client._enqueue(
                {
                    "type": "segment.outcome",
                    "data": {
                        "sessionId": self._session_id,
                        "segmentId": self.id,
                        "outcome": outcome_data,
                    },
                }
            )
        except Exception as err:
            self._client._report_error(err)
