"""
context-trace: zero-runtime-dependency Python client for capturing LLM
context assemblies (sessions, segments, sections) and shipping them to a
context-trace server. Batched, non-blocking, and failure-tolerant — every
capture call is a synchronous enqueue, and it never raises into your host
app.

Quick start::

    from context_trace import ContextTraceClient

    ct = ContextTraceClient(endpoint="http://localhost:4720")
    session = ct.start_session(name="support-chat", agent="triage-bot")
    seg = session.segment(label="turn 1", kind="llm_call", model="claude-sonnet-5")
    seg.section(key="system", service="prompts", service_kind="system",
                role="system", content="...")
    seg.record()
    session.end()
    ct.flush()
"""

from .client import ContextTraceClient, SegmentBuilder, SessionHandle
from .utils import estimate_tokens, fnv1a64, generate_id

__all__ = [
    "ContextTraceClient",
    "SessionHandle",
    "SegmentBuilder",
    "fnv1a64",
    "estimate_tokens",
    "generate_id",
]

__version__ = "0.1.0"
