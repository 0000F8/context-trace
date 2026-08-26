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
2. Reads the transcript JSONL file at `transcript_path`.
3. Parses it (`lib.mjs`'s `parseTranscript`) and builds one segment
   snapshot's worth of sections (`buildSections`): `hist:transcript` (the
   full serialized conversation, capped at 240,000 characters), `user:latest`,
   `assistant:latest`, and `tool:<name>` for the most recent tool result, when
   present.
4. Assigns the segment's index from a per-session counter file under
   `os.tmpdir()/context-trace-cc/<session_id>.json` (each hook invocation is
   a fresh process, so the counter has to live on disk to stay monotonic
   across invocations).
5. POSTs a single `segment.recorded` event to
   `${CONTEXT_TRACE_ENDPOINT}/v1/ingest`. The session doesn't need to exist
   yet — the server auto-creates a stub session for a segment whose
   `sessionId` it hasn't seen before.

**This script never fails the hook.** Every error path (bad payload,
missing transcript, network failure, ...) logs to stderr and returns; it
never exits non-zero and never throws past its own top-level catch.

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

## Tests

`lib.mjs` (pure parsing/section-building, no I/O) is unit-tested against a
realistic fixture transcript in `test/fixture-transcript.jsonl`:

```sh
npm test -w context-trace-claude-code-adapter
```

`capture.mjs` itself (stdin/fs/fetch glue) is intentionally left
untested at the unit level — it's a thin, defensively-wrapped shell around
`lib.mjs`, and exercising it end-to-end is better done by pointing a real
`CONTEXT_TRACE_ENDPOINT` at a running server and checking the session it
produces.
