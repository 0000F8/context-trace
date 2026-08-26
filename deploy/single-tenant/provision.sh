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

case "${INSTANCE}" in
  [a-z0-9][a-z0-9-]*) ;;
  *) fail "instance name must be lowercase alphanumeric and hyphens, starting with a letter or digit (got '${INSTANCE}')" ;;
esac

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

# ---- dry run ------------------------------------------------------------
if [ "${DRY_RUN}" -eq 1 ]; then
  cat <<PLAN
Plan for instance '${INSTANCE}' (dry run — nothing was changed):

  1. Create data directory:        ${DATA_DIR}
  2. Write instance env file:      ${ENV_FILE} (mode 0600)
       COMPOSE_PROJECT_NAME=${PROJECT_NAME}
       CT_INSTANCE=${INSTANCE}
       CT_WEB_PORT=${PORT}
       CT_DATA_DIR=${DATA_DIR}
       CT_AUTH=key
  3. Boot the stack:
       docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} up -d --build
  4. Wait for the server container to report healthy.
  5. Mint three keys by running the keys CLI (spec3.md §C) inside the running
     server container, against its own /data/context-trace.db — not from the
     host, so there's no cross-process SQLite locking between the host and
     the container:
       docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} exec -T server node server/dist/keys-cli.js create-key default ${INSTANCE}-admin admin
       docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} exec -T server node server/dist/keys-cli.js create-key default ${INSTANCE}-write write
       docker compose -f ${COMPOSE_TEMPLATE} --env-file ${ENV_FILE} -p ${PROJECT_NAME} exec -T server node server/dist/keys-cli.js create-key default ${INSTANCE}-read  read
  6. Print the three plaintext keys once (never written to disk).
  7. Write instance notes:         ${README_OUT}

If instance '${INSTANCE}' is already provisioned (${ENV_FILE} exists), a
real run reports its status instead of repeating any of the above.
PLAN
  exit 0
fi

# ---- idempotency: report status instead of clobbering --------------------
if [ -f "${ENV_FILE}" ]; then
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

command -v docker >/dev/null 2>&1 || fail "docker is required but was not found on PATH"
docker compose version >/dev/null 2>&1 || fail "'docker compose' (v2 plugin) is required but was not found"

# ---- fresh provision ------------------------------------------------------
mkdir -p "${DATA_DIR}"
mkdir -p "${INSTANCE_DIR}"

umask 077
cat > "${ENV_FILE}" <<ENVFILE
COMPOSE_PROJECT_NAME=${PROJECT_NAME}
CT_INSTANCE=${INSTANCE}
CT_WEB_PORT=${PORT}
CT_DATA_DIR=${DATA_DIR}
CT_AUTH=key
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

echo "Server is healthy. Minting keys..."

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
  key="$(printf '%s\n' "${out}" | grep -oE "ct${role_letter}_[A-Za-z0-9_-]+" | head -n1)"
  [ -n "${key}" ] || fail "minted a ${2} key but couldn't parse the plaintext key out of the CLI output. Raw output:
${out}"
  printf '%s' "${key}"
}

ADMIN_KEY_OUT="$(mint_key "${INSTANCE}-admin" admin)"
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

Keys were printed once at provisioning time and are not stored anywhere by
this script. If you lost them, revoke and re-mint via the CLI above or the
admin API — see docs/SELF-HOSTING.md.
README

echo
echo "=============================================================="
echo " Instance '${INSTANCE}' is up: http://localhost:${PORT}"
echo
echo " Store these keys now — they will not be shown again:"
echo
echo "   admin: ${ADMIN_KEY_OUT}"
echo "   write: ${WRITE_KEY_OUT}"
echo "   read:  ${READ_KEY_OUT}"
echo
echo " Instance notes written to: ${README_OUT}"
echo "=============================================================="
