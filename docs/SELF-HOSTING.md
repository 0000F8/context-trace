# Self-hosting

Running your own context-trace instance: deployment, auth modes, key
management, backup/restore, and upgrades. See
[EDITIONS.md](./EDITIONS.md) for what's open source (all of this) vs.
hosted, and [PRIVACY.md](./PRIVACY.md) for what leaves your process in each
SDK content mode.

## Deploying

### Quickest: `docker compose up` (single user, no auth)

```sh
git clone https://github.com/0000F8/context-trace.git
cd context-trace
docker compose up -d --build      # server on :4720 (loopback only), web on :8080
docker compose run --rm seed      # optional: load demo sessions
open http://localhost:8080
```

This is `CT_AUTH` unset — today's open-mode behavior, unchanged. Fine for a
single developer on their own machine. Nothing is exposed beyond loopback
except the web port.

### A real instance with projects and API keys: `deploy/single-tenant/`

For anything shared with a team — or just to get key-based access control —
provision an isolated instance:

```sh
sh deploy/single-tenant/provision.sh acme
```

This creates an isolated Docker Compose project (its own containers,
network, and data directory — multiple instances on the same host never
collide), boots it with `CT_AUTH=key`, mints one admin key, one write key,
and one read key, and prints all three **exactly once**. Store them now —
they're hashed at rest and cannot be recovered.

```
sh deploy/single-tenant/provision.sh <instance-name> [--port N] [--data-dir PATH] [--dry-run]
```

- `--port N` — host port for the web UI (default 8080).
- `--data-dir PATH` — where this instance's SQLite data lives on the host
  (default `deploy/single-tenant/instances/<name>/data`).
- `--dry-run` — print the plan without touching Docker or the filesystem.
- Re-running against an existing instance reports its status instead of
  re-provisioning or minting new keys.

Each instance gets a short `README.md` next to its `.env` file with the
exact commands to check status, view logs, stop, upgrade, and back it up.
See `deploy/single-tenant/README.md` for the full reference.

## Auth modes

`CT_AUTH` controls the posture. Precedence is explicit on purpose — an
upgrade never silently tightens or loosens what was working before.

| `CT_AUTH` | `CT_API_KEY` | Behavior |
| --- | --- | --- |
| unset / `none` (default) | unset | **Open.** No key checks; everything resolves to a default project. This is what `docker compose up` gives you. |
| unset / `none` | set | **Legacy write-key mode.** Writes (`POST /v1/ingest`, `POST /v1/import`, `DELETE /v1/sessions/:id`) require the `x-api-key` header; reads stay open so the dashboard keeps working. |
| `key` | ignored (warns once if set) | **Project-scoped mode.** Every `/v1/*` route except `/healthz` requires a valid key; the key's role decides what it can do. This is what `provision.sh` sets up. |

Any other `CT_AUTH` value fails the server at boot with a clear error,
rather than silently falling back to open.

### Which mode should I use?

- **Solo, local, trusted machine:** leave `CT_AUTH` unset. This is exactly
  the v0.1/v0.2 behavior — nothing changes for existing installs.
- **Shared instance, don't want stray writes:** `CT_API_KEY` (legacy write-key
  mode). One shared secret gates writes; reads stay open. Simple, but no
  per-user keys and no read protection.
- **A real team instance, multiple keys, revocation, admin control:**
  `CT_AUTH=key`. This is the only mode with projects, scoped API keys, and
  the admin surface below. `provision.sh` always uses this mode.

## Projects and keys

In `key` mode, every session belongs to a project (a `default` project
always exists). A key format encodes its role at a glance:
`cta_...` (admin), `ctw_...` (write), `ctr_...` (read) — 32 random bytes,
shown once, stored only as a SHA-256 hash plus a 12-character display
prefix. Read/write keys scope strictly to their own project — a session in
another project is a 404, never a 403, so a key never learns a different
project even exists.

**`admin` is the one exception: it is instance-wide, not per-project.**
`/v1/admin/*` manages every project on the instance — listing all of them,
minting keys for any of them, deleting any of them — so there is no such
thing as a project-scoped admin. To keep that honest, the server refuses to
mint an `admin`-role key for any project other than `default`; use it as
the one credential that administers the whole instance.

| Role | Can do |
| --- | --- |
| `read` | GET routes only, within its own project |
| `write` | GETs plus ingest, import, delete, within its own project |
| `admin` | Everything, on every project, plus `/v1/admin/*` — instance-wide, `default` project only |

### Managing keys

Two equivalent ways to manage projects and keys — pick whichever fits your
workflow:

**The `keys` CLI** — operates directly on the SQLite file, no running
server required:

```sh
npm run keys -w context-trace-server -- list-projects
npm run keys -w context-trace-server -- create-project <name>
npm run keys -w context-trace-server -- create-key <projectId> <name> <read|write|admin>
npm run keys -w context-trace-server -- list-keys <projectId>
npm run keys -w context-trace-server -- revoke-key <keyId>
```

