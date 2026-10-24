# Webhook 15 daqiqalik yuk sinovi (TZ §22.1) — 2026-10-24

Muhit: Windows 11, 12 CPU, Docker Desktop (8 GB), PostgreSQL 16.4 + Redis 7.4 konteynerda; API va worker bundle (`dist`) bitta nusxadan, `crm_perf` bazasi (100k lid, 1M xabar), APP_MODE=demo. Ajratilgan 4 vCPU/8 GB muhit emas.

Yuk: `npm run perf:webhook -- --rate=10 --seconds=900` — imzolangan Instagram Direct hodisalari, 500 xil yuboruvchi.

| Ko‘rsatkich | Natija |
| --- | --- |
| Yuborilgan / ACK | 9000 / 9000, xato 0 |
| ACK latency | p50 13 ms, p95 23 ms, max 379 ms |
| Inbox yakuniy holati | 9000 `done`, 0 failed/dead |
| Yaratilgan xabarlar / suhbatlar | 9000 / 500 (dublikat yo‘q) |
| Qayta ishlash kechikishi (received→processed) | p50 0,34 s, p95 16,1 s, max 30,3 s (p95 asosan birinchi daqiqadagi start backlog’i) |
| Backlog | sinov davomida 0–5 ta kutayotgan; yuborish tugagach ~30 s ichida 0 |
| Outbox | 11 600 operatsiya `done` |

Xom ma’lumot: `webhook-15min-monitor.jsonl` (har 30 s), `webhook-15min-sender.txt`.
