# context-trace

Observability for context engineering. Capture the context your LLM application assembles — every contributing section and service — and inspect it as temporal and procedural traces.

- **`packages/sdk`** — `@context-trace/sdk`, a zero-dependency TypeScript client. Called from your app or framework hooks (async-safe, fire-and-forget); records each context assembly as a *segment* snapshot made of *sections*.
- **`server/`** — ingest + trace compilation service (Hono + SQLite). Diffs consecutive snapshots into added / changed / carried / removed section states, section lifespans, and per-service token shares.
- **`web/`** — trace inspector UI: composition timeline, section strata grid, and segment-to-segment diffs.

## Quickstart (Docker)

```sh
docker compose up -d --build      # server on :4720, web on :8080
docker compose run --rm seed      # load demo sessions
open http://localhost:8080
```

For a real multi-turn trace (a coding-agent session with growing history, file reads
evicted over time, subagent reports, and a mid-session compaction cliff), run
`npm run build && node examples/trace-real-session.mjs` — it captures the Claude Code
session that built this repo, using the repo's own files as context payloads.

## Development

```sh
npm install
npm run build          # types -> sdk -> server -> web
npm run test           # all workspace tests (vitest)
npm run dev:server     # server on :4720 (tsx watch)
npm run dev:web        # web on :5173, /api proxied to :4720
npm run seed           # demo data against the local DB
```

## Editions

context-trace is open core, and the line is documented: see
[docs/EDITIONS.md](docs/EDITIONS.md). Everything you need to trace your own
agents — SDKs, the trace engine, analytics and findings, live tail, compare,
search, export, hash-only mode, projects and API keys, self-hosting — is
Apache-2.0 and stays that way. The hosted service sells operations (managed
multi-tenant storage, retention, SSO/RBAC, alerting, long-retention fleet
analytics), not withheld features.

Privacy note: if your constraint is "prompt text can't leave our network," you
may not need self-hosting — every SDK supports **hash-only mode**, where content
stays in your process while hashes and token counts ship, and every diff,
finding, and budget analysis still works. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Server configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `CT_PORT` | `4720` | Server listen port |
| `CT_DB` | `./data/context-trace.db` | SQLite database path (`/data/context-trace.db` in Docker) |
| `CT_API_KEY` | unset | When set, **writes** (`POST /v1/ingest`, `DELETE /v1/sessions/:id`) require the `x-api-key` header. Reads stay open so the dashboard keeps working — and are reachable on whatever interface the **web** port is published on, since nginx proxies `/api/` to the server. To restrict read access, bind the web port to loopback (`127.0.0.1:8080:80`), firewall it, or terminate auth in nginx. |
| `CT_CORS_ORIGIN` | `*` | CORS origin allowed for `POST /v1/ingest` only — read endpoints never emit CORS headers. |

## Capturing context

```ts
import { createClient } from '@context-trace/sdk';

const ct = createClient({ endpoint: 'http://localhost:4720' });
const session = ct.startSession({ name: 'support-chat', agent: 'triage-bot' });

// per model call (e.g. from a framework hook):
const seg = session.segment({ label: 'turn 1', kind: 'llm_call', model: 'claude-sonnet-5' });
seg.section({ key: 'system', service: 'prompts', serviceKind: 'system', role: 'system', content: SYSTEM_PROMPT });
seg.section({ key: 'mem:profile', service: 'memory', serviceKind: 'memory', content: profileText });
seg.record();

session.end();
await ct.shutdown();
```

See `packages/sdk/README.md` for the framework-hook adapter pattern and full options.

## v0.2 highlights

- **Live tail** — toggle "Live" on a trace to follow a running session over SSE (`/v1/sessions/:id/live`); the newest segment slides in as your agent works.
- **Budget line + findings** — sessions with `metadata.window` get a dashed window line on the timeline; `/v1/sessions/:id/trace/analytics` computes carry ratio, churn, dead weight, and **eviction thrash** (evicted then re-added within 5 segments — your compaction policy arguing with itself), surfaced as findings in the left rail.
- **Outcomes** — attach `{ latencyMs, scores, responseText, error }` to segments (`seg.outcome(...)` / `session.outcome(id, ...)`); shown in the inspector, aggregated in analytics.
- **Compare** — check two sessions in the list → `/compare`: metric deltas, per-service share shifts, aligned strata summary.
- **Copy as prompt** — reconstruct any segment as markdown or a messages array from the inspector.
- **Search, deep links, scrubber, export** — full-text search over section content (FTS5), shareable `?segment=N&section=key` links, a playback scrubber, and session export/import (`GET .../export`, `POST /v1/import`).
- **Adapters** — `@context-trace/langchain` (callback handler), `adapters/claude-code` (hook-driven capture of real Claude Code sessions), and a zero-dependency **Python SDK** (`sdk-python/`, `pip install -e sdk-python`).

## Future work

Multi-tenant auth, retention policies, OTLP interop, cross-session outcome correlation.
