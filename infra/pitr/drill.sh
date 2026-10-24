#!/usr/bin/env bash
# Local PITR drill: base backup + WAL archive → restore to a point in time before an "accident".
# Usage: bash infra/pitr/drill.sh            (needs Docker; uses its own compose project and volumes)
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows must not rewrite container paths
cd "$(dirname "$0")"
P="docker compose -f docker-compose.pitr.yml"
PSQL="$P exec -T pg-primary psql -U crm -d crm -v ON_ERROR_STOP=1 -At -c"

echo "== 1. fresh primary with archive_mode=on"
$P down -v >/dev/null 2>&1 || true
$P run --rm --no-deps -u root --entrypoint sh pg-primary -c 'chown postgres:postgres /wal-archive /base-backups' >/dev/null
$P up -d --wait pg-primary >/dev/null
$PSQL "SHOW archive_mode" | grep -q on

echo "== 2. schema + base backup"
$PSQL "CREATE TABLE drill (id serial PRIMARY KEY, phase text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp())"
$P exec -T -u postgres pg-primary sh -c 'rm -rf /base-backups/base && pg_basebackup -U crm -D /base-backups/base -Ft -z -X stream -c fast'

echo "== 3. writes before target, record target time, then the accident"
$PSQL "INSERT INTO drill (phase) SELECT 'before' FROM generate_series(1, 1000)"
sleep 2
TARGET=$($PSQL "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
sleep 2
$PSQL "INSERT INTO drill (phase) SELECT 'after' FROM generate_series(1, 500)"
$PSQL "DELETE FROM drill WHERE phase = 'before'"   # the accident to undo
NEEDED=$($PSQL "SELECT pg_walfile_name(pg_switch_wal())")
for i in $(seq 1 60); do
  FAILED=$($PSQL "SELECT failed_count FROM pg_stat_archiver")
  LAST=$($PSQL "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")
  [[ -n "$LAST" && ! "$LAST" < "$NEEDED" ]] && break; sleep 1
done
echo "needed_wal=$NEEDED"
echo "target=$TARGET last_archived=$LAST archive_failures=$FAILED"

echo "== 4. restore into a new data directory up to the target time"
START=$(date +%s)
docker volume rm -f turizm-crm-pitr_pitr_restore >/dev/null 2>&1 || true
docker run --rm -u root -v turizm-crm-pitr_pitr_base:/base-backups:ro -v turizm-crm-pitr_pitr_restore:/restore postgres:16.4-alpine sh -c "
  mkdir -p /restore/data && cd /restore/data && tar -xzf /base-backups/base/base.tar.gz &&
  mkdir -p pg_wal && tar -xzf /base-backups/base/pg_wal.tar.gz -C pg_wal &&
  touch recovery.signal &&
  printf \"restore_command = 'cp /wal-archive/%%f %%p'\nrecovery_target_time = '$TARGET'\nrecovery_target_action = 'promote'\n\" >> postgresql.auto.conf &&
  chown -R postgres:postgres /restore/data && chmod 700 /restore/data"
docker rm -f crm-pitr-restore >/dev/null 2>&1 || true
docker run -d --name crm-pitr-restore -e PGDATA=/restore/data -v turizm-crm-pitr_pitr_restore:/restore -v turizm-crm-pitr_pitr_wal:/wal-archive:ro postgres:16.4-alpine >/dev/null
for i in $(seq 1 120); do
  if docker exec crm-pitr-restore psql -U crm -d crm -At -c "SELECT pg_is_in_recovery()" 2>/dev/null | grep -q f; then break; fi
  sleep 1
done
END=$(date +%s)
BEFORE=$(docker exec crm-pitr-restore psql -U crm -d crm -At -c "SELECT count(*) FROM drill WHERE phase='before'")
AFTER=$(docker exec crm-pitr-restore psql -U crm -d crm -At -c "SELECT count(*) FROM drill WHERE phase='after'")
echo "restored: before=$BEFORE (expected 1000) after=$AFTER (expected 0) restore_seconds=$((END-START))"
docker logs crm-pitr-restore 2>&1 | grep -E "recovery stopping|archive recovery complete|database system is ready" | tail -3 || true

docker rm -f crm-pitr-restore >/dev/null
$P down -v >/dev/null
docker volume rm -f turizm-crm-pitr_pitr_restore >/dev/null
[ "$BEFORE" = "1000" ] && [ "$AFTER" = "0" ] && echo "PITR DRILL: PASSED" || { echo "PITR DRILL: FAILED"; exit 1; }
