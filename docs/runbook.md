# Runbook

## 1. Process’lar

| Process | Buyruq (prod) | Health |
| --- | --- | --- |
| API | `node apps/api/dist/main.js` | `GET /health` (liveness), `GET /ready` (DB + Redis) |
| Worker | `node apps/worker/dist/main.js` | `worker_heartbeats` (`worker`, `scheduler`) — `/integrations` sahifasida yoshi ko‘rinadi |
| Web | `node apps/web/server.js` (Next standalone) | `GET /login` |

Migratsiya alohida release qadami: `npx prisma migrate deploy --schema packages/database/prisma/schema.prisma`. Production’da `migrate reset`/`migrate dev` ishlatilmaydi.

## 2. Monitoring

`/integrations` (admin, rahbar) yoki `GET /api/v1/integrations/health`:
- connection holati, oxirgi webhook/sync, oxirgi xato;
- inbox/outbox holatlar bo‘yicha soni va eng eski kutayotgan yoshi (backlog);
- `metrics`: `webhook_count`, `signature_failures`, `inbox_retries`, `inbox_dead`, `outbox_retries`, `outbox_dead`, `provider_429`, `token_refresh_failures`, `sync_conflicts`;
- kechikkan eslatmalar, heartbeat yoshi.

Signal qoidalari (qo‘lda kuzatiladi; tashqi alerting yo‘q — KNOWN_LIMITATIONS): heartbeat > 90 s; outbox eng eski > 5 daq; `token_refresh_failures` o‘sishi; ketma-ket 429; `overdueReminders` > 0 (T-3h eskalatsiyasi rahbarga ilova bildirishnomasi sifatida avtomatik ketadi).

## 3. Replay va operator ishi

- `unknown` operatsiya (masalan, lid yaratish yoki Direct yuborish timeout): avval amoCRM/Instagram’da natijani tekshiring. «Xavfsiz replay» bir xil biznes kaliti bilan qayta navbatga qo‘yadi; handler avval `operation_id` bo‘yicha reconcile qiladi, topilmasa yaratadi. Direct xabar uchun replay — menejer qarori bilan qayta yuborish.
- `dead`: `lastError` ni o‘qing (validation/mapping xatosi). Sababni tuzatib (masalan, `npm run amo-config -- --apply`), replay qiling.
- `paused`: connection uzilgan yoki 403/billing. Qayta ulangach paused operatsiyalar avtomatik `pending` ga qaytadi.
- Inbox `dead` hodisa: `POST /api/v1/integrations/inbox/{id}/replay`.

## 4. amoCRM tokenni qayta ulash

1. `/integrations` → domenni kiriting (allowlist’da bo‘lishi shart) → «amoCRM’ni ulash / qayta ulash».
2. OAuth tugagach connection `ok`, paused operatsiyalar qayta ishlaydi.
3. Refresh xatosi bo‘lsa connection `paused/token_refresh_failed` — qayta ulash talab etiladi. Tokenlar DB’da AES-256-GCM bilan shifrlangan (`ENCRYPTION_KEY`).

`ENCRYPTION_KEY` almashtirilsa barcha shifrlangan credential/MFA/inbox payload o‘qilmaydi — rotatsiya uchun qayta shifrlash skripti hali yo‘q (KNOWN_LIMITATIONS).

## 5. Deploy va rollback

- Migratsiyalar expand/contract: avval qo‘shimcha ustun/jadval (expand), kod ikkala sxemada ishlaydi, keyingi relizda eski ustunni olib tashlash (contract).
- Yangi migratsiya: `npx prisma migrate diff --from-migrations packages/database/prisma/migrations --to-schema-datamodel packages/database/prisma/schema.prisma --shadow-database-url <tmp> --script`; natijadan raw SQL obyektlarini (kompozit FK `*_fk`, partial index’lar, trigger’lar) o‘chiruvchi qatorlarni olib tashlang.
- Deploy’dan keyin outbox/inbox backlog DB’da saqlanadi va yangi worker davom ettiradi.

## 6. Backup va restore

Maqsad: RPO ≤ 15 daq, RTO ≤ 4 soat — boshqariladigan PostgreSQL PITR yoki WAL arxivlash talab qilinadi (staging/prod infra’da hali sozlanmagan).

Lokal mashq (2026-10-24, AC35 qisman dalil):

```
docker exec turizm-crm-postgres-1 sh -c "pg_dump -U crm -Fc -d crm_perf -f /tmp/crm_perf.dump \
  && createdb -U crm crm_restore_drill && pg_restore -U crm -d crm_restore_drill -j 4 /tmp/crm_perf.dump"
```

Natija: dump 64 MB, umumiy 36 s; `leads` 100 000 / `messages` 1 020 490 / `audit_logs` / `_prisma_migrations` hisoblari manba bilan bir xil; `audit_logs` immutability trigger va partial unique indekslar tiklangan.

Restore’dan keyin: (1) `migrate deploy` holatini tekshiring; (2) worker’ni ishga tushiring — pending inbox/outbox va reminder’lar davom etadi; (3) amoCRM reconciliation checkpoint’i 10 daqiqalik overlap bilan yo‘qolgan o‘zgarishlarni qayta oladi; (4) PII o‘chirish tombstone’lari qayta qo‘llanadi (job hali yo‘q).

## 7. Lokal ishga tushirish muammolari

- Windows’da `prisma generate` EPERM: ishlab turgan api/worker query engine DLL’ni band qiladi — ularni to‘xtatib qayta ishga tushiring.
- 5432/3000 portlari band bo‘lishi mumkin: loyiha 55432 (PG), 56379 (Redis), 4100 (API), 3100 (web) ishlatadi.
