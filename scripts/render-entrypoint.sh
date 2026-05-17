#!/bin/sh
set -e

echo "[entrypoint] prisma db push (sync schema to database)"
npx prisma db push --skip-generate

if [ "$SEED_ON_START" = "true" ]; then
  echo "[entrypoint] SEED_ON_START=true → running db seed (DESTRUCTIVE: wipes seed-owned tables)"
  npm run db:seed
else
  echo "[entrypoint] SEED_ON_START not set → skipping seed"
fi

echo "[entrypoint] starting server"
exec node dist/server.js
