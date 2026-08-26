import atexit
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from context_trace import ContextTraceClient, fnv1a64, estimate_tokens
from mock_server import MockIngestServer


def _wait_until(predicate, timeout=2.0, interval=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class ClientTestCase(unittest.TestCase):
    def setUp(self):
        self.server = MockIngestServer()
        self.errors = []
        self._lock = threading.Lock()

    def tearDown(self):
        self.server.shutdown()

    def on_error(self, err):
        with self._lock:
            self.errors.append(err)

    def make_client(self, **overrides):
        opts = dict(
            endpoint=self.server.endpoint(),
            flush_interval=0,  # manual flush only, unless overridden
            on_error=self.on_error,
        )
        opts.update(overrides)
        return ContextTraceClient(**opts)


class TestEventOrderingAndPositions(ClientTestCase):
    def test_session_started_then_segment_recorded_order(self):
        ct = self.make_client()
        session = ct.start_session(name="support-chat", agent="triage-bot")
        seg = session.segment(label="turn 1", model="claude-sonnet-5")
        seg.section(key="system", service="prompts", service_kind="system", content="sys")
        seg.record()
        ct.flush()

        events = self.server.all_events()
        self.assertEqual([e["type"] for e in events], ["session.started", "segment.recorded"])
        self.assertEqual(events[0]["data"]["name"], "support-chat")
        self.assertEqual(events[1]["data"]["sections"][0]["key"], "system")

    def test_positions_assigned_in_call_order(self):
        ct = self.make_client()
        session = ct.start_session(name="s")
        seg = session.segment()
        # Deliberately call out of "natural" order to prove position
        # tracks call (arrival) order, not any sort of the keys.
        seg.section(key="z-last-key", service="svc", content="z")
        seg.section(key="a-first-key", service="svc", content="a")
        seg.section(key="m-middle-key", service="svc", content="m")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        sections = recorded["data"]["sections"]
        self.assertEqual([s["key"] for s in sections], ["z-last-key", "a-first-key", "m-middle-key"])
        self.assertEqual([s["position"] for s in sections], [0, 1, 2])


class TestRecordIdempotency(ClientTestCase):
    def test_second_record_is_noop_and_warns(self):
        ct = self.make_client()
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="hi")
        seg.record()
        seg.record()  # second call: no-op, warns
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"]
        self.assertEqual(len(recorded), 1)
        self.assertTrue(any("record() called more than once" in str(e) for e in self.errors))

    def test_section_after_record_is_noop_and_warns(self):
        ct = self.make_client()
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="hi")
        seg.record()
        seg.section(key="b", service="svc", content="late")  # after record: dropped, warns
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        self.assertEqual(len(recorded["data"]["sections"]), 1)
        self.assertTrue(any("section() called after record()" in str(e) for e in self.errors))


class TestDedupe(ClientTestCase):
    def test_duplicate_key_last_write_wins_and_warns(self):
        ct = self.make_client()
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="dup", service="svc", content="first")
        seg.section(key="other", service="svc", content="middle")
        seg.section(key="dup", service="svc", content="second")  # overwrites, keeps slot 0
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        sections = recorded["data"]["sections"]
        self.assertEqual(len(sections), 2)
        self.assertEqual(sections[0]["key"], "dup")
        self.assertEqual(sections[0]["content"], "second")
        self.assertEqual(sections[1]["key"], "other")
        self.assertTrue(any("duplicate section key" in str(e) for e in self.errors))


class TestOutcome(ClientTestCase):
    def test_outcome_after_record_is_enqueued(self):
        ct = self.make_client()
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="hi")
        seg.record()
        seg.outcome(response_text="hello back", latency_ms=123.4, model="claude-sonnet-5",
                    scores={"helpfulness": 0.9}, error=None)
        ct.flush()

        outcomes = [e for e in self.server.all_events() if e["type"] == "segment.outcome"]
        self.assertEqual(len(outcomes), 1)
        data = outcomes[0]["data"]
        self.assertEqual(data["segmentId"], seg.id)
        self.assertEqual(data["outcome"]["responseText"], "hello back")
        self.assertEqual(data["outcome"]["scores"]["helpfulness"], 0.9)
        self.assertNotIn("error", data["outcome"])  # None fields omitted

    def test_outcome_before_record_warns_and_is_not_enqueued(self):
        ct = self.make_client()
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="hi")
        seg.outcome(response_text="too early")  # before record()
        seg.record()
        ct.flush()

        outcomes = [e for e in self.server.all_events() if e["type"] == "segment.outcome"]
        self.assertEqual(len(outcomes), 0)
        self.assertTrue(any("outcome() called before record()" in str(e) for e in self.errors))


