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
- `metrics`: `webhook_count`, `signature_failures`, `inbox_retries`, `inbox_dead`, `outbox_retries`, `outbox_dead`, `provider_429`, `token_refresh_failures`;
- kechikkan eslatmalar, heartbeat yoshi.

Signal qoidalari (qo‘lda kuzatiladi; tashqi alerting yo‘q — KNOWN_LIMITATIONS): heartbeat > 90 s; outbox eng eski > 5 daq; `token_refresh_failures` o‘sishi; ketma-ket 429; `overdueReminders` > 0 (T-3h eskalatsiyasi rahbarga ilova bildirishnomasi sifatida avtomatik ketadi).

## 3. Replay va operator ishi

- `unknown` operatsiya (masalan, lid yaratish yoki Direct yuborish timeout): avval Instagram’da natijani tekshiring. «Xavfsiz replay» bir xil biznes kaliti bilan qayta navbatga qo‘yadi; handler avval `operation_id` bo‘yicha reconcile qiladi, topilmasa yaratadi. Direct xabar uchun replay — menejer qarori bilan qayta yuborish.
- `dead`: `lastError` ni o‘qing (validation/mapping xatosi). Sababni tuzatib, replay qiling.
- `paused`: connection uzilgan yoki 403/billing. Qayta ulangach paused operatsiyalar avtomatik `pending` ga qaytadi.
- Inbox `dead` hodisa: `POST /api/v1/integrations/inbox/{id}/replay`.

## 4. Instagram tokenini qayta ulash

1. `/integrations` → «Instagram akkauntini ulash / qayta ulash» (akkaunt egasi Instagram oynasida ruxsat beradi).
2. Ulanish tugagach connection `ok` / `degraded` holatida; sinov kiruvchi xabar kelgach «kiruvchi tasdiqlangan» ko‘rinadi.
3. Refresh xatosi bo‘lsa connection `degraded/token_refresh_failed` — qayta ulash talab etiladi. Tokenlar DB’da AES-256-GCM bilan shifrlangan (`ENCRYPTION_KEY`).

### Ish akkauntlari (Administrator / Menejer / Foydalanuvchi)

- Akkauntlar CLI orqali yaratiladi; parollar repoda, seed’da va ommaviy konfiguratsiyada saqlanmaydi: JSON stdin orqali beriladi, bazaga faqat argon2 hash yoziladi.
  `echo '{"accounts":[{"login":"...","fullName":"...","role":"ADMIN","password":"..."}]}' | npm run accounts:provision -- --phase=create`
- Kirish tekshirilgach: `npm run accounts:provision -- --phase=close-legacy` — eski `@demo.local` akkauntlar bloklanadi, sessiyalari bekor qilinadi, faol yozuvlar (lid, buyurtma, vazifa, kontakt, eslatma) birinchi haqiqiy administratorga o‘tadi. Tarixiy yozuvlar va audit o‘chirilmaydi; o‘zgargan satrlarning oldingi qiymatlari `_backup_cutover_20261026` jadvalida saqlanadi. Migratsiya `20261026000000` rollarni `ADMIN/MANAGER/USER` ga keltiradi; oldingi rollar `_backup_users_role_20261026` jadvalida.
- amoCRM integratsiyasi olib tashlangan: eski amoCRM outbox yozuvlari o‘chirilmaydi, ishlovchi ularni «amocrm_removed» natijasi bilan yopadi.

`ENCRYPTION_KEY` almashtirilsa barcha shifrlangan credential/MFA/inbox payload o‘qilmaydi — rotatsiya uchun qayta shifrlash skripti hali yo‘q (KNOWN_LIMITATIONS).

## 5. Deploy va rollback

- Migratsiyalar expand/contract: avval qo‘shimcha ustun/jadval (expand), kod ikkala sxemada ishlaydi, keyingi relizda eski ustunni olib tashlash (contract).
- Yangi migratsiya: `npx prisma migrate diff --from-migrations packages/database/prisma/migrations --to-schema-datamodel packages/database/prisma/schema.prisma --shadow-database-url <tmp> --script`; natijadan raw SQL obyektlarini (kompozit FK `*_fk`, partial index’lar, trigger’lar) o‘chiruvchi qatorlarni olib tashlang.
- Deploy’dan keyin outbox/inbox backlog DB’da saqlanadi va yangi worker davom ettiradi.

