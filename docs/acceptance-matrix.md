# Acceptance matrix (AC01–AC36)

Oxirgi yangilanish: 2026-10-24 · TZ §23

Holatlar:
- ✅ **avtomatik test bilan tasdiqlangan** — haqiqiy PostgreSQL 16 / Redis 7 bilan integration test, unit yoki E2E o‘tdi. Tashqi provayder ishtirok etgan joylarda demo adapter yoki sintetik contract fixture ishlatilgan — bu **live integratsiya dalili emas**.
- 🟡 **qisman** — kod va test bor, lekin tashqi dalil yoki qamrov yetishmaydi.
- ⛔ **bloklangan** — tashqi akkaunt yoki infratuzilma kerak (`docs/feasibility.md`).

Test to‘plami (oxirgi ishga tushirish 2026-10-24, Node 22.23.4, Prisma 7.10.1): unit + contract 75 (`packages/domain/test`, `tests/contract`), integration 85 (`tests/integration`, har ishga tushishda yangi baza), E2E 6 (`tests/e2e/flows.spec.ts`, Chrome). Hammasi o‘tdi; `lint`, `typecheck`, `build`, `npm audit` (0) toza.

| ID | Ssenariy | Holat | Dalil | Cheklov |
| --- | --- | --- | --- | --- |
| AC01 | Yangi Lead Ads formasi | 🟡 | `intake.test.ts` › AC01; E2E demo oqimi | Live leadgen (G04) bloklangan |
| AC02 | Bir hodisa 10 marta | ✅ | `intake.test.ts` › AC02; backfill + webhook dedupe (`compliance.test.ts`) | — |
| AC03 | Parallel kanal, bir telefon | ✅ | `intake.test.ts` › AC03 (×2) | — |
| AC04 | Umumiy oilaviy telefon | ✅ | `intake.test.ts` › AC04; unit | — |
| AC05 | Direct yangi va davomiy suhbat | 🟡 | `intake.test.ts` › AC05 | Live Direct (G05) va Chats kanali (G08) |
| AC06 | amoCRM ichidan inson javobi | ⛔ | Demo oqim: `intake.test.ts` › AC06 | Instagram’da qabul faqat G06 bilan isbotlanadi |
| AC07 | Javob oynasi yopiq | 🟡 | unit; `intake.test.ts` › AC07 | Oyna uzunligi G07 da tasdiqlanadi |
| AC08 | Click-to-Direct | 🟡 | `intake.test.ts` › AC08 | Referral shakli real javobda tasdiqlanmagan (G09) |
| AC09 | Kampaniya metadata olinmaydi | ✅ | `intake.test.ts` › AC09 | — |
| AC10 | 3 menejer, 100 parallel lid | ✅ | `amo-sync.test.ts` › AC10 (inbox natijalari diagnostikasi bilan) | Bir marta (to‘liq suite, yuklangan mashinada) qayta tiklanmagan muvaffaqiyatsizlik kuzatildi; keyingi 9 ishga tushirishda o‘tdi |
| AC11 | Faol menejer yo‘q | ✅ | `amo-sync.test.ts` › AC11 | — |
| AC12 | Begona mijoz ID’si | ✅ | `rbac-auth.test.ts` (API 404, eksport 403, scope); `compliance.test.ts` (fayl: ro‘yxat/havola/yuklab olish/yuklash 404, sizib chiqqan imzolangan URL ishlamaydi); `sse.test.ts` (SSE begona/kompaniyalararo hodisani bermaydi, mas’ul almashsa darhol); E2E RBAC | amoCRM native rollarini sozlash akkauntda (⛔) |
| AC13 | Native amoCRM’da mas’ul o‘zgaradi | ✅ | `amo-sync.test.ts` › AC13; `sse.test.ts` | — |
| AC14 | Native statusda maydon yetishmaydi | ✅ | `amo-sync.test.ts` › AC14 | — |
| AC15 | WON va takroriy webhook | ✅ | `amo-sync.test.ts` › AC15 | — |
| AC16 | Borish, ulanish, qaytish | ✅ | `travel.test.ts` | — |
| AC17 | Boshqa zona va DST | ✅ | unit; `travel.test.ts` › AC17; `formatLocalIso` ekvivalentlik testi | — |
| AC18 | 168/72/24/3h milestone | ✅ | `travel.test.ts` | — |
| AC19 | Uchishga 2 soat qolganda | ✅ | `travel.test.ts` › AC19 | — |
| AC20 | Oldingi milestone tekshirilgan | ✅ | `travel.test.ts` | — |
| AC21 | Reys jadvali o‘zgaradi | ✅ | `travel.test.ts` › AC21 (×2) | — |
| AC22 | Reys yoki order bekor | ✅ | `travel.test.ts` › AC22 (×2) | — |
| AC23 | CRM vazifasi natijasiz yopiladi | ✅ | `travel.test.ts` › AC23 | — |
| AC24 | Recurring va snooze | ✅ | `travel.test.ts` › AC24; unit | — |
| AC25 | Worker yoki Redis qayta ishga tushadi | ✅ | `travel.test.ts` › AC25 (lease, dublikatsiz yon ta’sir); `redis-outage.test.ts` (relay xatosi → PG’da pending, keyin bir marta qayta ishlanadi; scheduler Redis’siz) | — |
| AC26 | DB ishlamaydi va webhook keladi | ✅ | `intake.test.ts` › AC26 | — |
| AC27 | 429 yoki 5xx | ✅ | `amo-sync.test.ts` › AC27; contract (401→refresh) | Live limit javobi tasdiqlanmagan |
| AC28 | Parallel OAuth refresh | ✅ | `amo-sync.test.ts` › AC28 | Live G02 |
| AC29 | Lid yaratish timeout | ✅ | `amo-sync.test.ts` › AC29 (×2) | `query` qidiruvi live tasdiqlanmagan |
| AC30 | Tartibsiz eski status | ✅ | `amo-sync.test.ts` › AC30 | — |
| AC31 | UZS va USD | ✅ | `travel.test.ts` › AC31; unit | — |
| AC32 | Kohorta vs yopilganlar | ✅ | unit | — |
| AC33 | Bot, keyin inson javobi | ✅ | unit | Bot integratsiyasi yo‘q |
| AC34 | Integration o‘chiriladi | ✅ | `amo-sync.test.ts` › AC34 | — |
| AC35 | Backup restore | 🟡 | Lokal PITR mashqi `infra/pitr/drill.sh`: maqsad vaqtga tiklash to‘g‘ri (1000/0), 4 s, arxiv xatosiz (`docs/perf/pitr-drill-last-run.txt`); `pg_dump` mashqi 1M xabar 36 s; tombstone’lar restore’dan keyin qayta qo‘llanadi (`compliance.test.ts`) | Off-site WAL arxivi va haqiqiy hajmdagi RTO production infra’da ⛔ |
| AC36 | Staging end-to-end | ⛔ | Lokal demo E2E (forma → lid → buyurtma → segment → eslatma → tekshiruv; fayl yuklash/skan/yuklab olish) | Staging va real akkauntlar yo‘q |