class TestRetryAndErrorHandling(ClientTestCase):
    def test_5xx_retries_then_drops_and_reports(self):
        self.server.queue_response(500, {})
        self.server.queue_response(500, {})
        self.server.queue_response(500, {})
        ct = self.make_client()
        session = ct.start_session(name="s")
        session.end()
        ct.flush()

        self.assertEqual(self.server.request_count(), 3)  # 3 attempts, then give up
        self.assertTrue(any("status 500" in str(e) for e in self.errors))

    def test_400_drops_immediately_without_retry(self):
        self.server.queue_response(400, {"error": "bad request"})
        ct = self.make_client()
        session = ct.start_session(name="s")
        session.end()
        ct.flush()

        self.assertEqual(self.server.request_count(), 1)  # no retries burned
        self.assertTrue(any("status 400" in str(e) for e in self.errors))

    def test_partial_rejection_is_surfaced(self):
        self.server.queue_response(
            200, {"accepted": 1, "rejected": [{"index": 1, "reason": "unknown segment"}]}
        )
        ct = self.make_client()
        session = ct.start_session(name="s")
        session.end()
        ct.flush()

        self.assertEqual(self.server.request_count(), 1)
        self.assertTrue(any("rejected 1 event" in str(e) and "unknown segment" in str(e)
                             for e in self.errors))


class TestQueueBound(ClientTestCase):
    def test_overflow_drops_oldest_and_reports(self):
        ct = self.make_client(max_queue=3, flush_interval=0)
        session = ct.session("sid")
        for i in range(5):
            session.end(ended_at=f"t{i}")
        # Never flushed, so we can inspect the in-memory queue directly.
        with ct._lock:
            queue_snapshot = list(ct._queue)
        self.assertEqual(len(queue_snapshot), 3)
        self.assertEqual([e["data"]["endedAt"] for e in queue_snapshot], ["t2", "t3", "t4"])
        self.assertTrue(any("queue overflow" in str(e) for e in self.errors))


class TestEnabledFalse(ClientTestCase):
    def test_disabled_client_is_a_complete_noop(self):
        ct = self.make_client(enabled=False)
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="hi")
        seg.record()
        session.end()
        ct.flush()

        self.assertEqual(self.server.request_count(), 0)
        self.assertEqual(self.errors, [])

    def test_disabled_session_cache_is_not_populated(self):
        ct = self.make_client(enabled=False)
        h1 = ct.session("same-id")
        h2 = ct.session("same-id")
        self.assertIsNot(h1, h2)  # no caching when disabled


class TestSessionCacheLru(ClientTestCase):
    def test_lru_eviction_bounds_cache_and_resets_evicted_counter(self):
        ct = self.make_client(max_sessions=2)
        h1 = ct.session("s1")
        h1.segment().record()  # index 0
        h1.segment().record()  # index 1

        h2 = ct.session("s2")
        h3 = ct.session("s3")  # overflow: evicts s1 (least-recently-used)

        with ct._lock:
            self.assertEqual(len(ct._sessions), 2)
            self.assertIn("s2", ct._sessions)
            self.assertIn("s3", ct._sessions)
            self.assertNotIn("s1", ct._sessions)

        h1_again = ct.session("s1")  # re-created fresh (was evicted), counter reset
        seg = h1_again.segment()
        self.assertEqual(seg.index, 0)

        # Re-inserting s1 overflows again and evicts s2, the new
        # least-recently-used entry (s3 was touched more recently than s2).
        with ct._lock:
            self.assertEqual(len(ct._sessions), 2)
            self.assertIn("s3", ct._sessions)
            self.assertIn("s1", ct._sessions)
            self.assertNotIn("s2", ct._sessions)

    def test_repeated_session_calls_share_one_counter(self):
        ct = self.make_client()
        ct.session("sid").segment()  # index 0
        ct.session("sid").segment()  # index 1
        seg = ct.session("sid").segment()  # index 2
        self.assertEqual(seg.index, 2)


