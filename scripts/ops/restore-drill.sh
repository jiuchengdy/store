#!/bin/sh
# Weekly restore drill: prove the newest backup can actually be restored — schema AND data.
#
# "A backup file exists" is not evidence, and neither is "db:verify passed":
# db:verify only compares structure, so a schema-only dump (all rows missing)
# passes it. This drill therefore does three things:
#   1. restores the dump into a throwaway database (--exit-on-error)
#   2. runs the project's own structure verifier (db:verify)
#   3. compares row counts against the .counts sidecar written at dump time
# Any of the three failing means the backup is not a backup.
#
# Required env:
#   DB_CONTAINER      postgres container name                 (default: store-postgres-1)
#   DRILL_BASE_URL    connection string with __DB__ placeholder
#                     (e.g. postgresql://getgpt@127.0.0.1:55439/__DB__)
# Optional env:
#   DUMP              explicit dump path (default: newest ${PGDATABASE}-*.dump in BACKUP_DIR)
#   BACKUP_DIR        where dumps live                        (default: ./backups)
#   PGUSER/PGDATABASE role / database name                    (default: getgpt)
#   PGPASSWORD        passed through to pg_restore when the role needs it
#   APP_IMAGE         when set, db:verify runs in this image instead of local bun
#   DRILL_NETWORK     docker network for APP_IMAGE mode       (default: store_backend)
#   DRILL_TOLERANCE   allowed row-count difference, for shops with constant writes (default: 0)
#
# Exit codes: 0 drill passed, 1 drill failed, 3 no dump found, 4 no counts sidecar,
#             5 restored but no inventory rows to prove the key against.
set -eu

DB_CONTAINER="${DB_CONTAINER:-store-postgres-1}"
PGUSER="${PGUSER:-getgpt}"
PGDATABASE="${PGDATABASE:-getgpt}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DRILL_BASE_URL="${DRILL_BASE_URL:-}"
DRILL_TOLERANCE="${DRILL_TOLERANCE:-0}"

