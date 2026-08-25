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

## Development

```sh
npm install
npm run build          # types -> sdk -> server -> web
npm run test           # all workspace tests (vitest)
npm run dev:server     # server on :4720 (tsx watch)
npm run dev:web        # web on :5173, /api proxied to :4720
npm run seed           # demo data against the local DB
```

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

## Future work

Python SDK, multi-tenant auth, live streaming, retention policies, OTLP interop.