class TestFlushAndShutdown(ClientTestCase):
    def test_flush_drains_queue(self):
        ct = self.make_client()
        session = ct.start_session(name="s")
        session.end()
        with ct._lock:
            self.assertEqual(len(ct._queue), 2)
        ct.flush()
        with ct._lock:
            self.assertEqual(len(ct._queue), 0)
        self.assertEqual(len(self.server.all_events()), 2)

    def test_shutdown_stops_background_thread(self):
        ct = self.make_client(flush_interval=0.05)
        self.assertIsNotNone(ct._thread)
        session = ct.start_session(name="s")
        session.end()
        ct.shutdown()

        # shutdown() flushes on the way out.
        self.assertEqual(len(self.server.all_events()), 2)
        self.assertIsNone(ct._thread)

    def test_background_flusher_drains_without_manual_flush(self):
        ct = self.make_client(flush_interval=0.05)
        try:
            session = ct.start_session(name="s")
            session.end()
            self.assertTrue(_wait_until(lambda: len(self.server.all_events()) == 2, timeout=2.0))
        finally:
            ct.shutdown()


class TestShutdownBounded(ClientTestCase):
    """
    Regression coverage for the shutdown()-blocks-far-past-its-bound defect:
    a probe measured shutdown() taking ~24.4s against a slow endpoint
    because the retry ladder kept sleeping through full backoff steps and
    burning all 3 attempts even after shutdown had been requested. Fixed by
    making the retry loop stop-event-aware and giving _send a configurable,
    short-enough socket timeout.
    """

    PREVIOUS_MEASURED_BLOCK_SECONDS = 24.4

    def test_shutdown_returns_well_under_previous_measured_block_time(self):
        self.server.set_hang(30)  # endpoint never responds in time
        ct = self.make_client(flush_interval=0.05, request_timeout=0.5)
        session = ct.session("sid")
        session.end()  # queue something so the background thread has work

        # Give the background flusher a moment to start its (hanging) send.
        time.sleep(0.1)

        started = time.monotonic()
        ct.shutdown()
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, self.PREVIOUS_MEASURED_BLOCK_SECONDS / 2)
        # With a 0.5s request timeout, a 5s join bound, and no more than one
        # unretried attempt once stop_event is set, this should complete in
        # a couple of seconds at most.
        self.assertLess(elapsed, 6.0)

    def test_shutdown_does_not_retry_through_full_backoff_ladder(self):
        self.server.set_hang(30)
        ct = self.make_client(flush_interval=0, request_timeout=0.3)
        session = ct.session("sid")
        session.end()

        started = time.monotonic()
        ct.shutdown()
        elapsed = time.monotonic() - started

        # One attempt at ~0.3s timeout, no backoff/retries burned once
        # stop_event is set — nowhere near 3 * 0.3s + backoff, let alone
        # anything close to the old ~24s.
        self.assertLess(elapsed, 3.0)

    def test_thread_reference_kept_when_still_alive_past_join_timeout(self):
        self.server.set_hang(5)
        ct = self.make_client(flush_interval=0.05, request_timeout=10)
        session = ct.session("sid")
        session.end()
        time.sleep(0.1)  # let the background thread start its hanging send

        # A short join_timeout guarantees the thread is still alive when we
        # check — the fix must not null out `_thread` in that case.
        ct.shutdown(join_timeout=0.05, flush_timeout=0.05)
        self.assertIsNotNone(ct._thread)
        self.assertTrue(any("did not stop within" in str(e) for e in self.errors))

        # Clean up: let the hanging request actually finish so the daemon
        # thread doesn't linger past this test (harmless either way since
        # it's a daemon thread, but tidy).
        ct._thread.join(timeout=10)


class TestPartialRejectionParsingIsolation(ClientTestCase):
    def test_malformed_rejected_payload_does_not_trigger_a_retry(self):
        # 'rejected' is present but shaped in a way that would raise if
        # naively iterated as list-of-dicts (e.g. a plain string instead of
        # a list) — this must be reported, not mistaken for a send failure
        # that causes a re-POST of an already-accepted batch.
        self.server.queue_response(200, {"accepted": 1, "rejected": "not-a-list"})
        ct = self.make_client()
        session = ct.session("sid")
        session.end()
        ct.flush()

        # Only one request: the malformed body must not cause a retry/re-send.
        self.assertEqual(self.server.request_count(), 1)
        self.assertTrue(any(self.errors), "expected the parsing failure to be reported")

    def test_normal_partial_rejection_still_single_request(self):
        self.server.queue_response(
            200, {"accepted": 1, "rejected": [{"index": 1, "reason": "unknown segment"}]}
        )
        ct = self.make_client()
        session = ct.session("sid")
        session.end()
        ct.flush()

        self.assertEqual(self.server.request_count(), 1)
        self.assertTrue(any("rejected 1 event" in str(e) for e in self.errors))


