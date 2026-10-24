# Webhook 15 daqiqalik yuk sinovi — joriy kod (2026-10-24, v2)

Kod: Prisma 7.10.1 (pg adapter), Node 22.23.4, intake tranzaksiyasida pool qulfi oxirida (`ac10-root-cause.md`). Birinchi sinov (Prisma 6) natijasi: `webhook-15min.md`.

**Muhit.** Windows 11, 12 CPU, Docker Desktop (8 GB); PostgreSQL 16.4 + Redis 7.4 konteynerda; API va worker bundle (`dist`) bittadan nusxa; `crm_perf` bazasi (100k lid, 1M+ xabar); APP_MODE=demo (provayderlar demo adapter). Ajratilgan 4 vCPU/8 GB muhit emas.

**Yuk.** `perf-webhook --rate=10 --seconds=900`: imzolangan Instagram Direct hodisalari, 500 xil yuboruvchi. Start: 2026-10-24T14:24:13Z.

| Ko‘rsatkich | Natija |
| --- | --- |
| Yuborilgan / ACK | 9000 / 9000, xato 0 |
| ACK latency | p50 15 ms, p95 21 ms, max 260 ms |
| Inbox yakuniy holati | 9000 `done`; qayta urinish talab qilgan qator 0 |
| Qayta ishlash kechikishi (received → processed) | p50 0,381 s, p95 0,663 s, max 1,112 s |
| Backlog | butun sinov davomida 0–5 ta; yuborish tugagach ~30 s ichida 0 |
| Natija | 9000 xabar, 500 suhbat, 500 lid (dublikat yo‘q) |
| Outbox (sinov davomida yaratilgan) | 10 376 `done`, `failed/dead/unknown` 0 |

Monitor faylidagi `cancelled: 155` va `dead: 1` — men to‘xtatgan birinchi urinishdan qolgan operatsiyalar (start’dan oldin yaratilgan; monitor oynasi start−60 s dan boshlanadi). Birinchi urinish to‘xtatilgan sabab: test muhitida Redis’ning 2-bazasi oldinroq tozalanganida demo amoCRM ID hisoblagichi nolga tushib, eski demo ID’lar bilan to‘qnashgan — kod xatosi emas; hisoblagich bazadagi eng katta ID’dan keyinga o‘rnatilib, sinov qaytadan boshlangan.

Xom ma’lumot: `webhook-15min-v2-monitor.jsonl` (har 30 s), `webhook-15min-v2-sender.txt`, `webhook-15min-v2-start.txt`.
