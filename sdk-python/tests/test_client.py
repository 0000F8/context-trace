import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from context_trace import ContextTraceClient
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


if __name__ == "__main__":
    unittest.main()
