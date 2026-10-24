# Implementation plan (B0–B6)

Manba: `docs/TZ.md` (v1.0, 2026-10-24). Ushbu reja TZ o‘rnini bosmaydi; har bir band TZ bo‘limiga havola qiladi.
Holat belgilari: ✅ bajarilgan va test bilan tasdiqlangan · 🟡 qisman · ⛔ tashqi ruxsat yo‘qligi sababli bloklangan · ⬜ boshlanmagan.
Haqiqiy holat uchun `docs/acceptance-matrix.md` va `KNOWN_LIMITATIONS.md` ga qarang.

## Joriy holat (2026-10-24)

| Bosqich | Holat | Izoh |
| --- | --- | --- |
| B0 | ⛔ | Credential yo‘q; adapterlar, contract fixture’lar va `npm run smoke:live` tayyor |
| B1 | ✅ | Monorepo, Compose, migratsiyalar (kompozit tenant FK, partial unique, audit trigger), auth (Argon2id, sessiya, CSRF, rate limit, admin TOTP, aktivlashtirish), RBAC, audit, seed, OpenAPI, CI |
| B2 | 🟡 | OAuth (refresh lock), CRM webhook, inbox/outbox, dedupe, taqsimlash, status/mas’ul proyeksiyasi, anomaliya, reconciliation, `amo-config` — demo adapter bilan; boshlang‘ich import va kunlik nazorat yo‘q |
| B3 | 🟡 | Lead Ads, Direct inbound/echo/read, amoCRM chat javobi, policy, unknown outbound — demo bilan; live ⛔; Lead Ads reconciliation yo‘q |
| B4 | ✅ | Talablar, taklif versiyalari, buyurtma, to‘lov, yo‘lovchi, chipta, multi-segment, DST, manual check; fayl biriktirish yo‘q |
| B5 | ✅ | DB scheduler, milestone/urgent, revision, bekor qilish, eskalatsiya, missed, CRM task mapping, qo‘lda recurrence/snooze, reyslar dashboard’i, SSE + polling |
| B6 | 🟡 | KPI, filtrlar, menejer statistikasi, RBAC eksport, perf o‘lchovi, lokal restore mashqi; PITR, staging UAT, alerting yo‘q |

Batafsil: `docs/acceptance-matrix.md`, `KNOWN_LIMITATIONS.md`.

## Bog‘liqlik grafi

```
B0 (feasibility, live) ──────────────┐ (faqat live smoke va production qabul uchun)
B1 (asos) ──► B2 (amoCRM, lid) ──► B3 (Instagram) ──┐
        └──► B4 (turizm) ──► B5 (eslatma) ──────────┴──► B6 (KPI, eksport, UAT)
```

B0 dagi live sinovlar tashqi akkauntlarga bog‘liq. Ular bloklangan paytda B1, B4, B5 va B2/B3 ning demo adapter + contract fixture qismi mustaqil davom etadi (TZ §24 B0, §28).

## B0 — Integratsiya imkoniyatlarini isbotlash (TZ §3, §24)

| Vazifa | Natija | Qabul testi |
| --- | --- | --- |
| G01–G09 live sinovlari | `docs/feasibility.md` da vaqt, ssenariy, redakt qilingan so‘rov/javob | `npm run smoke:live` (credential bo‘lsa) |
| Direct yo‘li qarori | `docs/decisions/0002-direct-adapter-path.md` | G05, G06, G08 dalili |
| Ruxsatlar matritsasi | `docs/integrations.md` | G07 dalili |
| Contract fixture’lar | `tests/fixtures/**` (sanitizatsiya qilingan) | `tests/contract/*.test.ts` |

Holat: ⛔ credential mavjud emas — `docs/feasibility.md` ga qarang.

## B1 — Loyiha asosi (TZ §4, §6, §16, §21, §25)

