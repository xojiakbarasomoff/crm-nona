#!/bin/sh
# Release qadami (migratsiya + idempotent demo seed), so‘ng worker (qayta ishga tushiruvchi sikl) va API.
set -e
npx prisma migrate deploy
if [ "$RUN_DEMO_SEED" = "true" ]; then
  npx tsx --conditions=development packages/database/src/seed.ts
fi
( while true; do node apps/worker/dist/main.js; echo "worker to‘xtadi, 3 s dan keyin qayta ishga tushadi" >&2; sleep 3; done ) &
exec node apps/api/dist/main.js
