# Turizm CRM (amoCRM asosida)

Instagram Lead Ads va Direct → kontakt/lid → mas’ul menejer → taklif → sotuv → turizm buyurtmasi → ko‘p segmentli reyslar → tekshiruv eslatmalari → dashboard. Mijoz va sotuv uchun asosiy tizim — amoCRM; turizm buyurtmasi, segmentlar, eslatmalar, audit va analitik proyeksiya — PostgreSQL.

> **Holat:** demo rejimida ishlaydigan to‘liq vertikal oqim. Real amoCRM/Meta integratsiyasi live tasdiqlanmagan — `docs/feasibility.md`, `docs/acceptance-matrix.md`, `KNOWN_LIMITATIONS.md`. Production tayyor emas.

Asosiy hujjatlar: `docs/TZ.md` (shartnoma), `docs/implementation-plan.md`, `docs/decisions/`, `docs/integrations.md`, `docs/runbook.md`, `docs/openapi.json`.

## Tarkib

```
apps/api            NestJS HTTP API + webhook’lar; src/core — API va worker birgalikda ishlatadigan biznes modullari
apps/worker         inbox/outbox relay (BullMQ), DB scheduler, eskalatsiya, reconciliation, CLI’lar
apps/web            Next.js interfeys (o‘zbek lotin)
packages/domain     sof biznes qoidalari (pul, telefon, matching, round-robin, voronka, vaqt zonasi, milestone, KPI, RBAC)
packages/integrations amoCRM REST/OAuth, amoCRM Chats, Meta Lead Ads/Direct, imzo, limiter, demo adapterlar
packages/contracts  zod DTO va OpenAPI
packages/database   Prisma schema, migratsiyalar, seed, perf dataset
infra               Docker Compose, Dockerfile
tests               contract fixture’lar, integration (real PG/Redis), E2E (Playwright)
```

## Talablar

Node.js 22.11+ (LTS), npm 10, Docker Desktop. Portlar: PostgreSQL 55432, Redis 56379, API 4100, web 3100.

## Lokal ishga tushirish (demo)

```bash
cp .env.example .env
# ENCRYPTION_KEY va SESSION_SECRET ni to‘ldiring:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# demo uchun META_APP_SECRET, META_VERIFY_TOKEN, AMO_CHAT_SECRET ga ixtiyoriy lokal qiymat bering

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

Docker’da to‘liq stack: `docker compose -f infra/docker-compose.yml --profile app up --build` (oldin `.env` tayyorlang va migratsiyani bajaring).

## Buyruqlar

| Buyruq | Vazifa |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run typecheck` | barcha paketlar uchun `tsc` (oldin `npm run db:generate`) |
| `npm test` | unit + contract testlar |
| `npm run test:integration` | real PostgreSQL + Redis (har ishga tushishda yangi `crm_it_*` baza yaratiladi va o‘chiriladi) |
| `npm run test:e2e` | Playwright (api/worker/web’ni o‘zi ishga tushiradi yoki mavjudini ishlatadi) |
| `npm run build` | API/worker bundle (tsup) va Next.js build |
| `npm run db:migrate` / `npm run db:seed` | migratsiya / sun’iy seed |
| `npm run openapi` | `docs/openapi.json` ni qayta generatsiya |
| `npm run amo-config [-- --apply]` | amoCRM voronka/maydonlarini tekshirish (dry-run) yoki yaratish |
| `npm run smoke:live` | G01–G09 live sinovlari (credential bo‘lmasa `blocked`) |
| `PERF_DATABASE_URL=... npm run perf:seed` | TZ §22.1 yuk dataset’i |
| `npm run perf:measure` / `npm run perf:webhook` | API va webhook latency o‘lchovi |

## Konfiguratsiya

`.env.example` — barcha guruhlar: runtime rejimi, DB/Redis, public URL, session/encryption secret, amoCRM REST OAuth, amoCRM Chats kanali (alohida auth), Meta (app secret, verify token, Graph versiyasi, login yo‘li, javob oynasi), object storage, worker intervallari, monitoring. Haqiqiy access tokenlar `.env` da saqlanmaydi — OAuth’dan keyin DB’da shifrlangan holda turadi. `APP_MODE=production` da mock adapter yoki `COOKIE_SECURE=false` bilan ishga tushish rad etiladi.

## Arxitektura qoidalari (qisqa)

- amoCRM — kontakt/lid/status/mas’ul egasi; web’dagi bosqich o‘zgarishi outbox orqali amoCRM’ga yuboriladi va tasdiqlangach proyeksiyaga qo‘llanadi (ADR 0001).
- Webhook: validatsiya → PostgreSQL inbox commit → ACK → async; Meta imzosi raw body bo‘yicha.
- Transactional outbox, unique biznes kalitlari, per-connection token refresh lock (row lock), umumiy Redis limiter.
- Timeout’dan keyin natija noaniq bo‘lsa blind retry yo‘q: reconcile yoki `unknown` + operator.
- Eslatmalar DB’da (ADR 0004); revision o‘zgarsa eski navbatdagi ish yon ta’sirsiz tashlanadi.
- Pul — minor unit (bigint) + ISO valyuta; UZS va USD hech qachon qo‘shilmaydi. Vaqt — UTC `timestamptz` + aeroport IANA zonasi.
- RBAC backend query darajasida; begona obyekt → 404.
