#!/bin/sh
# Release qadami (migratsiya + idempotent demo seed), so‘ng worker (qayta ishga tushiruvchi sikl) va API.
set -e
npx prisma migrate deploy
if [ "$RUN_DEMO_SEED" = "true" ]; then
  npx tsx --conditions=development packages/database/src/seed.ts
fi
# Bir martalik akkaunt amallari (parollar repoda emas: faqat vaqtincha Railway o'zgaruvchisida; amaldan keyin o'zgaruvchi o'chiriladi).
if [ -n "$PROVISION_ACCOUNTS_JSON" ]; then
  printf '%s' "$PROVISION_ACCOUNTS_JSON" | npx tsx --conditions=development apps/worker/src/cli/provision-accounts.ts --phase=create || echo "accounts:provision create xatosi" >&2
fi
if [ "$PROVISION_CLOSE_LEGACY" = "true" ]; then
  npx tsx --conditions=development apps/worker/src/cli/provision-accounts.ts --phase=close-legacy || echo "accounts:provision close-legacy xatosi" >&2
fi
( while true; do node apps/worker/dist/main.js; echo "worker to‘xtadi, 3 s dan keyin qayta ishga tushadi" >&2; sleep 3; done ) &
exec node apps/api/dist/main.js
