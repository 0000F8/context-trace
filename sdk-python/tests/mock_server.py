"""
Threaded HTTP server standing in for the context-trace ingest endpoint in
tests. Captures every POSTed batch (as the parsed list of events) and lets a
test queue up specific (status, body) responses to drive retry, rejection,
and error-path behavior in the client under test.
"""

import http.server
import json
import socketserver
import threading
import time
from typing import Any, Dict, List, Optional, Tuple


class _ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class MockIngestServer:
    def __init__(self):
        self._lock = threading.Lock()
        self.requests: List[Optional[List[Dict[str, Any]]]] = []
        self.headers: List[Dict[str, str]] = []
        self._responses: List[Tuple[int, Dict[str, Any], Dict[str, str]]] = []
        self._hang_seconds = 0.0

        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):  # silence default request logging
                pass

            def do_POST(self):
                with outer._lock:
                    hang = outer._hang_seconds
                if hang:
                    # Simulate a slow/hanging endpoint: block before even
                    # reading the body, so the client's socket read times
                    # out rather than getting a response.
                    time.sleep(hang)
                length = int(self.headers.get("content-length", 0))
                raw = self.rfile.read(length) if length else b""
                try:
                    payload = json.loads(raw.decode("utf-8")) if raw else None
                except Exception:
                    payload = None
                events = payload.get("events") if isinstance(payload, dict) else None

                with outer._lock:
                    outer.requests.append(events)
                    outer.headers.append(dict(self.headers.items()))
                    if outer._responses:
                        status, body, extra_headers = outer._responses.pop(0)
                    else:
                        status, body, extra_headers = 200, {"accepted": len(events) if events else 0}, {}

                data = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                for name, value in extra_headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

        self.httpd = _ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def queue_response(
        self, status: int, body: Dict[str, Any], headers: Optional[Dict[str, str]] = None
    ) -> None:
        with self._lock:
            self._responses.append((status, body, headers or {}))

    def set_hang(self, seconds: float) -> None:
        """Make every subsequent request block for `seconds` before the
        server responds at all, simulating a slow/hanging endpoint."""
        with self._lock:
            self._hang_seconds = seconds

    def request_count(self) -> int:
        with self._lock:
            return len(self.requests)

    def all_events(self) -> List[Dict[str, Any]]:
        """Flatten every request's events, in arrival order."""
        with self._lock:
            flat: List[Dict[str, Any]] = []
            for events in self.requests:
                if events:
                    flat.extend(events)
            return flat

    def shutdown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