## 6. Backup va restore (PITR)

Maqsad: RPO ≤ 15 daq, RTO ≤ 4 soat.

Konfiguratsiya: `infra/pitr/postgresql.pitr.conf` (`wal_level=replica`, `archive_mode=on`, `archive_timeout=300` → RPO ≤ 5 daq + arxiv kechikishi). Production’da `archive_command` ni off-site, shifrlangan nishonga (wal-g/pgBackRest → object storage) yoki PITR yoqilgan boshqariladigan PostgreSQL’ga almashtiring; bazaviy backup kamida kuniga bir.

PITR tiklash tartibi:
1. Yangi (bo‘sh) data katalogiga oxirgi base backup’ni oching (`base.tar.gz`, `pg_wal.tar.gz`).
2. `postgresql.auto.conf`: `restore_command = 'cp /wal-archive/%f %p'` (yoki wal-g fetch), `recovery_target_time = '<UTC vaqt>'`, `recovery_target_action = 'promote'`; `recovery.signal` yarating.
3. PostgreSQL’ni ishga tushiring; logda `recovery stopping before ...` va `archive recovery complete` ni tekshiring.
4. Ilova: `migrate deploy` holati, so‘ng worker — u `reapplyTombstones` ni kunlik bajaradi (PII o‘chirishlar qayta qo‘llanadi); amoCRM reconciliation 10 daq overlap bilan yo‘qolgan o‘zgarishlarni oladi.

**Lokal PITR mashqi** (`bash infra/pitr/drill.sh`, 2026-10-24): base backup → 1000 yozuv → maqsad vaqt → 500 yozuv + 1000 tasini o‘chirish → maqsad vaqtga tiklash: `before=1000, after=0`, tiklash 4 s, `archive_failures=0` — `docs/perf/pitr-drill-last-run.txt`. **Sinalmagan:** off-site arxiv, haqiqiy hajmdagi RTO, boshqariladigan PostgreSQL’da PITR.

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

## 8. Fayllar, SLA, retention, PII

- Fayllar: staging/production’da `STORAGE_DRIVER=s3` majburiy (lokal disk faqat demo’da; aks holda ishga tushmaydi). Bucket private bo‘lsin (public ACL/policy yo‘q), versioning va server-side shifrlash provayderda yoqilsin, `npm run storage:init` bilan tekshiring. Yuklab olish bucket’dan to‘g‘ridan-to‘g‘ri emas — API orqali (sessiya + RBAC + 5 daqiqalik imzolangan havola + audit). Lokal S3: `docker compose ... --profile services up -d seaweedfs` (port 58333). Skaner: production’da `SCANNER=clamav` (lokal: `--profile services up -d clamav`, port 53310; birinchi ishga tushishda signaturalar bir necha daqiqa yuklanadi) (`CLAMD_HOST/PORT`) majburiy — builtin (faqat EICAR) demo’dan tashqarida ishga tushmaydi. Skan kutayotgan fayllar `/integrations` da; clamd ishlamasa fayl `pending` qoladi va ochilmaydi.
- SLA: worker har daqiqada; `SLA_WARN_MINUTES` (default 5). Buzilish rahbarga bildirishnoma, avtomatik qayta biriktirish yo‘q.
- Retention: admin `/integrations` → «Retention siyosatini tasdiqlash». Tasdiqlanmaguncha tozalash ishlamaydi (`not_confirmed_purge_disabled`). Texnik loglar muddati log infratuzilmasida sozlanadi.
- PII o‘chirish: mijoz kartasi → «Shaxsiy ma’lumotlarni o‘chirish» (admin). Natija: kontakt/identifikator/yozishma/yo‘lovchi/fayllar anonimlanadi, to‘lovlar saqlanadi, tombstone yoziladi, amoCRM/Instagram nusxalari uchun operator vazifasi ochiladi. Audit yozuvlari o‘zgarmaydi (siyosat bo‘yicha saqlanadi).
- Birinchi admin: `npm run admin:invite`.
