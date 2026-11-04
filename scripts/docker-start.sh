#!/bin/sh
# Container entrypoint: apply pending database migrations, then run the server in the foreground.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. The container needs Postgres (the embedded database is for development only)." >&2
  exit 1
fi

if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then
  echo "Applying database migrations..."
  node_modules/.bin/drizzle-kit migrate
fi

# exec + `node --import tsx` keeps a single node process, so tini's SIGTERM reaches the server directly.
exec node --import tsx src/index.ts
