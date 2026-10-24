# Acceptance matrix (AC01–AC36)

Oxirgi yangilanish: 2026-10-24 · TZ §23

Har bir ssenariy uchun uch xil daraja **alohida** ko‘rsatiladi:

| Ustun | Ma’nosi |
| --- | --- |
| **Kod** | ✅ talab bo‘yicha implement qilingan · 🟡 qisman · ❌ yo‘q |
| **Mock bilan sinalgan** | Tashqi provayder o‘rniga demo adapter yoki sintetik contract fixture ishlatilgan avtomatik test. *Provayder xatti-harakatini isbotlamaydi.* |
| **Haqiqiy xizmatda sinalgan** | Haqiqiy dasturiy xizmat ustida bajarilgan sinov. Ichki: PostgreSQL 16, Redis 7, SeaweedFS (S3), ClamAV, Chrome. Tashqi: **amoCRM / Meta — hech biri sinalmagan (⛔, credential yo‘q)** |

Test to‘plamlari (2026-10-24, Node 22.23.4, Prisma 7.10.1): unit + contract **75**; integration **86** (haqiqiy PG/Redis, har ishga tushishda yangi baza); services **12** (haqiqiy SeaweedFS + ClamAV, `npm run test:services`); E2E **6** (Chrome). Hammasi o‘tdi; `npm audit` 0.

## Ssenariylar

| ID | Ssenariy | Kod | Mock bilan sinalgan | Haqiqiy xizmatda sinalgan |
| --- | --- | --- | --- | --- |
| AC01 | Yangi Lead Ads formasi | ✅ | ✅ `intake.test.ts` › AC01 (demo Meta/amoCRM) | PG/Redis ✅ · Meta/amoCRM ⛔ (G04) |
| AC02 | Bir hodisa 10 marta | ✅ | ✅ `intake.test.ts` › AC02; backfill+webhook dedupe | PG/Redis ✅ (dedupe DB unique kalit bilan) · Meta ⛔ |
| AC03 | Parallel kanal, bir telefon | ✅ | ✅ `intake.test.ts` › AC03 (×2) | PG ✅ (advisory lock, partial unique) |
| AC04 | Umumiy oilaviy telefon | ✅ | ✅ unit + `intake.test.ts` › AC04 | PG ✅ |
| AC05 | Direct yangi va davomiy suhbat | ✅ | ✅ `intake.test.ts` › AC05 | PG/Redis ✅ · Meta/Chats ⛔ (G05, G08) |
| AC06 | amoCRM ichidan inson javobi | ✅ | ✅ `intake.test.ts` › AC06 (demo Send API) | **⛔ Instagram’da qabul qilinishi sinalmagan (G06)** |
| AC07 | Javob oynasi yopiq | ✅ | ✅ unit + `intake.test.ts` › AC07 | PG ✅ · oyna uzunligi Meta’da ⛔ (G07) |
| AC08 | Click-to-Direct | ✅ | ✅ `intake.test.ts` › AC08 (sintetik referral) | PG ✅ · Meta ⛔ (G09) |
| AC09 | Kampaniya metadata olinmaydi | ✅ | ✅ `intake.test.ts` › AC09 | PG ✅ · Meta ⛔ |
| AC10 | 3 menejer, 100 parallel lid | ✅ | ✅ `amo-sync.test.ts` › AC10 | PG ✅ — CPU yuklamasi ostida 5/5 (sabab va tuzatish: `docs/perf/ac10-root-cause.md`) |
| AC11 | Faol menejer yo‘q | ✅ | ✅ `amo-sync.test.ts` › AC11 | PG ✅ |
| AC12 | Begona mijoz ID’si (API, fayl, SSE, eksport) | ✅ | — (provayder ishtirok etmaydi) | PG/Redis ✅ `rbac-auth`, `compliance` (fayl), `sse.test.ts`; S3 ✅ `services`; Chrome ✅ E2E · amoCRM native rollari ⛔ |
| AC13 | Native amoCRM’da mas’ul o‘zgaradi | ✅ | ✅ `amo-sync.test.ts` › AC13 (demo amoCRM) | PG ✅ · amoCRM ⛔ |
| AC14 | Native statusda maydon yetishmaydi | ✅ | ✅ `amo-sync.test.ts` › AC14 | PG ✅ · amoCRM ⛔ |
| AC15 | WON va takroriy webhook | ✅ | ✅ `amo-sync.test.ts` › AC15 | PG ✅ · amoCRM ⛔ |
| AC16 | Borish, ulanish, qaytish | ✅ | — | PG ✅ `travel.test.ts`; Chrome ✅ E2E |
| AC17 | Boshqa zona va DST | ✅ | — | unit + PG ✅ `travel.test.ts` › AC17 |
| AC18 | 168/72/24/3h milestone | ✅ | ✅ CRM vazifa demo amoCRM’da | PG ✅ · amoCRM vazifa ⛔ |
| AC19 | Uchishga 2 soat qolganda | ✅ | — | PG ✅ |
| AC20 | Oldingi milestone tekshirilgan | ✅ | — | PG ✅; Chrome ✅ E2E |
| AC21 | Reys jadvali o‘zgaradi | ✅ | — | PG ✅ (×2) |
| AC22 | Reys yoki order bekor | ✅ | ✅ CRM vazifa yopish demo’da | PG ✅ |
| AC23 | CRM vazifasi natijasiz yopiladi | ✅ | ✅ demo amoCRM | PG ✅ · amoCRM ⛔ |
| AC24 | Recurring va snooze | ✅ | — | PG ✅ |
| AC25 | Worker yoki Redis qayta ishga tushadi | ✅ | — | PG/Redis ✅ `travel.test.ts` › AC25, `redis-outage.test.ts` |
| AC26 | DB ishlamaydi va webhook keladi | ✅ | — | ✅ haqiqiy ulanib bo‘lmaydigan PG bilan 5xx |
| AC27 | 429 yoki 5xx | ✅ | ✅ demo xato in’eksiyasi; contract (401→refresh) | PG/Redis ✅ · amoCRM limit javobi ⛔ |
| AC28 | Parallel OAuth refresh | ✅ | ✅ soxta token endpoint | PG ✅ (row lock) · amoCRM ⛔ (G02) |
| AC29 | Lid yaratish timeout | ✅ | ✅ demo timeout/reconcile | PG ✅ · amoCRM ⛔ |
| AC30 | Tartibsiz eski status | ✅ | ✅ demo snapshot | PG ✅ |
| AC31 | UZS va USD | ✅ | — | unit + PG ✅ |
| AC32 | Kohorta vs yopilganlar | ✅ | — | unit |
| AC33 | Bot, keyin inson javobi | ✅ | — | unit (bot integratsiyasi yo‘q) |
| AC34 | Integration o‘chiriladi | ✅ | ✅ demo amoCRM | PG ✅ |
| AC35 | Backup restore | 🟡 (prod arxiv konfiguratsiyasi namunaviy) | — | PG ✅ lokal PITR mashqi (`infra/pitr/drill.sh`, 1000/0, 4 s) va `pg_dump` (1M xabar, 36 s) · **off-site arxiv / prod RTO ⛔** |
| AC36 | Staging end-to-end | ✅ (lokal) | ✅ demo provayderlar bilan E2E | Chrome + PG/Redis ✅ lokal · **staging va real akkauntlar ⛔** |