| Vazifa | Qabul testi |
| --- | --- |
| npm workspaces monorepo, TS strict, ESLint | `npm run lint`, `npm run typecheck` |
| Docker Compose (Postgres, Redis, api, worker, web) | `docker compose -f infra/docker-compose.yml up` |
| Prisma schema + migratsiya (composite tenant FK, partial unique, audit immutability trigger) | `npm run db:migrate`; integration: `tests/integration/schema.test.ts` |
| Auth: email+parol (Argon2id), DB session, HttpOnly cookie, CSRF, rate limit, admin TOTP MFA, aktivlashtirish havolasi | `tests/integration/auth.test.ts` |
| RBAC + obyekt darajasidagi scope (query, eksport, SSE) | `tests/integration/rbac.test.ts` (AC12) |
| Audit (append-only) | `tests/integration/audit.test.ts` |
| Sun’iy seed | `npm run db:seed` |
| Health/readiness, OpenAPI | `GET /health`, `GET /ready`, `GET /api/openapi.json` |
| Demo/production rejim qo‘riqchisi | `packages/integrations` unit: production’da mock adapter rad etiladi |
| CI | `.github/workflows/ci.yml` |

## B2 — amoCRM va lid jarayoni (TZ §5, §7, §10, §11, §17, §19)

| Vazifa | Qabul testi |
| --- | --- |
| amoCRM REST OAuth (state, allowlist domen, refresh lock, atomik token almashinuvi) | integration: parallel refresh (AC28) |
| Umumiy Redis rate limiter (5 rps/integratsiya) | integration: limiter |
| CRM webhook (`x-www-form-urlencoded`, opaque route) → inbox → ACK | integration: AC26, AC02 |
| Inbox/outbox, retry siyosati, DLQ, replay | integration: AC27, AC29 |
| Kontakt matching va dedupe navbati | unit + integration: AC03, AC04 |
| Round-robin pool lock | integration: AC10, AC11 |
| Stage qoidalari, FOLLOW_UP, anomaliya, eski hodisa | unit + integration: AC13, AC14, AC15, AC30 |
| `amo-config` dry-run/apply | contract fixture |

## B3 — Instagram oqimlari (TZ §8, §9)

| Vazifa | Qabul testi |
| --- | --- |
| Meta webhook GET verify / POST raw-body imzo | integration |
| Lead Ads: leadgen → inbox → lead fetch → identify → assign → amo | AC01, AC09 (demo/fixture) |
| Direct: kiruvchi → suhbat → amo Chats; echo suppression | AC05, AC08 |
| Javob: amo chat webhook → policy (24h oyna) → Send API → holat | AC06 (⛔ live), AC07 |
| Outbound unknown holati va reconciliation | AC29 |

## B4 — Turizm operatsiyalari (TZ §12, §13)

| Vazifa | Qabul testi |
| --- | --- |
| Talablar, taklif versiyalari (o‘zgarmas) | integration: offers |
| Buyurtma (atomik `TR-YYYY-NNNNNN`, bitta faol order/lid, idempotent WON) | AC15 |
| To‘lov qaydlari (minor unit, refund alohida) | AC31 |
| Yo‘lovchilar, multi-segment, IANA zona, DST tasdiqlash | AC16, AC17 |
| Manual flight check, revision | AC20, AC21 |

## B5 — Eslatma va nazorat (TZ §14, §15.3)

| Vazifa | Qabul testi |
| --- | --- |
| DB scheduler (30s, `FOR UPDATE SKIP LOCKED`, lease) | AC25 |
| Milestone T-168/72/24/3h, shoshilinch occurrence | AC18, AC19 |
| Revision bo‘yicha yaroqsizlash | AC21 |
| Bekor qilish | AC22 |
| CRM task mapping, task yopilishi ≠ tekshiruv | AC23 |
| Qo‘lda recurrence, snooze | AC24 |
| Eskalatsiya (T-3h 15 daq, boshqalar 60 daq) | integration |
| Reyslar dashboard’i, SSE + 30s polling | E2E |

## B6 — Hisobot va tayyorlash (TZ §15, §22, §23)

| Vazifa | Qabul testi |
| --- | --- |
| KPI formulalari (kohorta vs yopilganlar, valyuta bo‘yicha) | unit: AC31, AC32, AC33 |
| Filtrlar (kompaniya zonasi → UTC, [start, end)) | unit |
| RBAC eksport CSV + audit | integration: AC12 |
| Monitoring metrikalari, heartbeat | integration |
| Performance dataset va o‘lchov | `npm run perf:seed`, hisobot |
| Backup/restore runbook va sinov | AC35 (⛔ staging) |
| Staging UAT | AC36 (⛔ staging) |
