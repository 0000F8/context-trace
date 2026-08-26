# Editions: what's open source, what's hosted

context-trace is open core. This document is the contract: it says exactly which
capabilities live in the Apache-2.0 project you can clone and run, which ones
only exist in the hosted service, and what we commit to never moving across that
line. If you're deciding whether to build on this, read this page first.

## The short version

**Everything an individual or a team needs to trace their own agents, on their
own machines, is open source and always will be.** The hosted service sells
operations — running it for you, at scale, with the organizational features that
only matter once many people share one instance.

We don't cripple the open source server to make the cloud look better. If a
feature is missing from the OSS edition, it's because it's about *running a
multi-tenant service*, not because we removed it.

## The line

| | Open source (Apache-2.0) | Cloud |
| --- | --- | --- |
| **SDKs and adapters** — TypeScript, Python, LangChain, Claude Code hooks | ✅ Always | Same packages |
| **Capture → compile → visualize** — the whole loop | ✅ | ✅ |
| **Trace engine** — snapshot diffing, section spans, service attribution | ✅ | ✅ |
| **Analytics and findings** — carry ratio, churn, dead weight, eviction thrash, budget/over-window | ✅ | ✅ |
| **Live tail** (SSE), playback, deep links | ✅ | ✅ |
| **Compare, full-text search, export/import** | ✅ | ✅ |
| **Hash-only mode** — analytics without shipping prompt text | ✅ | ✅ |
| **Projects + scoped API keys** (single tenant) | ✅ | ✅ |
| **Self-hosting**: Docker Compose, SQLite, migrations, backup/upgrade docs | ✅ | n/a |
| **Single-tenant provisioning script** | ✅ | n/a |
| Managed multi-tenant ingest and storage | — | ✅ |
| Retention policies, backups, point-in-time recovery | — | ✅ |
| SSO (OIDC/SAML), organizations, role-based access control | — | ✅ |
| Alerting and webhooks (e.g. "eviction thrash appeared in CI") | — | ✅ |
| Cross-session fleet analytics with long retention | — | ✅ |
| Hosted sharing (links that work for teammates without infrastructure) | — | ✅ |
| Support with an SLA | — | ✅ |

## Why the line is here

The hard, expensive parts of an observability product are not its features —
they're uptime, storage growth, retention, backups, access control, and being
on call. That's what the hosted service is for.

The parts developers need to trust the tool — the SDK in their app, the engine
that computes what changed, the ability to run the whole thing on a laptop with
no account — are exactly the parts that must be inspectable and free. A tool
that reads your prompts and retrieved documents has to be auditable, or it
doesn't deserve to be in the loop.

## Commitments

1. **No crippling.** We won't remove or degrade an OSS capability to drive cloud
   conversions. The features in the left column stay there.
2. **No telemetry.** The OSS server does not phone home. It makes no outbound
   network requests you didn't configure. Check for yourself — it's one service
   and a few hundred lines of routes.
3. **The protocol stays open and versioned.** `POST /v1/ingest` and the trace
   query API are documented and stable. Your data is yours: `GET /v1/sessions/:id/export`
   returns a complete, re-importable JSON bundle, on every edition.
4. **No fork.** The cloud runs *this* server. Hosted-only capabilities live in a
   separate control plane that wraps the open core rather than patching it, so
   the two can't quietly drift apart.
5. **Permissive licensing where it matters most.** The SDKs and adapters are
   Apache-2.0 and always will be — instrumentation code lives inside your app,
   and it should never carry license risk.

## Privacy modes matter more than editions

If your blocker is "our prompts can't leave our network," you may not need
self-hosting at all. Every SDK supports **hash-only mode**: section content stays
in your process while hashes and token counts ship. Composition, diffs, spans,
findings, and budget analysis all still work; only the raw text is absent.

See [PRIVACY.md](./PRIVACY.md) for exactly what leaves the process in each mode,
and what hash-only does *not* protect (section keys and service names are
identifiers and still ship — keep secrets out of them).

## Running it yourself

See [SELF-HOSTING.md](./SELF-HOSTING.md). The short version:

```sh
docker compose up -d --build   # open mode, single user, no accounts
```

For a team instance with projects and API keys, set `CT_AUTH=key` and use the
`keys` CLI (or `deploy/single-tenant/provision.sh`) to mint them. Nothing about
that path requires talking to us.
