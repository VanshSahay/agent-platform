#!/bin/sh
# Prove the latest backup restores: load it into a scratch database and count what came back. Run on the box, from deploy/.
set -eu
latest=$(docker compose exec -T backup sh -c 'ls -1t /backups/*.dump | head -1')
echo "restoring $latest"
docker compose exec -T backup sh -c "dropdb -h postgres -U agents --if-exists restore_check && createdb -h postgres -U agents restore_check && pg_restore -h postgres -U agents -d restore_check --no-owner $latest"
docker compose exec -T backup psql -h postgres -U agents -d restore_check -c "select (select count(*) from agents) agents, (select count(*) from runs) runs, (select count(*) from events) events"
docker compose exec -T backup dropdb -h postgres -U agents restore_check
echo "restore OK"
