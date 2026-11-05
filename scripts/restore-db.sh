#!/bin/sh
# Restore a backup into the compose database:  scripts/restore-db.sh backups/verity-XXXX.sql.gz
# DESTRUCTIVE: replaces the current contents of the `verity` database. Writers are stopped first.
set -e
[ -n "$1" ] && [ -f "$1" ] || { echo "usage: $0 <backup.sql.gz>" >&2; exit 1; }
docker compose stop api indexer frontend
docker compose exec -T postgres psql -U verity -d postgres -c "DROP DATABASE IF EXISTS verity WITH (FORCE)" -c "CREATE DATABASE verity"
gunzip -c "$1" | docker compose exec -T postgres psql -U verity -d verity -v ON_ERROR_STOP=1 -q
docker compose start api indexer frontend
echo "restored $1"
