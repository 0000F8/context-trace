#!/usr/bin/env bash
# Provision an isolated single-tenant context-trace instance: its own compose
# project, its own data directory, and freshly minted admin/write/read keys.
#
# Usage:
#   provision.sh <instance-name> [--port N] [--data-dir PATH] [--dry-run]
#
# See deploy/single-tenant/README.md for what this sets up and how to operate
# the resulting instance (backup, upgrade, teardown).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_TEMPLATE="${SCRIPT_DIR}/docker-compose.template.yml"

DEFAULT_PORT=8080
INSTANCE=""
PORT="${DEFAULT_PORT}"
DATA_DIR=""
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: provision.sh <instance-name> [--port N] [--data-dir PATH] [--dry-run]

  <instance-name>   Lowercase alphanumeric + hyphens, e.g. "acme" or "team-eu".
  --port N          Host port for the web UI (default: 8080).
  --data-dir PATH   Host directory to store this instance's SQLite data in
                     (default: deploy/single-tenant/instances/<name>/data).
  --dry-run         Print the plan without touching Docker or the filesystem.
EOF
}

fail() {
  echo "provision.sh: error: $*" >&2
  exit 1
}

# Generates the admin key ourselves, before first boot, rather than letting
# the server mint its own bootstrap admin key at boot. If we didn't: with
# CT_AUTH=key set and no CT_ADMIN_KEY, the server mints one on first boot AND
# prints its plaintext to stdout ("STORE THIS NOW") — which Docker's log
# driver then persists to disk forever, on top of whatever this script also
# hands the operator. That's two live admin keys per instance, one of them
# an untracked credential sitting in plaintext in container logs. Setting
# CT_ADMIN_KEY in .env before `up -d` makes the server take the env-supplied
# branch instead (auth.ts: hashed at boot, nothing printed, idempotent
# across restarts) — so there is exactly one admin key, and it's the one we
# hand the operator.
generate_admin_key() {
  local raw
  if command -v openssl >/dev/null 2>&1; then
    raw="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  elif [ -r /dev/urandom ]; then
    raw="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
  else
    fail "no entropy source available (need openssl or /dev/urandom) to generate the admin key"
  fi
  local key="cta_${raw}"
  # 47 chars expected (cta_ + 43-char base64url of 32 bytes) — comfortably
  # clears the >=32-char minimum the server enforces for CT_ADMIN_KEY. A
  # short result here means the entropy source misbehaved; fail loudly
  # rather than hand out a weak admin credential.
  if [ "${#key}" -lt 32 ]; then
    fail "generated admin key is only ${#key} chars (need >=32) — entropy source ('openssl rand' or /dev/urandom) may be broken"
  fi
  printf '%s' "${key}"
}

# ---- argument parsing -------------------------------------------------
if [ "$#" -eq 0 ]; then
  usage >&2
  exit 1
fi

INSTANCE="$1"
shift

case "${INSTANCE}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    fail "instance name is required"
    ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      [ "$#" -ge 2 ] || fail "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    --data-dir)
      [ "$#" -ge 2 ] || fail "--data-dir requires a value"
      DATA_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

