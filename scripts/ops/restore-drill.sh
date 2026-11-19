#!/bin/sh
# Weekly restore drill: prove the newest backup can actually be restored.
#
# "A backup file exists" is not evidence. This restores the dump into a throwaway
# database and runs the project's own structure verifier (db:verify) against it.
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
#
# Exit codes: 0 drill passed, 1 drill failed, 3 no dump found.
set -eu

DB_CONTAINER="${DB_CONTAINER:-store-postgres-1}"
PGUSER="${PGUSER:-getgpt}"
PGDATABASE="${PGDATABASE:-getgpt}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DRILL_BASE_URL="${DRILL_BASE_URL:-}"

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

log "PASS $(basename "$DUMP_PATH") restored and verified"
