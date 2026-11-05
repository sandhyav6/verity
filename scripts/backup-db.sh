#!/bin/sh
# Dump the compose PostgreSQL database to backups/verity-<UTC timestamp>.sql.gz  (run from the repository root).
set -e
mkdir -p backups
out="backups/verity-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker compose exec -T postgres pg_dump -U verity --no-owner verity | gzip > "$out"
echo "wrote $out ($(wc -c < "$out") bytes)"