## `case` globs treat `*` as "any characters, including `/`" — the earlier
## `[a-z0-9][a-z0-9-]*)` pattern accepted path-traversal payloads like
## `ab/../../../tmp/pwned` (and rejected legitimate 1-char names, since the
## two required leading classes need 2+ characters). A real anchored regex
## match doesn't have either problem.
if ! [[ "${INSTANCE}" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  fail "instance name must be lowercase alphanumeric and hyphens, starting with a letter or digit (got '${INSTANCE}')"
fi

case "${PORT}" in
  ''|*[!0-9]*) fail "--port must be a number (got '${PORT}')" ;;
esac

INSTANCE_DIR="${SCRIPT_DIR}/instances/${INSTANCE}"
if [ -z "${DATA_DIR}" ]; then
  DATA_DIR="${INSTANCE_DIR}/data"
fi
ENV_FILE="${INSTANCE_DIR}/.env"
README_OUT="${INSTANCE_DIR}/README.md"
PROJECT_NAME="ct-${INSTANCE}"
# Idempotency is gated on this marker, NOT on .env existing: .env is written
# early (the stack needs it to boot) but keys are minted after, so gating on
# .env alone would let a run that dies mid-provision (stack up, keys not yet
# minted) report "already provisioned" on retry and leave the instance with
# no keys and no signal that anything is wrong. The marker is only written
# once all three keys are minted and printed.
PROVISIONED_MARKER="${INSTANCE_DIR}/.provisioned"

# ---- dry run ------------------------------------------------------------
if [ "${DRY_RUN}" -eq 1 ]; then
  cat <<PLAN
Plan for instance '${INSTANCE}' (dry run — nothing was changed):

  1. Generate an admin key locally (openssl/urandom, cta_-prefixed, 47 chars).
  2. Create data directory:        ${DATA_DIR}
  3. Write instance env file:      ${ENV_FILE} (mode 0600)
       COMPOSE_PROJECT_NAME=${PROJECT_NAME}
       CT_INSTANCE=${INSTANCE}
       CT_WEB_PORT=${PORT}
       CT_DATA_DIR=${DATA_DIR}
       CT_AUTH=key
       CT_ADMIN_KEY=<generated in step 1>
     Setting CT_ADMIN_KEY before first boot matters: without it, the server
     would mint its own bootstrap admin key on first boot AND print its
     plaintext to stdout, which Docker's log driver persists forever — a
     second, untracked admin credential. Pre-supplying it makes the server
     take the "hash what I was given, print nothing" path instead.
  4. Boot the stack:
       docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} up -d --build
  5. Wait for the server container to report healthy.
  6. Mint a write key and a read key (the admin key already exists — see
     step 1) by running the keys CLI (spec3.md §C) inside the running server
     container, against its own /data/context-trace.db — not from the host,
     so there's no cross-process SQLite locking between the host and the
     container:
       docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} exec -T server node server/dist/keys-cli.js create-key default ${INSTANCE}-write write
       docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} exec -T server node server/dist/keys-cli.js create-key default ${INSTANCE}-read  read
  7. Print all three plaintext keys once. The write/read keys are never
     written to disk; the admin key already lives in ${ENV_FILE} (mode 0600)
     by design, so the server can re-verify it on every restart.
  8. Write instance notes:         ${README_OUT}
  9. Write a completion marker:    ${PROVISIONED_MARKER}

If instance '${INSTANCE}' is already fully provisioned (${PROVISIONED_MARKER}
exists), a real run reports its status instead of repeating any of the
above. If a previous run got partway (stack up, marker not yet written), a
real run resumes and completes it — including minting a fresh set of keys —
rather than reporting false success.
PLAN
  exit 0
fi

# ---- idempotency: report status instead of clobbering ---------------------
# Gated on the completion marker, not on .env — see its definition above for
# why: an interrupted run must be resumable, not mistaken for done.
if [ -f "${PROVISIONED_MARKER}" ]; then
  echo "Instance '${INSTANCE}' is already provisioned at ${INSTANCE_DIR}."
  echo "Not re-creating it or minting new keys (existing keys are shown only once, at creation time)."
  echo
  echo "Current status:"
  docker compose -f "${COMPOSE_TEMPLATE}" --env-file "${ENV_FILE}" -p "${PROJECT_NAME}" ps
  echo
  echo "To mint additional keys for this instance, run the keys CLI inside the container:"
  echo "  docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} exec -T server node server/dist/keys-cli.js create-key default <name> <read|write|admin>"
  exit 0
fi

if [ -f "${ENV_FILE}" ]; then
  echo "Instance '${INSTANCE}' has a partial provision from a previous run (no completion marker found) — resuming and completing it. This will mint a fresh set of keys; revoke any partially-minted ones from the earlier attempt once you've confirmed the new ones work." >&2
