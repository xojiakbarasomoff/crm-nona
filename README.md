# NONA Travel CRM (mustaqil)

Instagram Direct (va Lead Ads) → kontakt/lid → mas’ul menejer → taklif → sotuv → turizm buyurtmasi → ko‘p segmentli reyslar → tekshiruv eslatmalari → dashboard. CRM mustaqil ishlaydi: lid bosqichi, mas’ul, vazifalar va buyurtmalar shu tizimning o‘zida (PostgreSQL) boshqariladi, tashqi CRM kerak emas. Interfeys — rus tilida.

> **Holat:** demo rejimida ishlaydigan to‘liq vertikal oqim. Faqat Instagram Direct kiruvchi oqimi jonli tasdiqlangan; CRM’dan Instagram’ga javob yuborish va Lead Ads ulanmagan — `docs/feasibility.md`, `docs/acceptance-matrix.md`, `KNOWN_LIMITATIONS.md`. Production tayyor emas.

Asosiy hujjatlar: `docs/TZ.md` (shartnoma), `docs/tz-addendum-finance.md` (turoperatorlar, tannarx/foyda, hujjatlar), `docs/user-guide-finance.md` (yo‘riqnoma), `docs/implementation-plan.md`, `docs/decisions/`, `docs/integrations.md`, `docs/runbook.md`, `docs/openapi.json`.

## Tarkib

```
apps/api            NestJS HTTP API + webhook’lar; src/core — API va worker birgalikda ishlatadigan biznes modullari
apps/worker         inbox/outbox relay (BullMQ), DB scheduler, eskalatsiya, reconciliation, CLI’lar
apps/web            Next.js interfeys (rus tili)
packages/domain     sof biznes qoidalari (pul, telefon, matching, round-robin, voronka, vaqt zonasi, milestone, KPI, RBAC)
packages/integrations Meta Lead Ads/Direct, imzo, limiter, fayl xavfsizligi, demo adapterlar
packages/contracts  zod DTO va OpenAPI
packages/database   Prisma schema, migratsiyalar, seed, perf dataset
infra               Docker Compose, Dockerfile
tests               contract fixture’lar, integration (real PG/Redis), E2E (Playwright)
```

## Talablar

Node.js **22.12 yoki yangiroq** (tavsiya: `.nvmrc` dagi 22.23.4), npm 10, Docker Desktop.

Node mosligi: ilova (API, worker, web) Node 22.11 da ham ishga tushadi, lekin `npm ci`/`npm install` (Prisma 7 preinstall tekshiruvi), `npm run db:migrate`/`db:generate` (Prisma CLI ESM moduli `require` qiladi — Node 22.12+) va testlar 22.12+ talab qiladi. Windows’da yangilash: https://nodejs.org dan 22.x LTS o‘rnatuvchisi yoki `winget install OpenJS.NodeJS.LTS`. Portlar: PostgreSQL 55432, Redis 56379, API 4100, web 3100.

## Lokal ishga tushirish (demo)

```bash
cp .env.example .env
# ENCRYPTION_KEY va SESSION_SECRET ni to‘ldiring:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# demo uchun META_APP_SECRET, META_VERIFY_TOKEN ga ixtiyoriy lokal qiymat bering

npm ci
npm run dev:infra        # docker compose: postgres + redis
npm run db:generate
npm run db:migrate       # prisma migrate deploy
npm run db:seed          # sun’iy kompaniya, foydalanuvchilar, demo ulanishlar
npm run dev              # api :4100, worker, web :3100
```

Brauzer: http://localhost:3100. Demo foydalanuvchilar (**faqat demo**), parol `Demo-parol-2026!`:

| Email | Rol |
| --- | --- |
| admin@demo.local | Administrator (MFA majburiy; demo TOTP secret: `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`) |
| rahbar@demo.local | Rahbar (navbatchi mas’ul) |
| menejer.a@demo.local, menejer.b@demo.local, menejer.c@demo.local | Menejer |

Demo oqimini sinash: admin → Integratsiyalar → «DEMO simulyatorlari» (Lead Ads formasi, Direct xabar). Ular haqiqiy webhook yo‘li orqali sun’iy hodisa yuboradi.

