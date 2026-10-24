# Acceptance matrix (AC01–AC36)

Oxirgi yangilanish: 2026-10-24 · TZ §23

Holatlar:
- ✅ **avtomatik test bilan tasdiqlangan** — haqiqiy PostgreSQL/Redis bilan integration test yoki unit test o‘tdi. Tashqi provayder ishtirok etgan joylarda demo adapter ishlatilgan; bu **live integratsiya dalili emas**.
- 🟡 **qisman** — kod va test bor, lekin tashqi dalil yoki qamrov yetishmaydi (izohga qarang).
- ⛔ **bloklangan** — tashqi akkaunt/ruxsat yoki staging talab qilinadi (`docs/feasibility.md`).

Test fayllari: `tests/integration/*.test.ts` (64 ta, real PG 16 + Redis 7), `packages/domain/test/*.test.ts` va `tests/contract/*.test.ts` (63 ta), `tests/e2e/flows.spec.ts` (4 ta, Playwright, Chrome). Oxirgi ishga tushirish: 2026-10-24, hammasi o‘tdi.

| ID | Ssenariy | Holat | Dalil | Cheklov |
| --- | --- | --- | --- | --- |
| AC01 | Yangi Lead Ads formasi | 🟡 | `intake.test.ts` › AC01 | Meta live leadgen (G04) bloklangan; javob shakli sintetik fixture |
| AC02 | Bir hodisa 10 marta | ✅ | `intake.test.ts` › AC02 (1 inbox, 1 inquiry, 1 lid, 1 vazifa) | — |
| AC03 | Parallel kanal, bir telefon | ✅ | `intake.test.ts` › AC03 (parallel processing + IG/telefon ziddiyati → review) | — |
| AC04 | Umumiy oilaviy telefon | ✅ | `intake.test.ts` › AC04; `matching-assignment.test.ts` | Telefonni «umumiy» deb belgilash rahbar qarori bilan |
| AC05 | Direct yangi va davomiy suhbat | 🟡 | `intake.test.ts` › AC05 | Live Direct (G05) va amoCRM Chats kanali (G08) bloklangan |
| AC06 | amoCRM ichidan inson javobi | ⛔ | Demo oqim: `intake.test.ts` › AC06 | Haqiqiy Instagram’da qabul qilinishi faqat G06 bilan isbotlanadi |
| AC07 | Javob oynasi yopiq | 🟡 | `pipeline-kpi-policy.test.ts`; `intake.test.ts` › AC07 | Oyna uzunligi konfiguratsiya (24 soat default) — G07 da tasdiqlanadi |
| AC08 | Click-to-Direct reklama | 🟡 | `intake.test.ts` › AC08 | Referral maydonlari real javobda tasdiqlanmagan (G09) |
| AC09 | Kampaniya metadata olinmaydi | ✅ | `intake.test.ts` › AC09 | Ichki xatti-harakat; live Graph xatosi shakli tasdiqlanmagan |
| AC10 | 3 menejer, 100 parallel lid | ✅ | `amo-sync.test.ts` › AC10 (10 parallel processor, farq ≤ 1) | — |
| AC11 | Faol menejer yo‘q | ✅ | `amo-sync.test.ts` › AC11 (navbatchi va navbat, rahbarga signal) | — |
| AC12 | Begona mijoz ID’si | 🟡 | `rbac-auth.test.ts` › AC12 (API 404, eksport 403, ro‘yxat/dashboard/reyslar scope); E2E RBAC | SSE har hodisada DB tekshiruvi kodda bor, avtomatik test yo‘q; fayl/attachment API hali yo‘q |
| AC13 | Native amoCRM’da mas’ul o‘zgaradi | ✅ | `amo-sync.test.ts` › AC13; `rbac-auth.test.ts` (eski menejer darhol 404) | amoCRM native rollarini sozlash akkauntda qo‘lda (tekshirilmagan) |
| AC14 | Native statusda maydon yetishmaydi | ✅ | `amo-sync.test.ts` › AC14 | — |
| AC15 | WON va takroriy webhook | ✅ | `amo-sync.test.ts` › AC15 | — |
| AC16 | Borish, ulanish, qaytish | ✅ | `travel.test.ts` › AC16 + AC18 | — |
| AC17 | Boshqa zona va DST | ✅ | `time-reminders.test.ts`; `travel.test.ts` › AC17 | — |
| AC18 | 168/72/24/3h milestone | ✅ | `travel.test.ts` › AC18/AC20 | — |
| AC19 | Uchishga 2 soat qolganda | ✅ | `travel.test.ts` › AC19 | — |
| AC20 | Oldingi milestone tekshirilgan | ✅ | `travel.test.ts` › AC18/AC20 | — |
| AC21 | Reys jadvali o‘zgaradi | ✅ | `travel.test.ts` › AC21 (×2: navbatdagi eski ish tashlanadi) | — |
| AC22 | Reys yoki order bekor | ✅ | `travel.test.ts` › AC22 (×2) | — |
| AC23 | CRM vazifasi natijasiz yopiladi | ✅ | `travel.test.ts` › AC23 | amoCRM task yopilishi webhook orqali kuzatilmaydi — tekshiruv hisoblanmasligi kafolatlangan |
| AC24 | Recurring va snooze | ✅ | `travel.test.ts` › AC24; `time-reminders.test.ts` | — |
| AC25 | Worker yoki Redis qayta ishga tushadi | 🟡 | `travel.test.ts` › AC25 (lease, qayta claim, dublikatsiz yon ta’sir) | Redis restart alohida avtomatik test bilan qamralmagan (dizayn: DB manba, relay qayta uzatadi) |
| AC26 | DB ishlamaydi va webhook keladi | ✅ | `intake.test.ts` › AC26 (5xx) | — |
| AC27 | 429 yoki 5xx | ✅ | `amo-sync.test.ts` › AC27 | Haqiqiy amoCRM limit javobi tasdiqlanmagan |
| AC28 | Parallel OAuth refresh | ✅ | `amo-sync.test.ts` › AC28 (8 parallel → 1 exchange) | Live G02 bloklangan |
| AC29 | Lid yaratish timeout | ✅ | `amo-sync.test.ts` › AC29 (×2: reconcile; unknown + operator + replay) | amoCRM `query` qidiruvi custom maydon bo‘yicha live tasdiqlanmagan |
| AC30 | Tartibsiz eski status | ✅ | `amo-sync.test.ts` › AC30; unit | — |
| AC31 | UZS va USD | ✅ | `travel.test.ts` › AC31; `money-phone.test.ts` | — |
| AC32 | Kohorta vs yopilganlar | ✅ | `pipeline-kpi-policy.test.ts` › KPI | — |
| AC33 | Bot, keyin inson javobi | ✅ | `pipeline-kpi-policy.test.ts` › first response | Bot integratsiyasi yo‘q; formula tayyor |
| AC34 | Integration o‘chiriladi | ✅ | `amo-sync.test.ts` › AC34 | — |
| AC35 | Backup restore | 🟡 | Lokal `pg_dump`/`pg_restore` mashqi: 1,02M xabar, 36 s, hisoblar va trigger/partial indekslar mos (`docs/runbook.md` §6) | RPO 15 daq uchun PITR/WAL arxivi staging/production infra’da bajarilmagan |
| AC36 | Staging end-to-end | ⛔ | Lokal demo E2E: `tests/e2e/flows.spec.ts` (forma → lid → buyurtma → segment → eslatma → tekshiruv) | Staging muhiti va real akkauntlar yo‘q |

## Unumdorlik (TZ §22.1)

Dataset: 20 xodim, 50 000 kontakt, 100 000 lid, 1 020 490 xabar, 10 000 segment (`npm run perf:seed`). Lokal Windows 11 + Docker Desktop, PostgreSQL 16 konteyner; ajratilgan 4 vCPU/8 GB muhit emas — natijalar taxminiy. To‘liq jadval: `docs/perf-last-run.txt`.

| Mezon | Maqsad | Natija |
| --- | --- | --- |
| Lokal GET (20 parallel) | p95 < 500 ms | leads 142 ms, orders 175 ms, flights 343 ms |
| Dashboard | p95 < 2 s | keshsiz 1 mijoz: 505 ms; 20 parallel (single-flight + 20 s kesh): 609 ms |
| Webhook durable ACK | p95 < 2 s | 10 event/s × 60 s: p95 19 ms, 600/600 saqlandi |
| 15 daqiqalik 10 event/s sinovi | yo‘qotishsiz | Bajarilmagan (faqat 60 s) |