fi

command -v docker >/dev/null 2>&1 || fail "docker is required but was not found on PATH"
docker compose version >/dev/null 2>&1 || fail "'docker compose' (v2 plugin) is required but was not found"

# ---- fresh provision ------------------------------------------------------
mkdir -p "${DATA_DIR}"
mkdir -p "${INSTANCE_DIR}"

# Generated before the .env is written and before the stack boots — see
# generate_admin_key's comment for why this ordering is the whole point of
# the fix (it's what keeps the server from ever printing a bootstrap admin
# key to stdout).
ADMIN_KEY_OUT="$(generate_admin_key)"

umask 077
cat > "${ENV_FILE}" <<ENVFILE
COMPOSE_PROJECT_NAME=${PROJECT_NAME}
CT_INSTANCE=${INSTANCE}
CT_WEB_PORT=${PORT}
CT_DATA_DIR=${DATA_DIR}
CT_AUTH=key
CT_ADMIN_KEY=${ADMIN_KEY_OUT}
ENVFILE
chmod 600 "${ENV_FILE}"

echo "Booting instance '${INSTANCE}' (project ${PROJECT_NAME})..."
docker compose -f "${COMPOSE_TEMPLATE}" --env-file "${ENV_FILE}" -p "${PROJECT_NAME}" up -d --build

echo "Waiting for the server to become healthy..."
SERVER_CID="$(docker compose -f "${COMPOSE_TEMPLATE}" --env-file "${ENV_FILE}" -p "${PROJECT_NAME}" ps -q server)"
[ -n "${SERVER_CID}" ] || fail "could not find the server container after 'up -d'"

ATTEMPTS=0
MAX_ATTEMPTS=60
while true; do
  STATUS="$(docker inspect --format '{{.State.Health.Status}}' "${SERVER_CID}" 2>/dev/null || echo "unknown")"
  if [ "${STATUS}" = "healthy" ]; then
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "${ATTEMPTS}" -ge "${MAX_ATTEMPTS}" ]; then
    fail "server did not become healthy within ${MAX_ATTEMPTS} seconds (status: ${STATUS}). Check: docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} logs server"
  fi
  sleep 1
done

echo "Server is healthy. Minting write and read keys (admin key was generated locally in step 1, before boot)..."

mint_key() {
  # $1 = key name, $2 = role. Prints the plaintext key on stdout, extracted
  # from the CLI's human-readable output (`ct<role-letter>_...`).
  #
  # Runs *inside* the server container (spec3 §C's CLI, invoked directly as
  # compiled JS since the production image has tsx pruned along with the
  # rest of devDependencies) rather than from the host: the host and the
  # container reach this file through different filesystem layers under
  # Docker Desktop, and SQLite's WAL mode needs real POSIX locking that
  # doesn't survive that boundary — confirmed by testing (SQLITE_CANTOPEN /
  # writes invisible to the other side). Running the CLI in the same
  # container as the server sidesteps that entirely.
  local role_letter out key
  case "$2" in
    admin) role_letter=a ;;
    write) role_letter=w ;;
    read) role_letter=r ;;
    *) fail "internal error: unknown role $2" ;;
  esac
  if ! out="$(docker compose -f "${COMPOSE_TEMPLATE}" --env-file "${ENV_FILE}" -p "${PROJECT_NAME}" exec -T server node server/dist/keys-cli.js create-key default "$1" "$2" 2>&1)"; then
    fail "failed to mint the ${2} key via the keys CLI (spec3 §C: server/dist/keys-cli.js) running inside the server container. This provisioning script depends on it and will not silently continue without it. Output:
