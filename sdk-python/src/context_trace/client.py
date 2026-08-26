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

import json
import math
import threading
import time
import urllib.error
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
_REQUEST_TIMEOUT_SECONDS = 10


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


class IngestHttpError(Exception):
    """Raised by _send() for a non-2xx HTTP response; carries the status for retry classification."""

    def __init__(self, status: int):
        super().__init__(f"context-trace: ingest request failed with status {status}")
        self.status = status


def _is_retryable(err: BaseException) -> bool:
    """408 (timeout) and 429 (rate limit) are retryable; other 4xx are not
    (won't succeed on retry); 5xx and network errors are retryable."""
    if isinstance(err, IngestHttpError):
        if err.status in (408, 429):
            return True
        return err.status < 400 or err.status >= 500
    return True


def _backoff_delay(attempt: int) -> float:
    return _BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))


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
        on_error: Optional[Callable[[Exception], None]] = None,
        enabled: bool = True,
    ):
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key
        self._flush_interval = _sanitize_float_option(
            flush_interval, _DEFAULT_FLUSH_INTERVAL_SECONDS, 0
        )
        self._max_batch = _sanitize_int_option(max_batch, _DEFAULT_MAX_BATCH, 1)
        self._max_queue = _sanitize_int_option(max_queue, _DEFAULT_MAX_QUEUE, 1)
        self._max_sessions = _sanitize_int_option(max_sessions, _DEFAULT_MAX_SESSIONS, 1)
        self._on_error = on_error
        self._enabled = bool(enabled)

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
        if self._enabled and self._flush_interval > 0:
            self._thread = threading.Thread(target=self._run_flusher, daemon=True)
            self._thread.start()

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
                self._report_partial_rejections(parsed, batch)
                return
            except Exception as err:
                if attempt >= _MAX_SEND_ATTEMPTS or not _is_retryable(err):
                    self._report_error(err)
                    return
                time.sleep(_backoff_delay(attempt))

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
            with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT_SECONDS) as resp:
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

    def shutdown(self) -> None:
        try:
            self._stop_event.set()
            if self._thread is not None:
                self._thread.join(timeout=5)
                self._thread = None
            self.flush()
        except Exception as err:
            self._report_error(err)


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
        return SegmentBuilder(
            self._client, self.id, seg_id, idx, kind, ts, label, model, metadata
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
                if content is not None:
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
            if response_text is not None:
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