class TestAtexitHook(ClientTestCase):
    def test_atexit_hook_registered_when_enabled(self):
        ct = self.make_client()
        try:
            self.assertTrue(ct._atexit_registered)
        finally:
            ct.shutdown()

    def test_atexit_hook_not_registered_when_disabled(self):
        ct = self.make_client(enabled=False)
        self.assertFalse(ct._atexit_registered)

    def test_shutdown_unregisters_atexit_hook(self):
        ct = self.make_client()
        callback = ct._atexit_flush
        ct.shutdown()
        # atexit.unregister is idempotent/safe even if the callback was
        # never registered, so call it again and confirm no error — the
        # meaningful assertion is that shutdown() already flushed and
        # marked itself done, so a later atexit run (if any) is a no-op.
        atexit.unregister(callback)
        self.assertTrue(ct._shutdown_done)

    def test_atexit_flush_is_idempotent_and_flushes_once(self):
        ct = self.make_client(flush_interval=0)
        session = ct.session("sid")
        session.end()

        ct._atexit_flush()
        ct._atexit_flush()  # second call must be a no-op

        self.assertEqual(len(self.server.all_events()), 1)
        ct.shutdown()  # avoid leaking the background state; harmless no-op here


class TestRedirectDoesNotLeakApiKey(ClientTestCase):
    """
    Regression coverage for a security defect (probe-verified): urllib's
    default opener transparently follows redirects and forwards the
    x-api-key header to the redirect target, even when that target is a
    different host. A malicious or misconfigured endpoint could use a 302
    to exfiltrate the key. Fixed by disabling redirect-following entirely
    for ingest requests (see _NoRedirectHandler) and treating any 3xx as an
    immediate, non-retryable failure.
    """

    def setUp(self):
        super().setUp()
        self.attacker = MockIngestServer()

    def tearDown(self):
        self.attacker.shutdown()
        super().tearDown()

    def test_redirect_is_not_followed_and_key_never_reaches_second_host(self):
        redirect_target = f"{self.attacker.endpoint()}/v1/ingest"
        self.server.queue_response(302, {}, headers={"Location": redirect_target})

        ct = self.make_client(api_key="super-secret-key")
        session = ct.session("sid")
        session.end()
        ct.flush()

        # The primary endpoint saw exactly one request (the original POST,
        # never a retry of it).
        self.assertEqual(self.server.request_count(), 1)

        # The critical assertion: the attacker-controlled redirect target
        # received *nothing at all* — not the events, and certainly not
        # the x-api-key header — because the redirect was never followed.
        self.assertEqual(self.attacker.request_count(), 0)
        for headers in self.attacker.headers:
            self.assertNotIn("x-api-key", {k.lower() for k in headers})

        # The 302 is surfaced as a failure rather than silently "succeeding"
        # against an unintended host.
        self.assertTrue(any("302" in str(e) for e in self.errors))

    def test_redirect_is_treated_as_non_retryable(self):
        # All three attempts would be 302 if it *were* retried; assert only
        # one request actually happened, proving redirects don't get the
        # 5xx/408/429 retry treatment.
        for _ in range(3):
            self.server.queue_response(
                302, {}, headers={"Location": f"{self.attacker.endpoint()}/v1/ingest"}
            )
        ct = self.make_client()
        session = ct.session("sid")
        session.end()
        ct.flush()

        self.assertEqual(self.server.request_count(), 1)
        self.assertEqual(self.attacker.request_count(), 0)


class TestEndpointSchemeValidation(ClientTestCase):
    def test_rejects_file_scheme(self):
        with self.assertRaises(ValueError):
            self.make_client(endpoint="file:///etc/passwd")

    def test_rejects_ftp_scheme(self):
        with self.assertRaises(ValueError):
            self.make_client(endpoint="ftp://example.com/ingest")

    def test_rejects_scheme_less_endpoint(self):
        with self.assertRaises(ValueError):
            self.make_client(endpoint="example.com:4720")

    def test_accepts_http_and_https(self):
        ct_http = self.make_client(endpoint=self.server.endpoint())
        ct_http.shutdown()
        ct_https = self.make_client(endpoint="https://example.com")
        ct_https.shutdown()


