# Single-tenant provisioning

Spins up an isolated, key-authenticated context-trace instance with one
command. See [docs/SELF-HOSTING.md](../../docs/SELF-HOSTING.md) for the full
picture (auth modes, when to use this vs. a plain `docker compose up`, key
management); this file is the reference for what's in this directory.

## Files

- `docker-compose.template.yml` — the instance definition. Not run directly;
  `provision.sh` drives it with a per-instance `--env-file` and `-p` (project
  name), so multiple instances never collide.
- `provision.sh` — creates, boots, and reports on instances.
- `instances/<name>/` — created per instance (gitignored — see below):
  `.env` (mode 0600), `data/` (the SQLite file, bind-mounted so it's visible
  and backup-able directly from the host), and a generated `README.md` with
  that instance's exact operating commands.

## Usage

```sh
sh deploy/single-tenant/provision.sh <instance-name> [--port N] [--data-dir PATH] [--dry-run]
```

```sh
sh deploy/single-tenant/provision.sh acme                      # web on :8080
sh deploy/single-tenant/provision.sh acme --dry-run             # print the plan only
sh deploy/single-tenant/provision.sh beta --port 8081            # a second, independent instance
sh deploy/single-tenant/provision.sh acme                        # re-run: reports status, doesn't reprovision
```

Each run:

1. Creates an isolated Docker Compose project (`ct-<name>`) — its own
   containers, network, and data directory. Provisioning `beta` never
   touches `acme`.
2. Boots the stack with `CT_AUTH=key`.
3. Waits for the server's health check.
4. Mints one admin key, one write key, and one read key by running the
   `keys` CLI (spec3.md §C) *inside* the server container against its own
   `/data/context-trace.db` — not from the host. The host and the container
   see a bind-mounted SQLite file through different filesystem layers under
   Docker Desktop, and SQLite's WAL locking does not reliably survive that
   boundary; running the CLI in-container sidesteps it entirely. This was
   confirmed by testing: the driver-level "bind volume disguised as a named
   volume" approach failed outright (`SQLITE_CANTOPEN`) and even a working
   bind mount left writes invisible across the boundary when done from the
   host process, motivating this design.
5. Prints all three keys **exactly once**. They are hashed at rest; there is
   no way to recover them later. Revoke and re-mint if lost.
6. Writes `instances/<name>/README.md` with the exact `docker compose`
   invocations (with the right `-f`/`--env-file`/`-p` flags baked in) for
   status, logs, stop, upgrade, minting more keys, and backup.

Re-running against an existing instance (its `.env` already exists) never
reprovisions or mints new keys — it reports current container status and
reminds you how to mint additional keys if you need them.

## Operating an instance

See the generated `instances/<name>/README.md` for copy-pasteable commands
specific to that instance. In short, everything is a normal `docker compose`
invocation against `docker-compose.template.yml` with that instance's
`.env` and project name:

```sh
docker compose -f deploy/single-tenant/docker-compose.template.yml \
  --env-file deploy/single-tenant/instances/<name>/.env \
  -p ct-<name> <ps|logs|down|up -d --build|...>
```

**Backup** — checkpoint WAL, then copy the file out (safe with the instance
running):

```sh
docker compose ... exec -T server node -e \
  "import('./server/dist/db.js').then(({openDb}) => { \
     const db = openDb(process.env.CT_DB); db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); \
   })"
docker compose ... cp server:/data/context-trace.db ./backup-$(date +%Y%m%d).db
```

Or simpler (brief downtime, always correct): `docker compose ... down`, copy
`instances/<name>/data/context-trace.db` directly, `up -d`.

**Upgrade** — `git pull`, then `docker compose ... up -d --build`. Schema
migrations are guarded and run automatically at boot.

**Teardown** — `docker compose ... down -v` removes the containers, network,
and named volume; `rm -rf instances/<name>` removes the provisioning
artifacts (`.env`, generated README). The bind-mounted `data/` directory
holding the actual database is not touched by `down -v` — remove it
explicitly if you want the data gone too.

## The honest scaling ceiling

One SQLite writer per instance. Fine into the low millions of sections for
a single team; past that, or under concurrent high-throughput ingest,
provision additional instances (one per team/project) rather than expecting
one instance to grow indefinitely. See
[docs/SELF-HOSTING.md](../../docs/SELF-HOSTING.md#the-honest-scaling-ceiling).

## Notes

- `instances/` is created on first use and is git-ignored — it holds
  secrets (`.env`, mode 0600) and per-instance data, neither of which
  belongs in version control.
- `provision.sh` requires `docker` and the `docker compose` v2 plugin.
  Nothing else — key minting happens inside the container, not via a
  host-side Node/npm install.
