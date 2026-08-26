# context-trace-claude-code-adapter

A [Claude Code](https://docs.claude.com/en/docs/claude-code) hook adapter
that snapshots the current transcript into
[context-trace](../../README.md) on `Stop` and `PostToolUse`. Plain Node
ESM, zero npm dependencies, no build step — `capture.mjs` is invoked
directly as a hook command.

## How it works

Claude Code invokes a hook command with a JSON payload on stdin containing
(among other fields) `session_id`, `transcript_path`, and
`hook_event_name`. `capture.mjs`:

1. Reads that payload from stdin.
2. Reads the transcript JSONL file at `transcript_path` — rejected up front
   if it doesn't end in `.jsonl`, cheap hardening against reading whatever
   arbitrary file a malformed or spoofed hook payload happened to name.
3. Parses it (`lib.mjs`'s `parseTranscript`) and builds one segment
   snapshot's worth of sections (`buildSections`): `hist:transcript` (the
   full serialized conversation), `user:latest`, `assistant:latest`, and
   `tool:<name>` for the most recent tool result, when present. Every
   section's content is capped at 240,000 characters (see "Honest caveat"
   below).
4. Assigns the segment's index from a per-session counter file under a
   counter directory (see "Where state lives" below), named after the
   session id. `session_id` is untrusted input from the hook payload, so
   it's reduced to a safe filename first — anything other than
   `[A-Za-z0-9._-]+` (e.g. a `/` or `..`) causes the **whole id** to be
   replaced by a stable hash of it, rather than trying to escape or strip
   individual characters, closing off any path-traversal read/write outside
   the counter directory. The read-modify-write against the counter file is
   guarded by a per-session advisory lock (an `mkdir`-based lock directory,
   since directory creation is atomic across processes) with retry/backoff
   and a 5-second stale-lock timeout — Claude Code can fire two hooks for
   the same session in close succession (e.g. `PostToolUse` for parallel
   tool calls), and without the lock both processes could read the same
   counter value and post colliding segment ids, silently overwriting one
   snapshot with the other.
5. POSTs a single `segment.recorded` event to
   `${CONTEXT_TRACE_ENDPOINT}/v1/ingest`. The session doesn't need to exist
   yet — the server auto-creates a stub session for a segment whose
   `sessionId` it hasn't seen before.

**This script never fails the hook.** Every error path (bad payload,
missing transcript, network failure, ...) logs to stderr and returns; it
never exits non-zero and never throws past its own top-level catch.

## Where state lives

The per-session counter files and lock directories live under
`~/.cache/context-trace-cc/` by default (owner-only permissions, `0700`),
falling back to `os.tmpdir()/context-trace-cc/` only when a home directory
can't be resolved (e.g. some restricted/sandboxed environments). `~/.cache`
is preferred over `/tmp` on purpose: `/tmp` is world-writable and shared
across every user on the machine, which exposes it to a symlink race (an
attacker pre-creating `/tmp/context-trace-cc/<name>.json` as a symlink to a
file they want overwritten, before this script ever runs) that a
user-owned `~/.cache` directory isn't subject to in the same way.

## Configuration

| Env var                    | Default                   | Description |
|-----------------------------|----------------------------|--------------|
| `CONTEXT_TRACE_ENDPOINT`    | `http://localhost:4720`   | Base URL of the context-trace server. |
| `CONTEXT_TRACE_API_KEY`     | -                          | Sent as `x-api-key` when set. Matches server `CT_API_KEY`. |

## Wiring it up

Add to your `.claude/settings.json` (project) or `~/.claude/settings.json`
(user) — replace `/absolute/path/to/context-trace` with this repo's path:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/context-trace/adapters/claude-code/capture.mjs"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/context-trace/adapters/claude-code/capture.mjs"
          }
        ]
      }
    ]
  }
}
```

Set `CONTEXT_TRACE_ENDPOINT`/`CONTEXT_TRACE_API_KEY` in the environment
Claude Code runs in (or prefix the command, e.g.
`"CONTEXT_TRACE_ENDPOINT=https://trace.example.com node .../capture.mjs"`).

## Honest caveat

This adapter observes **the transcript**, not the model's literal assembled
context. Claude Code's transcript is the conversation history as recorded
after each turn — it doesn't include the system prompt, the tool schemas,
or however the CLI's own context-management (compaction, file-read
caching, etc.) actually shaped what was sent to the model on any given
turn. What you get here is a faithful, useful proxy for "what happened in
this session" — good for spotting churny back-and-forth, oversized tool
outputs lingering in history, and rough token growth over time — but it is
**not** a byte-for-byte record of the request that was sent to the API.

Every section built here (`hist:transcript`, `user:latest`,
`assistant:latest`, `tool:<name>`) is capped at 240,000 characters — not
just the transcript, since a single oversized message (a giant tool result,
say) shouldn't be able to get the whole segment rejected server-side by the
per-section content-size limit. Once any of them crosses the cap, the
**tail** is kept rather than the head — content here only grows across a
session, so keeping the head would freeze that section's content the
moment it crossed the cap (every later turn truncates back to the same
leading bytes), which would otherwise look, to the analytics, like a
section that's present and unchanged forever: a false dead-weight finding.
One consequence: once a section is over the cap, it no longer contains its
own earliest content.

## Tests

`lib.mjs` (pure parsing/section-building/sanitization, no I/O) is
unit-tested against a realistic fixture transcript in
`test/fixture-transcript.jsonl`. `capture.mjs`'s pure/exported pieces —
`resolveCounterDir` and the filesystem hardening around `nextIndex` (owner-
only directory permissions, session-id sanitization staying inside the
counter dir) — are covered in `test/capture.test.mjs`, and the counter lock
itself is exercised across real, separate `node` processes in
`test/counter-lock.test.mjs` (via the `test/concurrent-counter-worker.mjs`
harness) to confirm concurrent hook invocations for the same session never
collide on the same index:

```sh
npm test -w context-trace-claude-code-adapter
```

The stdin/fetch glue in `main()` is intentionally left untested at the unit
level — it's a thin, defensively-wrapped shell around the pieces above, and
exercising it end-to-end is better done by pointing a real
`CONTEXT_TRACE_ENDPOINT` at a running server and checking the session it
produces.