class TestContentModes(ClientTestCase):
    def test_full_mode_ships_content_unchanged(self):
        ct = self.make_client()
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="hello world")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        section = recorded["data"]["sections"][0]
        self.assertEqual(section["content"], "hello world")
        self.assertEqual(section["contentHash"], fnv1a64("hello world"))
        self.assertEqual(section["tokens"], estimate_tokens("hello world"))

    def test_hash_only_omits_content_but_preserves_hash_and_tokens(self):
        ct = self.make_client(content_mode="hash_only")
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="hello world", tokens=7)
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        section = recorded["data"]["sections"][0]
        self.assertNotIn("content", section)
        self.assertEqual(section["contentHash"], fnv1a64("hello world"))
        self.assertEqual(section["tokens"], 7)

    def test_per_segment_override_wins_client_full_segment_hash_only(self):
        ct = self.make_client()  # client default: full
        session = ct.start_session(name="s")
        seg = session.segment(content_mode="hash_only")
        seg.section(key="a", service="svc", content="secret")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        section = recorded["data"]["sections"][0]
        self.assertNotIn("content", section)
        self.assertEqual(section["contentHash"], fnv1a64("secret"))

    def test_per_segment_override_wins_client_hash_only_segment_full(self):
        ct = self.make_client(content_mode="hash_only")
        session = ct.start_session(name="s")
        seg = session.segment(content_mode="full")
        seg.section(key="a", service="svc", content="visible")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        section = recorded["data"]["sections"][0]
        self.assertEqual(section["content"], "visible")


class TestRedact(ClientTestCase):
    def test_redact_rewrites_content_before_hashing(self):
        def redact(section):
            section = dict(section)
            section["content"] = (section["content"] or "").replace("SECRET", "[REDACTED]")
            return section

        ct = self.make_client(redact=redact)
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="my SECRET value")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        section = recorded["data"]["sections"][0]
        self.assertEqual(section["content"], "my [REDACTED] value")
        self.assertEqual(section["contentHash"], fnv1a64("my [REDACTED] value"))
        self.assertNotEqual(section["contentHash"], fnv1a64("my SECRET value"))

    def test_redact_returning_none_drops_section_and_keeps_positions_contiguous(self):
        def redact(section):
            return None if section["key"] == "drop-me" else section

        ct = self.make_client(redact=redact)
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="first", service="svc", content="a")
        seg.section(key="drop-me", service="svc", content="b")
        seg.section(key="third", service="svc", content="c")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        sections = recorded["data"]["sections"]
        self.assertEqual([(s["key"], s["position"]) for s in sections], [("first", 0), ("third", 1)])

    def test_redact_raising_drops_section_and_reports_fail_closed(self):
        def redact(section):
            if section["key"] == "boom":
                raise RuntimeError("redactor exploded")
            return section

        ct = self.make_client(redact=redact)
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="ok", service="svc", content="fine")
        seg.section(key="boom", service="svc", content="top secret payload")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        sections = recorded["data"]["sections"]
        self.assertEqual([s["key"] for s in sections], ["ok"])
        # No content from the dropped section ever reached the (mock) wire.
        self.assertFalse(any("top secret payload" in str(s) for s in sections))
        self.assertTrue(any("redactor exploded" in str(e) for e in self.errors))

    def test_per_segment_redact_override_wins_over_client_default(self):
        def client_redact(section):
            raise AssertionError("client-level redact should never run for this segment")

        def segment_redact(section):
            section = dict(section)
            section["content"] = "overridden"
            return section

        ct = self.make_client(redact=client_redact)
        session = ct.start_session(name="s")
        seg = session.segment(redact=segment_redact)
        seg.section(key="a", service="svc", content="original")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        self.assertEqual(recorded["data"]["sections"][0]["content"], "overridden")

    def test_no_redact_leaves_content_untouched(self):
        ct = self.make_client()
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="plain")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        self.assertEqual(recorded["data"]["sections"][0]["content"], "plain")

    def test_redact_replaces_rather_than_merges_omitted_content_is_dropped(self):
        # Regression for a fail-open bug: a redactor that returns a dict
        # WITHOUT a "content" key must drop the content entirely, not fall
        # back to the pre-redaction original. This mirrors the TS SDK,
        # where the returned SectionInput IS the section going forward.
        def redact(section):
            return {
                "key": section["key"],
                "service": section["service"],
                "service_kind": section["service_kind"],
            }

        ct = self.make_client(redact=redact)
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="sk-live-DEADBEEF-super-secret")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        section = recorded["data"]["sections"][0]
        self.assertNotIn("content", section)
        self.assertFalse(
            any("sk-live-DEADBEEF-super-secret" in str(v) for v in section.values())
        )