## Qo‘shimcha talablar (KNOWN_LIMITATIONS’dan yopilganlar)

| Talab (TZ) | Holat | Dalil |
| --- | --- | --- |
| Fayllar: huquq, private storage, MIME/hajm, virus skan, signed URL (§12.2, §21) | ✅ (ClamAV live ⛔) | `compliance.test.ts` › attachments (×3); contract: sniffing, storage, signed URL, clamd protokoli (soxta clamd bilan); E2E (×2) |
| SLA yaqinlashishi va buzilishi (§10) | ✅ | `compliance.test.ts` › SLA (×2) |
| Retention va PII o‘chirish (§21) | ✅ | `compliance.test.ts` › retention/PII (×3) |
| amoCRM import, incremental reconciliation, kunlik nazorat (§5.2) | ✅ (live ⛔) | `compliance.test.ts` › amoCRM (×3); contract (sahifalash, 204) |
| Lead Ads tarixini qayta olish (§8.3) | ✅ (live ⛔) | `compliance.test.ts` › backfill (×2); contract (cursor, filtr) |
| Demo loginlar production’da ishlamaydi (§25.1) | ✅ | `production-safety.test.ts` (×4) |
| PITR konfiguratsiyasi va yo‘riqnoma (§22.3) | 🟡 | lokal mashq; `docs/runbook.md` §6 |
| Dependency xavfsizligi (§4.2) | ✅ | `npm audit` 0; ADR 0005 |
| Webhook 10 event/s × 15 daqiqa (§22.1) | ✅ (lokal muhit) | `docs/perf/webhook-15min.md` |

## Unumdorlik (TZ §22.1)

Dataset: 20 xodim, 50 000 kontakt, 100 000 lid, 1 020 490 xabar, 10 000 segment. Windows 11 noutbuk (12 CPU) + Docker Desktop; ajratilgan 4 vCPU/8 GB muhit emas. O‘lchov `127.0.0.1` orqali, isinishdan keyin (Windows’da `localhost` IPv6 fallback’i ~200 ms artefakt qo‘shadi).

| Mezon | Maqsad | Natija (Prisma 7, `docs/perf/perf-prisma7-run.txt`) |
| --- | --- | --- |
| Lokal GET, 20 parallel | p95 < 500 ms | leads 222 ms, orders 213 ms, flights 249 ms (sovuq birinchi o‘lchovda leads 516 ms) |
| Dashboard | p95 < 2 s | keshsiz 1 mijoz 915–1079 ms; 20 parallel (single-flight + 20 s kesh) 1,7–1,8 s |
| Webhook durable ACK, 10 ev/s × 15 daq | p95 < 2 s, yo‘qotishsiz | 9000/9000, ACK p95 23 ms, qayta ishlash p95 16 s, backlog ~30 s ichida 0 |
| Eslatma due → ichki ko‘rinish | p95 < 60 s | Scheduler intervali 15 s (dizayn bo‘yicha); alohida yuk o‘lchovi yo‘q |

Prisma 6 bilan dashboard 20 parallelda 0,6 s edi; Prisma 7 da 1,7–1,8 s — maqsad ichida, lekin zaxira kamaygan (so‘rov rejasi va map qilish endi Node process’ida).
