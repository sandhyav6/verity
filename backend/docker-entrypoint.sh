#!/bin/sh
# Container entrypoint.
#  * If DEPLOYMENT_FILE points at the JSON written by contracts/scripts/deploy.ts, export the contract
#    addresses and start block from it (variables that are already set are NOT overridden).
#  * If RUN_MIGRATIONS=1, apply database migrations first (only the API service does this).
set -e

if [ -n "$DEPLOYMENT_FILE" ]; then
  if [ ! -f "$DEPLOYMENT_FILE" ]; then
    echo "DEPLOYMENT_FILE=$DEPLOYMENT_FILE does not exist (has the deployer run?)" >&2
    exit 1
  fi
  eval "$(python -m app.tools.load_deployment "$DEPLOYMENT_FILE")"
fi

if [ "$RUN_MIGRATIONS" = "1" ]; then
  echo "applying database migrations"
  alembic upgrade head
fi

exec "$@"