## Qo‘shimcha talablar

| Talab (TZ) | Kod | Mock bilan sinalgan | Haqiqiy xizmatda sinalgan |
| --- | --- | --- | --- |
| Private object storage (§21) | ✅ S3 adapter (+ lokal faqat demo) | contract (storage primitivlari) | **SeaweedFS S3 ✅** (`services`: round-trip, anonim o‘qish rad etiladi, noto‘g‘ri kalit rad etiladi, readiness) · bulutli S3/R2 ⛔ |
| Virus tekshiruvi (§21) | ✅ clamd INSTREAM | contract (soxta clamd) | **ClamAV 1.4.3 ✅** (`services`: haqiqiy EICAR imzosi, arxiv ichida, 300 KB+, toza fayl) |
| Fayl oqimi: yuklash → skan → karantin → imzolangan yuklab olish | ✅ | `compliance.test.ts` (builtin skaner) | **S3 + ClamAV ✅** (`services` E2E ×2); Chrome ✅ E2E (lokal storage) |
| SLA signallari (§10) | ✅ | — | PG ✅ `compliance.test.ts` |
| Retention va PII o‘chirish (§21) | ✅ | — | PG ✅ `compliance.test.ts` (×3) |
| amoCRM import / reconciliation / kunlik nazorat (§5.2) | ✅ | ✅ demo amoCRM; contract (sahifalash, 204, 401) | PG ✅ · amoCRM ⛔ |
| Lead Ads tarixini qayta olish (§8.3) | ✅ | ✅ demo Meta; contract (cursor, filtr) | PG ✅ · Meta ⛔ |
| Demo loginlar production’da ishlamaydi (§25.1) | ✅ | — | PG ✅ `production-safety.test.ts` |
| Webhook 10 ev/s × 15 daq (§22.1) | ✅ | demo provayderlar | PG/Redis ✅ lokal (`docs/perf/webhook-15min*.md`) · ajratilgan muhit ⛔ |
| Dependency xavfsizligi (§4.2) | ✅ | — | `npm audit` 0 (ADR 0005) |

## Unumdorlik (TZ §22.1)

Dataset: 20 xodim, 50 000 kontakt, 100 000 lid, 1 020 490 xabar, 10 000 segment. Windows 11 noutbuk (12 CPU) + Docker Desktop — ajratilgan 4 vCPU/8 GB emas. `127.0.0.1` orqali, isinishdan keyin.

| Mezon | Maqsad | Natija (Prisma 7, `docs/perf/perf-prisma7-run.txt`) |
| --- | --- | --- |
| Lokal GET, 20 parallel | p95 < 500 ms | leads 222 ms, orders 213 ms, flights 249 ms |
| Dashboard | p95 < 2 s | keshsiz 1 mijoz 0,9–1,1 s; 20 parallel 1,7–1,8 s |
| Webhook 10 ev/s × 15 daq | yo‘qotishsiz, ACK p95 < 2 s | `docs/perf/webhook-15min.md` (Prisma 6) va `webhook-15min-v2` (joriy kod) |
