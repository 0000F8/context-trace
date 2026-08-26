# Privacy

What leaves your process, in each content mode, and exactly what hash-only
mode does and does not protect. This is the honest version of that claim —
read it before deciding hash-only mode is enough for your compliance needs.

See [EDITIONS.md](./EDITIONS.md) for what's open source vs. hosted, and
[SELF-HOSTING.md](./SELF-HOSTING.md) for running your own instance so
nothing leaves your infrastructure at all.

## The two content modes

Every SDK (`@context-trace/sdk`, the Python client, and anything built on
top of them — the LangChain handler passes through whatever client it's
given) supports a `contentMode`, settable on the client and overridable per
segment:

| | `full` (default) | `hash-only` |
| --- | --- | --- |
| Section `content` (the actual prompt/response/document text) | Sent | **Not sent** — omitted from the wire payload entirely |
| `contentHash` (fnv1a-64 of the real content) | Sent | Sent |
| `tokens` (estimated token count) | Sent | Sent |
| Section `key`, `service`, `serviceKind`, `role` | Sent | Sent |
| Structured segment fields (`label`, `kind`, `model`, timestamps) | Sent | Sent |
| **Session/segment/section `metadata` objects** (arbitrary, user-supplied) | Sent | Sent — **not** touched by hash-only mode |
| Outcomes (`latencyMs`, `model`, `scores`, `error`) | Sent | Sent |
| `responseText` on an outcome | Sent | **Not sent** in hash-only mode (same treatment as section content) |

In `hash-only` mode, the hash and token count are computed **locally, from
the real content**, before anything is sent — the server never sees the
text and can't reconstruct it from the hash. Composition analytics
(carry ratio, churn, dead weight, eviction thrash, budget/over-window,
per-service token share) all work identically in both modes, because they
only ever needed the hash and the token count. What stops working: segment
detail bodies show a placeholder instead of text, the diff view can't show
word-level changes inside a "changed" section, and full-text search has
nothing to index — hash-only sessions simply won't appear in search
results.

## What hash-only mode does NOT protect

This is the part people skip. Hash-only mode stops your **prompt and
response text** from leaving the process. It does not stop:

- **Section keys and service names.** `seg.section({ key: 'mem:user-42-ssn', service: 'crm-lookup', ... })`
  ships that key and service name in full, every time, in both modes.
  These are identifiers, not content, and the trace engine needs them to
  align sections across segments — but if you put something sensitive
  in a key or service name, hash-only mode will not catch it. Keep secrets
  out of your section keys and service names, the same way you'd keep them
  out of a log line's format string.
- **Free-form `metadata` objects.** `session.metadata`, `segment.metadata`,
  and `section.metadata` are arbitrary objects you attach yourself, and they
  ship **in full, in both content modes** — hash-only mode only strips
  section `content` and outcome `responseText`, nothing else. After content
  itself, `metadata` is the single most likely place to accidentally stash
  something sensitive (a user id, a retrieved record, provenance for where a
  section came from). `redact()` runs before hashing and can rewrite or
  strip a section's `metadata` along with its content — but it only ever
  sees section input; there is no equivalent hook for `session.metadata` or
  `segment.metadata`, so anything you put there ships unconditionally.
- **Token counts.** An unusually large or small token count for a given
  section key can itself leak information about what's in it (e.g., a
  `mem:profile` section that suddenly balloons from 50 to 4,000 tokens
  tells you something happened, even without the text).
- **Timing.** Segment timestamps, latency, and the shape of the session
  (how many turns, how often a service appears, when eviction happens) are
  all still visible. Traffic analysis is still traffic analysis.
- **`contentHash` as a confirmation oracle.** If an adversary already
  suspects the content of a section (a known system prompt, a common
  boilerplate document), they can hash their guess and compare — fnv1a-64
  is a fast, non-cryptographic hash chosen for change detection, not for
  hiding content from a targeted guess. Don't treat the hash as a secret;
  treat it as a fingerprint.
- **Anything you put in a `redact()` callback that doesn't actually redact.**
  `redact` runs before hashing and before the content-mode check, so a
  correct redactor genuinely keeps that data out of both the hash and the
  wire payload — but it's your code; a redactor with a bug ships what it
  missed. If `redact()` throws, the SDK fails closed: the error goes to
  `onError` and the whole section is dropped rather than shipped
  unredacted, but a redactor that returns *wrong-but-valid* output isn't
  something the SDK can detect.

If your actual requirement is "nothing about this session should leave our
network," hash-only mode is the wrong tool — self-host instead (see
below) so there's no boundary to leak across in the first place.

## Where data rests

- **Self-hosted (open source server):** everything lives in one SQLite file
  at `CT_DB` (default `./data/context-trace.db`, `/data/context-trace.db`
  in the Docker image). There is no other datastore, no cache, no queue.
  Deleting that file deletes everything.
- **The OSS server makes no outbound network calls.** It doesn't phone
  home, doesn't check for updates, doesn't call any third-party service.
  It's a few hundred lines of routes plus better-sqlite3 — read it
  yourself if you want to verify this rather than take our word for it.
- **The web UI** talks only to the server's `/api/v1/*` routes (proxied by
  Vite locally, by nginx in Docker). It doesn't load fonts, scripts, or
  assets from a CDN at runtime — see `web/nginx.conf` and the built
  `web/dist` bundle.
- **Cloud (hosted service):** out of scope for this document, which covers
  the open source server only. See [EDITIONS.md](./EDITIONS.md) for the
  boundary between the two.

## In `key` auth mode

Projects and API keys (spec3.md §B/§C) add one more thing worth being
explicit about: only `sha256(key)` is ever stored — the plaintext key is
shown exactly once, at creation, and is not recoverable from the database.
A key's `prefix` (first 12 characters of the plaintext) is stored and
displayed for identification in `list-keys` / the admin API, which is
enough to tell keys apart in a list but not enough to reconstruct the
secret. Revoking a key is immediate and irreversible — there is no "temporarily
disable."