Haqiqiy (demo bo‘lmagan) muhit: `APP_MODE=staging|production`, `npm run db:migrate`, `SEED_ALLOW_NON_DEMO=1 npm run db:seed` (faqat kompaniya va qoidalar), so‘ng birinchi admin: `npm run admin:invite -- --email=admin@kompaniya.uz --name="Ism Familiya"` → bir martalik havola, parol va MFA. Demo loginlar (`@demo.local`) bu rejimda ishlamaydi (`DEMO_SIMPLE_LOGIN=true` ham faqat `APP_MODE=demo` da ruxsat etilgan, aks holda API ishga tushmaydi; unda `admin`, `user1`, `user2` qisqa loginlari parol `123123123` bilan mavjud demo akkauntlarga ulanadi, admin uchun MFA so‘ralmaydi); bazada demo akkaunt bo‘lsa API/worker ishga tushmaydi.

Docker’da to‘liq stack: `docker compose -f infra/docker-compose.yml --profile app up --build` (oldin `.env` tayyorlang va migratsiyani bajaring).

## Buyruqlar

| Buyruq | Vazifa |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run typecheck` | barcha paketlar uchun `tsc` (oldin `npm run db:generate`) |
| `npm test` | unit + contract testlar |
| `npm run test:integration` | real PostgreSQL + Redis (har ishga tushishda yangi `crm_it_*` baza yaratiladi va o‘chiriladi) |
| `npm run test:services` | Haqiqiy SeaweedFS (S3) va ClamAV bilan testlar — avval `docker compose -f infra/docker-compose.yml --profile services up -d seaweedfs clamav` |
| `npm run storage:init` | `STORAGE_DRIVER=s3` uchun private bucket yaratish/tekshirish |
| `npm run test:e2e` | Playwright (api/worker/web’ni o‘zi ishga tushiradi yoki mavjudini ishlatadi) |
| `npm run build` | API/worker bundle (tsup) va Next.js build |
| `npm run db:migrate` / `npm run db:seed` | migratsiya / sun’iy seed |
| `npm run openapi` | `docs/openapi.json` ni qayta generatsiya |
| `npm run accounts:provision -- --phase=create` (JSON stdin) / `--phase=close-legacy` | ish akkauntlarini yaratish (parol faqat hash ko‘rinishida) va eski demo akkauntlarni yopish; `docs/runbook.md` |
| `PERF_DATABASE_URL=... npm run perf:seed` | TZ §22.1 yuk dataset’i |
| `npm run perf:measure` / `npm run perf:webhook` / `npm run perf:monitor` | API latency, webhook yuk sinovi va backlog monitori |
| `npm run admin:invite -- --email=... --name=...` | Birinchi administratorni yaratish (demo bo‘lmagan muhit) |
| `bash infra/pitr/drill.sh` | Lokal PITR mashqi (WAL arxivi → vaqt nuqtasiga tiklash) |
| `npm run dev:backend` | API + worker birga (E2E shu buyruq bilan ishga tushiradi) |

## Konfiguratsiya

`.env.example` — barcha guruhlar: runtime rejimi, DB/Redis, public URL, session/encryption secret, Meta (app secret, verify token, Graph versiyasi, login yo‘li, javob oynasi), object storage, worker intervallari, monitoring. Haqiqiy access tokenlar `.env` da saqlanmaydi — OAuth’dan keyin DB’da shifrlangan holda turadi. `APP_MODE=production` da mock adapter yoki `COOKIE_SECURE=false` bilan ishga tushish rad etiladi.

## Arxitektura qoidalari (qisqa)

- Lid bosqichi, mas’ul va vazifalar shu tizimda: o‘zgarish darhol qo‘llanadi, tarix (`lead_events`) va audit bilan. Rollar: Administrator, Menejer, Foydalanuvchi (faqat o‘qish). amoCRM integratsiyasi olib tashlangan (ADR 0001 tarixiy).
- Webhook: validatsiya → PostgreSQL inbox commit → ACK → async; Meta imzosi raw body bo‘yicha.
- Transactional outbox, unique biznes kalitlari, per-connection token refresh lock (row lock), umumiy Redis limiter.
- Timeout’dan keyin natija noaniq bo‘lsa blind retry yo‘q: reconcile yoki `unknown` + operator.
- Eslatmalar DB’da (ADR 0004); revision o‘zgarsa eski navbatdagi ish yon ta’sirsiz tashlanadi.
- Pul — minor unit (bigint) + ISO valyuta; UZS va USD hech qachon qo‘shilmaydi. Vaqt — UTC `timestamptz` + aeroport IANA zonasi.
- RBAC backend query darajasida; begona obyekt → 404.