log() { printf '%s drill: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

[ -n "$DRILL_BASE_URL" ] || fail "DRILL_BASE_URL is required (must contain __DB__)"
printf '%s' "$DRILL_BASE_URL" | grep -q '__DB__' || fail "DRILL_BASE_URL must contain the __DB__ placeholder"
command -v docker >/dev/null 2>&1 || fail "docker not found on PATH"

DUMP_PATH="${DUMP:-}"
if [ -z "$DUMP_PATH" ]; then
  DUMP_PATH="$(find "$BACKUP_DIR" -name "${PGDATABASE}-*.dump" -type f 2>/dev/null | sort | tail -1)"
fi
[ -n "$DUMP_PATH" ] && [ -f "$DUMP_PATH" ] || { log "no dump found in ${BACKUP_DIR}"; exit 3; }

COUNTS_FILE="${DUMP_PATH}.counts"
if [ ! -f "$COUNTS_FILE" ]; then
  log "no counts sidecar next to $(basename "$DUMP_PATH")"
  log "without it this drill can only prove the schema came back, not the data — refusing to pass"
  exit 4
fi

DRILL_DB="getgpt_drill_$(date -u '+%Y%m%d%H%M%S')"
DRILL_URL="$(printf '%s' "$DRILL_BASE_URL" | sed "s/__DB__/${DRILL_DB}/")"
IN_CONTAINER="/tmp/${DRILL_DB}.dump"

drop_drill_db() {
  docker exec "$DB_CONTAINER" dropdb -U "$PGUSER" --if-exists "$DRILL_DB" >/dev/null 2>&1 || true
  docker exec "$DB_CONTAINER" rm -f "$IN_CONTAINER" >/dev/null 2>&1 || true
}
trap drop_drill_db EXIT

SIZE="$(wc -c < "$DUMP_PATH" | tr -d ' ')"
log "restoring $(basename "$DUMP_PATH") bytes=${SIZE} into ${DRILL_DB}"

docker exec "$DB_CONTAINER" dropdb -U "$PGUSER" --if-exists "$DRILL_DB" >/dev/null 2>&1 || true
docker exec "$DB_CONTAINER" createdb -U "$PGUSER" "$DRILL_DB" || fail "createdb ${DRILL_DB}"
docker cp "$DUMP_PATH" "${DB_CONTAINER}:${IN_CONTAINER}" >/dev/null || fail "docker cp into container"

if ! docker exec -e PGPASSWORD="${PGPASSWORD:-}" "$DB_CONTAINER" \
     pg_restore -U "$PGUSER" -d "$DRILL_DB" --no-owner --no-privileges --exit-on-error "$IN_CONTAINER"; then
  fail "pg_restore reported errors"
fi

log "restore ok; running db:verify"

if [ -n "${APP_IMAGE:-}" ]; then
  docker run --rm --network "${DRILL_NETWORK:-store_backend}" \
    -e DATABASE_URL="$DRILL_URL" -e APP_MODE=demo -e APP_URL=http://localhost \
    "$APP_IMAGE" db:verify || fail "db:verify failed inside ${APP_IMAGE}"
else
  command -v bun >/dev/null 2>&1 || fail "neither APP_IMAGE nor bun available to run db:verify"
  DATABASE_URL="$DRILL_URL" bun scripts/verify-database.ts || fail "db:verify failed"
fi

# Data check: structure being right says nothing about rows surviving.
log "comparing row counts against $(basename "$COUNTS_FILE")"
MISMATCH=""
while read -r table expected; do
  [ -n "${table:-}" ] || continue
  actual="$(docker exec "$DB_CONTAINER" psql -U "$PGUSER" -d "$DRILL_DB" -tAc \
    "select count(*) from \"${table}\"")" || fail "could not count ${table} in ${DRILL_DB}"
  diff=$((actual - expected))
  [ "$diff" -lt 0 ] && diff=$((-diff))
  if [ "$diff" -gt "$DRILL_TOLERANCE" ]; then
    log "MISMATCH ${table} expected=${expected} restored=${actual}"
    MISMATCH="${MISMATCH} ${table}"
  else
    log "ok ${table} rows=${actual}"
  fi
done < "$COUNTS_FILE"

[ -z "$MISMATCH" ] || fail "row counts differ beyond tolerance ${DRILL_TOLERANCE}:${MISMATCH}"

# Third check: can the credentials actually be opened? Structure + row counts both
# pass on a backup whose ENCRYPTION_KEY no longer matches — every inventory code
# would be scrap while the drill printed PASS.
log "probing credentials with ENCRYPTION_KEY from this environment"
PROBE_STATUS=0
if [ -n "${APP_IMAGE:-}" ]; then
  docker run --rm --network "${DRILL_NETWORK:-store_backend}" \
    -e DATABASE_URL="$DRILL_URL" -e ENCRYPTION_KEY="${ENCRYPTION_KEY:-}" -e PROBE_ROWS="${PROBE_ROWS:-1}" \
    -e APP_MODE=demo -e APP_URL=http://localhost \
    "$APP_IMAGE" sh -c 'bun scripts/ops/verify-credentials.ts' || PROBE_STATUS=$?
else
  DATABASE_URL="$DRILL_URL" ENCRYPTION_KEY="${ENCRYPTION_KEY:-}" PROBE_ROWS="${PROBE_ROWS:-1}" \
    bun scripts/ops/verify-credentials.ts || PROBE_STATUS=$?
fi

case "$PROBE_STATUS" in
  0) ;;
  3) log "credentials unproven: no inventory rows in this backup — nothing was decrypted"
     log "RESULT=UNPROVEN $(basename "$DUMP_PATH") restored and counted, but the key was never exercised"
     exit 5 ;;
  *) fail "credential probe failed (status ${PROBE_STATUS}): ENCRYPTION_KEY cannot open this backup" ;;
esac

log "PASS $(basename "$DUMP_PATH") restored, structure verified, row counts match, credentials decrypt"