`create-key ... admin` only succeeds when `<projectId>` is `default` — admin
is instance-wide (see the role table above), so minting one for any other
project is refused with a clear error rather than handed out as a
project-scoped credential that's secretly a superuser.

Set `CT_DB` to point at the instance's database file first if it's not the
default `./data/context-trace.db`. Inside a Docker deployment, run the
compiled CLI **inside the container** instead of from the host — the host
and the container reach a bind-mounted SQLite file through different
filesystem layers, and SQLite's WAL locking does not reliably survive that
boundary:

```sh
docker compose exec -T server node server/dist/keys-cli.js create-key default alice write
```

(`provision.sh`-managed instances print the exact `docker compose` invocation,
including the right `-f`/`--env-file`/`-p` flags, in their per-instance
`README.md`.)

**The admin HTTP API** — for building your own tooling, requires an admin
key:

```
POST   /v1/admin/projects              {name} -> {id, name, createdAt}
GET    /v1/admin/projects              -> list (no keys)
POST   /v1/admin/projects/:id/keys     {name, role} -> {id, key (plaintext, once), prefix, role}
GET    /v1/admin/projects/:id/keys     -> metadata only, never plaintext or hash
POST   /v1/admin/keys/:id/revoke       -> revokes immediately
DELETE /v1/admin/projects/:id          -> cascades project + keys + sessions
```

Admin routes are rate-limited (10 requests/minute/key) and don't exist at
all outside `key` mode — an open local instance exposes no key management
surface (`/v1/admin/*` 404s).

### Bootstrap admin key

The first time a `key`-mode server boots with no admin key yet in the
database, it mints one itself and prints it to stdout once, in a banner you
can't miss in the logs. Set `CT_ADMIN_KEY` in the environment instead if you
want to supply your own (useful for containers where you'd rather not scrape
boot logs) — it's hashed at boot and the operation is idempotent across
restarts. It must be at least 32 characters; the server refuses to boot with
a shorter one rather than accept a weak admin secret.

**Prefer supplying `CT_ADMIN_KEY` yourself over the auto-mint path whenever
you can control the environment before first boot.** The auto-minted key's
plaintext goes to stdout, and container log drivers (Docker's json-file
driver included) persist stdout to disk indefinitely — an admin credential
sitting in a log file is easy to forget about and hard to revoke cleanly.
`deploy/single-tenant/provision.sh` does exactly this: it generates the
admin key itself and writes it into the instance's `.env` (mode 0600)
*before* `docker compose up`, so the auto-mint-and-print path never fires
for a provision.sh-managed instance — there is exactly one admin key, and
it never touches a log.

## Backup and restore

The entire instance is one SQLite file at `CT_DB` (default
`./data/context-trace.db`, `/data/context-trace.db` in Docker). There is no
other datastore.

**Simplest, always correct:** stop the instance, copy the file, restart.

```sh
docker compose down
cp ./data/context-trace.db /somewhere/safe/context-trace-$(date +%Y%m%d).db
docker compose up -d
```

**Without stopping the instance** (SQLite runs in WAL mode, so a plain copy
of just the `.db` file can miss recent, not-yet-checkpointed transactions —
checkpoint first):

```sh
docker compose exec -T server node -e \
  "import('./server/dist/db.js').then(({openDb}) => { \
     const db = openDb(process.env.CT_DB); db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); \
   })"
docker compose cp server:/data/context-trace.db ./context-trace-$(date +%Y%m%d).db
```

**Restore:** stop the instance, replace the file, restart.

```sh
docker compose down
cp /somewhere/safe/context-trace-20260101.db ./data/context-trace.db
docker compose up -d
```

Every session is also individually exportable/re-importable over the wire
protocol itself, independent of file-level backups —
`GET /v1/sessions/:id/export` returns a complete JSON bundle, and
`POST /v1/import` re-ingests it (a write, gated the same as ingest).

## Upgrades

```sh
git pull
docker compose up -d --build      # or: docker compose -f ... up -d --build for a single-tenant instance
```

Schema migrations are guarded and run automatically at boot — the server
checks for each column/table it needs (`PRAGMA table_info`, `CREATE TABLE IF
NOT EXISTS`) before altering anything, so it's safe to run against a fresh
database or an existing v0.1/v0.2 one. There is no separate migration step
to remember.

## The honest scaling ceiling

This is a single-process, single-SQLite-writer server. That's a deliberate
trade-off for zero-ops self-hosting, not an oversight — and it's fine for
the workloads it's built for: a team tracing their own agents, comfortably
into the low millions of sections. Past that, or once you have concurrent
high-throughput ingest from many services at once, a single SQLite writer
becomes the bottleneck. There is no Postgres driver in the open source
server today (see spec3.md §I, non-goals) — that's the point at which you'd
either shard by project across multiple instances, or look at the hosted
service, which runs a multi-tenant control plane in front of managed
storage instead of a single SQLite file.
