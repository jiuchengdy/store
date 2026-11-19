#!/bin/sh
# Scheduled logical backup for the GetCodex Plus store database.
#
# Runs on the Docker host (cron / systemd timer), not inside the app image:
# off-host copies and restore drills both need host-level docker access.
#
# A dump file alone is not a backup. Every run produces three artifacts:
#   <db>-<stamp>.dump          custom-format dump (compressed, selective restore)
#   <db>-<stamp>.dump.sha256   checksum recorded with a RELATIVE path so it survives rsync
#   <db>-<stamp>.dump.counts   row counts of money/user tables at dump time
# The .counts file is what lets the drill prove DATA survived, not just schema.
#
# Required env:
#   DB_CONTAINER   postgres container name             (default: store-postgres-1)
#   REMOTE         rsync target for the off-host copy  (e.g. ops@host:/srv/store-backups)
#                  unset => exit 3: a backup that never leaves the host is not a backup.
#                  Set ALLOW_LOCAL_ONLY=1 to accept a local-only run on purpose.
# Optional env:
#   PGUSER         database role                       (default: getgpt)
#   PGDATABASE     database name                       (default: getgpt)
#   BACKUP_DIR     host directory for dumps            (default: ./backups)
#   RETENTION_DAYS how long to keep local dumps        (default: 7)
#   KEEP_MIN       never prune below this many dumps   (default: 3)
#   COUNT_TABLES   space-separated tables to fingerprint
#
# Exit codes: 0 ok, 1 dump/validation failed, 2 off-host copy failed, 3 local-only.
set -eu

DB_CONTAINER="${DB_CONTAINER:-store-postgres-1}"
PGUSER="${PGUSER:-getgpt}"
PGDATABASE="${PGDATABASE:-getgpt}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
KEEP_MIN="${KEEP_MIN:-3}"
COUNT_TABLES="${COUNT_TABLES:-users wallets wallet_ledger orders payment_events withdrawals commissions inventory jobs}"

# Dumps carry PII, password hashes and encrypted payout accounts: never world-readable.
umask 077

log() { printf '%s backup: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker not found on PATH"
docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true \
  || fail "container $DB_CONTAINER is not running"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
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

# Row counts from the same live database. Without them the drill can only prove
# "the schema came back" — which an empty shell also satisfies.
COUNTS_TMP="${TARGET}.counts.tmp"
: > "$COUNTS_TMP"
for table in $COUNT_TABLES; do
  count="$(docker exec "$DB_CONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" -tAc \
    "select count(*) from \"${table}\"")" \
    || { rm -f "$COUNTS_TMP"; fail "could not count ${table}"; }
  printf '%s %s\n' "$table" "$count" >> "$COUNTS_TMP"
done

docker cp "${DB_CONTAINER}:${TMP_IN_CONTAINER}" "$TARGET" >/dev/null \
  || { rm -f "$COUNTS_TMP"; fail "docker cp failed"; }
[ -s "$TARGET" ] || { rm -f "$COUNTS_TMP"; fail "dump file is empty: $TARGET"; }
chmod 600 "$TARGET"

# A dump that pg_restore cannot even list is not a backup. Cheap structural check.
ENTRIES="$(docker exec "$DB_CONTAINER" pg_restore --list "$TMP_IN_CONTAINER" | grep -c ';')" \
  || fail "pg_restore --list failed on the new dump"
[ "${ENTRIES:-0}" -ge 50 ] || fail "dump has only ${ENTRIES:-0} TOC entries; refusing to call it a backup"

# Checksums must be written with a path that is still valid after rsync, otherwise
# the off-host copy carries a checksum file that can never be verified.
(
  cd "$BACKUP_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$NAME" > "${NAME}.sha256"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$NAME" > "${NAME}.sha256"
  else
    exit 1
  fi
) || fail "no sha256 tool available (sha256sum/shasum)"
chmod 600 "${TARGET}.sha256"

mv "$COUNTS_TMP" "${TARGET}.counts"
chmod 600 "${TARGET}.counts"

SIZE="$(wc -c < "$TARGET" | tr -d ' ')"
log "ok ${NAME} bytes=${SIZE} toc_entries=${ENTRIES} counted_tables=$(wc -l < "${TARGET}.counts" | tr -d ' ')"

# Prune: age-based, but never drop below KEEP_MIN so a quiet week cannot empty the directory.
# NB: `head -n -N` is a GNU extension that silently deletes nothing on macOS/BSD. Use tail.
PRUNE="$(find "$BACKUP_DIR" -name "${PGDATABASE}-*.dump" -type f -mtime "+${RETENTION_DAYS}" 2>/dev/null \
  | sort -r | tail -n "+$((KEEP_MIN + 1))")"
if [ -n "$PRUNE" ]; then
  printf '%s\n' "$PRUNE" | while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f "$old" "${old}.sha256" "${old}.counts"
    log "pruned $(basename "$old")"
  done
else
  log "prune: nothing older than ${RETENTION_DAYS}d beyond KEEP_MIN=${KEEP_MIN}"
fi

# Off-host copy. Without it every backup dies with the host.
if [ -n "${REMOTE:-}" ]; then
  command -v rsync >/dev/null 2>&1 || { log "OFFHOST=FAILED rsync not installed"; exit 2; }
  rsync -a --timeout=120 "$TARGET" "${TARGET}.sha256" "${TARGET}.counts" "$REMOTE/" \
    || { log "OFFHOST=FAILED target=${REMOTE}"; exit 2; }
  log "offhost=ok target=${REMOTE}"
elif [ "${ALLOW_LOCAL_ONLY:-0}" = "1" ]; then
  log "OFFHOST=missing (ALLOW_LOCAL_ONLY=1: accepted for this run)"
else
  log "OFFHOST=missing REMOTE is unset: backups exist only on this host"
  exit 3
fi
