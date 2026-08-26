# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Observability for context engineering: capture the context an LLM app assembles (sessions → segments → sections), compile it into temporal/procedural traces, inspect it in a web UI. Spec and design brief live in `.omc/autopilot/` (`spec.md` is the authoritative contract; `design-brief.md` governs all web UI work).

## Commands

```sh
npm install                 # workspace install (root)
npm run build               # ordered: types -> sdk -> server -> web
npm run test                # vitest across all workspaces
npm run typecheck
npm run dev:server          # tsx watch, :4720
npm run dev:web             # vite, :5173, /api proxied to :4720
npm run seed                # demo sessions into the local DB
npm run test -w context-trace-server              # one workspace's tests
npx vitest run src/trace/compile.test.ts -w ...   # single file: run vitest from that workspace dir
docker compose up -d --build && docker compose run --rm seed   # full stack on :8080
```

`@context-trace/types` must be built before anything that imports it typechecks — run the root `build` (it orders workspaces explicitly; plain `--workspaces` scripts don't guarantee order).

## Architecture (the parts that span files)

- **Snapshot model is the core invariant.** Each *segment* is a full snapshot of assembled context (ordered *sections*), never an incremental patch. All diffing (added/changed/carried/removed, by section `key` + fnv1a-64 `contentHash`) happens server-side by comparing consecutive segment indexes. If you change capture semantics, you change the compiler and the UI too.
- **`packages/types` is the contract** between SDK, server, and web — wire types, compiled-trace types, and the shared utils (`fnv1a64`, `estimateTokens`, `generateId`). Dependency-free and runtime-agnostic (no node:* imports); keep it that way.
- **`packages/sdk`** — zero-runtime-dep client, built for async framework hooks: every capture call is a synchronous enqueue; only the background flusher does I/O; it must never throw into or block the host app. Segment builders survive interleaved async callbacks; `ct.session(id)` re-binds without re-emitting `session.started`.
- **`server/`** — Hono + better-sqlite3. `src/trace/compile.ts` is pure (no DB/HTTP) and is where all trace semantics live; `src/app.ts` exports `createApp(db)` so tests run via `app.request()` with `:memory:` DBs. Ingest is idempotent (segment upsert replaces its sections) and partial-accept (bad events rejected per-index, good ones ingested).
- **`web/`** — Vite/React SPA, hand-rolled SVG charts (no chart libs). Calls `/api/v1/*`; the `/api` prefix is stripped by the Vite dev proxy locally and by nginx in Docker (`web/nginx.conf`). Timeline and strata grid share one x-axis column grid — keep them aligned. Service colors are assigned by first-appearance order (`src/lib/colors.ts`), stable across all views in a session.
- **Docker** builds run from the repo root context (`docker build -f server/Dockerfile .`) because workspaces need the root lockfile. The compose `seed` service runs `server/dist/seed.js` against the shared `/data` volume. nginx has a dedicated SSE location for `/api/v1/sessions/*/live` (buffering off) — keep it ahead of the generic `/api/` block.
- **v0.2 surfaces**: analytics is pure (`server/src/trace/analytics.ts`, thresholds are named constants there); the SSE bus emits after successful ingest apply; FTS5 (`sections_fts`) is maintained manually inside store transactions with a boot backfill — user queries must stay phrase-quoted bound parameters; `POST /v1/import` is a write (auth-gated like ingest). The Python SDK (`sdk-python/`, stdlib-only, `python3 -m unittest discover -s sdk-python/tests`) must keep `fnv1a64` bit-identical to the TS implementation — it hashes UTF-16 code units to match `charCodeAt`.

## Editions boundary (v0.3)

This repo is the **open core**; hosted-only capability belongs in a separate
control plane that wraps it, never a patch to these files. `docs/EDITIONS.md` is
the public contract — if you add a feature, check which column it belongs in,
and never degrade the OSS path to favor a hosted one. The OSS server makes no
outbound network calls; keep it that way.

Auth has three postures and the compatibility table in `.omc/autopilot/spec3.md`
§A is load-bearing: `CT_AUTH` unset behaves exactly as v0.2 (open, or write-key
when `CT_API_KEY` is set); only `CT_AUTH=key` turns on project scoping. Upgrades
must never silently tighten reads. Project scoping is enforced in the **store
layer**, and a session in another project must be a 404, never a 403.

## Conventions

- TS strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` (use `import type`); everything ESM with NodeNext resolution — except `web/`, which uses bundler resolution and does not extend the root tsconfig.
- Server env: `CT_PORT` (4720), `CT_DB`, `CT_API_KEY` (auth off when unset), `CT_CORS_ORIGIN`.
- UI text follows the design brief's voice: sentence case, labels name what the user sees, errors state the fix.
