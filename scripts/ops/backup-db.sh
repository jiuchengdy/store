#!/bin/sh
# Scheduled logical backup for the GetCodex Plus store database.
#
# Runs on the Docker host (cron / systemd timer), not inside the app image:
# off-host copies and restore drills both need host-level docker access.
#
# Required env:
#   DB_CONTAINER   postgres container name            (default: store-postgres-1)
# Optional env:
#   PGUSER         database role                      (default: getgpt)
#   PGDATABASE     database name                      (default: getgpt)
#   BACKUP_DIR     host directory for dumps           (default: ./backups)
#   RETENTION_DAYS how long to keep local dumps       (default: 7)
#   REMOTE         rsync target for the off-host copy (e.g. ops@192.168.0.1:/srv/store-backups)
#                  when unset, the script still succeeds but prints OFFHOST=missing
#   KEEP_MIN       never prune below this many dumps  (default: 3)
#
# Exit codes: 0 ok, 1 dump/validation failed, 2 off-host copy failed.
set -eu

DB_CONTAINER="${DB_CONTAINER:-store-postgres-1}"
PGUSER="${PGUSER:-getgpt}"
PGDATABASE="${PGDATABASE:-getgpt}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
KEEP_MIN="${KEEP_MIN:-3}"

log() { printf '%s backup: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker not found on PATH"
docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true \
  || fail "container $DB_CONTAINER is not running"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
NAME="${PGDATABASE}-${STAMP}.dump"
TMP_IN_CONTAINER="/tmp/${NAME}"
TARGET="${BACKUP_DIR}/${NAME}"

cleanup() { docker exec "$DB_CONTAINER" rm -f "$TMP_IN_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# -Fc = custom format: compressed, selective restore, verifiable with pg_restore --list.
log "dumping ${PGDATABASE} from ${DB_CONTAINER}"
docker exec "$DB_CONTAINER" pg_dump -U "$PGUSER" -d "$PGDATABASE" -Fc -f "$TMP_IN_CONTAINER" \
  || fail "pg_dump returned non-zero"
docker cp "${DB_CONTAINER}:${TMP_IN_CONTAINER}" "$TARGET" >/dev/null \
  || fail "docker cp failed"

[ -s "$TARGET" ] || fail "dump file is empty: $TARGET"

# A dump that pg_restore cannot even list is not a backup. Cheap structural check.
ENTRIES="$(docker exec "$DB_CONTAINER" pg_restore --list "$TMP_IN_CONTAINER" 2>/dev/null | grep -c ';' || true)"
[ "${ENTRIES:-0}" -ge 50 ] || fail "dump has only ${ENTRIES:-0} TOC entries; refusing to call it a backup"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$TARGET" > "${TARGET}.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$TARGET" > "${TARGET}.sha256"
fi

SIZE="$(wc -c < "$TARGET" | tr -d ' ')"
log "ok ${NAME} bytes=${SIZE} toc_entries=${ENTRIES}"

# Prune: age-based, but never drop below KEEP_MIN so a quiet week cannot empty the directory.
if [ -d "$BACKUP_DIR" ]; then
  find "$BACKUP_DIR" -name "${PGDATABASE}-*.dump" -type f -mtime "+${RETENTION_DAYS}" 2>/dev/null \
    | sort | head -n -"${KEEP_MIN}" 2>/dev/null \
    | while IFS= read -r old; do
        [ -n "$old" ] || continue
        rm -f "$old" "${old}.sha256"
        log "pruned $(basename "$old")"
      done || true
fi

# Off-host copy. Without it every backup dies with the host.
if [ -n "${REMOTE:-}" ]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --timeout=120 "$TARGET" "${TARGET}.sha256" "$REMOTE/" \
      || { log "OFFHOST=FAILED target=${REMOTE}"; exit 2; }
    log "offhost=ok target=${REMOTE}"
  else
    log "OFFHOST=FAILED rsync not installed"
    exit 2
  fi
else
  log "OFFHOST=missing (set REMOTE to copy dumps off this host)"
fi