${out:-<none>}"
  fi
  # The CLI's output also prints a 12-char `prefix:` line, which matches
  # this same `ct<letter>_...` shape and would silently satisfy a bare
  # non-empty check if a future CLI output reordering put it before the
  # full key. Full keys are 47 chars (ct + role letter + '_' + 43-char
  # base64url of 32 random bytes); require a length safely above the
  # 12-char prefix so a wrong capture fails loudly instead of shipping a
  # truncated "key" that will never authenticate.
  key="$(printf '%s\n' "${out}" | grep -oE "ct${role_letter}_[A-Za-z0-9_-]+" | head -n1)"
  [ -n "${key}" ] || fail "minted a ${2} key but couldn't parse the plaintext key out of the CLI output. Raw output:
${out}"
  if [ "${#key}" -lt 40 ]; then
    fail "minted a ${2} key but the parsed value ('${key}', ${#key} chars) is too short to be the full plaintext key (expected 47) — likely captured the display prefix instead of the key. Raw output:
${out}"
  fi
  printf '%s' "${key}"
}

WRITE_KEY_OUT="$(mint_key "${INSTANCE}-write" write)"
READ_KEY_OUT="$(mint_key "${INSTANCE}-read" read)"

cat > "${README_OUT}" <<README
# context-trace instance: ${INSTANCE}

Provisioned $(date -u +"%Y-%m-%dT%H:%M:%SZ") by deploy/single-tenant/provision.sh.

- Web UI: http://localhost:${PORT}
- Compose project: ${PROJECT_NAME}
- Data directory: ${DATA_DIR}
- Auth mode: key (see docs/SELF-HOSTING.md)

## Operating this instance

Run these from the repo root, or \`cd\` into ${SCRIPT_DIR} first:

\`\`\`sh
# status
docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} ps

# logs
docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} logs -f server

# stop
docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} down

# upgrade (rebuild from current source, migrations run automatically on boot)
docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} up -d --build

# mint another key
docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} exec -T server node server/dist/keys-cli.js create-key default <name> <read|write|admin>

# backup (safe with the instance running — checkpoints WAL first so the
# copy is consistent, then copies the file out via docker compose cp):
docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} exec -T server \\
  node -e "import('./server/dist/db.js').then(({openDb}) => { const db = openDb(process.env.CT_DB); db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); })"
docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} cp server:/data/context-trace.db \\
  /somewhere/safe/${INSTANCE}-\$(date +%Y%m%d).db
\`\`\`

See docs/SELF-HOSTING.md for the full backup/restore and upgrade procedure.

## About the three keys

- **Admin key**: generated by provision.sh itself, *before* first boot, and
  stored in this instance's \`.env\` (mode 0600) as \`CT_ADMIN_KEY\` — the
  server hashes it at boot and re-verifies against that hash on every
  restart. This is intentional and is the only place it's saved; it is
  never printed to logs. If you need to see it again: \`grep CT_ADMIN_KEY
  ${ENV_FILE}\`.
- **Write and read keys**: minted via the CLI after boot, printed to your
  terminal once, and not stored anywhere by this script. If you lost one,
  revoke and re-mint via the CLI above or the admin API — see
  docs/SELF-HOSTING.md.
README

# Written last, only once the stack is up and all three keys are confirmed
# minted — this is the idempotency gate (see PROVISIONED_MARKER above).
date -u +"%Y-%m-%dT%H:%M:%SZ" > "${PROVISIONED_MARKER}"

echo
echo "=============================================================="
echo " Instance '${INSTANCE}' is up: http://localhost:${PORT}"
echo
echo " There is exactly one admin key for this instance — the one below."
echo " It's also saved in ${ENV_FILE} (mode 0600) as CT_ADMIN_KEY, so the"
echo " server can re-verify it on every restart; it is never printed to"
echo " container logs. The write and read keys are shown ONCE, right now,"
echo " and are not stored anywhere by this script — store all three now:"
echo
echo "   admin: ${ADMIN_KEY_OUT}"
echo "   write: ${WRITE_KEY_OUT}"
echo "   read:  ${READ_KEY_OUT}"
echo
echo " Instance notes written to: ${README_OUT}"
echo "=============================================================="