class TestHashOnlyOutcome(ClientTestCase):
    def test_hash_only_omits_response_text_but_keeps_other_fields(self):
        ct = self.make_client(content_mode="hash_only")
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="x")
        seg.record()
        seg.outcome(
            response_text="sensitive model output",
            latency_ms=842,
            model="claude-sonnet-5",
            scores={"helpfulness": 0.9},
            error="timeout",
        )
        ct.flush()

        outcomes = [e for e in self.server.all_events() if e["type"] == "segment.outcome"]
        data = outcomes[0]["data"]["outcome"]
        self.assertNotIn("responseText", data)
        self.assertEqual(data["latencyMs"], 842)
        self.assertEqual(data["model"], "claude-sonnet-5")
        self.assertEqual(data["scores"]["helpfulness"], 0.9)
        self.assertEqual(data["error"], "timeout")

    def test_full_mode_still_sends_response_text(self):
        ct = self.make_client()
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="x")
        seg.record()
        seg.outcome(response_text="visible model output")
        ct.flush()

        outcomes = [e for e in self.server.all_events() if e["type"] == "segment.outcome"]
        self.assertEqual(outcomes[0]["data"]["outcome"]["responseText"], "visible model output")

    def test_per_segment_hash_only_override_applies_to_that_segments_outcome(self):
        ct = self.make_client()  # client default: full
        session = ct.start_session(name="s")
        seg = session.segment(content_mode="hash_only")
        seg.section(key="a", service="svc", content="x")
        seg.record()
        seg.outcome(response_text="should be withheld", latency_ms=10)
        ct.flush()

        outcomes = [e for e in self.server.all_events() if e["type"] == "segment.outcome"]
        data = outcomes[0]["data"]["outcome"]
        self.assertNotIn("responseText", data)
        self.assertEqual(data["latencyMs"], 10)

    def test_per_segment_full_override_applies_to_that_segments_outcome(self):
        ct = self.make_client(content_mode="hash_only")
        session = ct.start_session(name="s")
        seg = session.segment(content_mode="full")
        seg.section(key="a", service="svc", content="x")
        seg.record()
        seg.outcome(response_text="should ship")
        ct.flush()

        outcomes = [e for e in self.server.all_events() if e["type"] == "segment.outcome"]
        self.assertEqual(outcomes[0]["data"]["outcome"]["responseText"], "should ship")


class TestContentModeValidation(ClientTestCase):
    """
    Regression coverage for a fail-open bug: an unrecognized content_mode
    used to silently normalize to "full" instead of raising, so a typo
    (e.g. the TS SDK's own spelling, "hash-only") shipped full content with
    no warning at all. content_mode is a privacy control — it must fail
    closed (raise) rather than fail open (silently widen).
    """

    def test_unrecognized_client_level_content_mode_raises(self):
        with self.assertRaises(ValueError):
            self.make_client(content_mode="redacted")

    def test_unrecognized_per_segment_content_mode_raises(self):
        ct = self.make_client(content_mode="hash_only")
        session = ct.start_session(name="s")
        with self.assertRaises(ValueError):
            session.segment(content_mode="hush_only")  # plausible typo of "hash_only"

    def test_the_ts_sdk_spelling_hash_dash_only_raises_would_be_wrong_it_must_be_accepted(self):
        # This is the exact bug from the report: "hash-only" (the TS SDK's
        # and spec3.md's canonical spelling) must work in Python too,
        # rather than silently falling back to full content.
        ct = self.make_client(content_mode="hash-only")
        session = ct.start_session(name="s")
        seg = session.segment()
        seg.section(key="a", service="svc", content="secret")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        self.assertNotIn("content", recorded["data"]["sections"][0])

    def test_hash_dash_only_spelling_accepted_as_per_segment_override_too(self):
        ct = self.make_client()  # client default: full
        session = ct.start_session(name="s")
        seg = session.segment(content_mode="hash-only")
        seg.section(key="a", service="svc", content="secret")
        seg.record()
        ct.flush()

        recorded = [e for e in self.server.all_events() if e["type"] == "segment.recorded"][0]
        self.assertNotIn("content", recorded["data"]["sections"][0])

    def test_valid_content_modes_never_raise_regression(self):
        ct = self.make_client(content_mode="full")
        session = ct.start_session(name="s")
        session.segment(content_mode="full")
        session.segment(content_mode="hash_only")
        ct2 = self.make_client()  # omitted entirely: defaults to "full", must not raise
        ct2.session("s").segment()


if __name__ == "__main__":
    unittest.main()
