# Integratsiyalar

> **2026-10-26:** amoCRM integratsiyasi (REST, OAuth, Chats, sinxronizatsiya, import, reconcile) loyihadan to‘liq olib tashlangan; CRM mustaqil ishlaydi. Quyida faqat Meta (Instagram Direct, Lead Ads) va yordamchi adapterlar. Eski amoCRM outbox yozuvlari o‘chirilmagan — ishlovchi ularni `amocrm_removed` natijasi bilan yopadi.

Hujjat holati: 2026-10-24. Provider hujjatlari TZ §27 [S01]–[S11] ro‘yxatidan; ular TZ muallifi tomonidan 2026-10-24 da tekshirilgan, ushbu ishlab chiqish sessiyasida qayta ochilmagan. **Hech bir adapter live akkauntda tasdiqlanmagan.**

## Adapterlar va autentifikatsiya

| Adapter | Kod | Auth | Konfiguratsiya | API versiya | Live holat |
| --- | --- | --- | --- | --- | --- |
| Meta Lead Ads | `meta/clients.ts` (`GraphMetaLeadsClient`) | Page access token (connection credentials) | `META_GRAPH_VERSION` | konfiguratsiyada, hozir bo‘sh | ⛔ G04 |
| Meta Direct | `meta/clients.ts` (`GraphMetaDirectClient`), `meta/instagram-login.ts`, `services/instagram.service.ts` | **Instagram API with Instagram Login** (OAuth + uzun token yangilash); Facebook Login ishlatilmaydi | `INSTAGRAM_APP_ID/SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION` | konfiguratsiyada | ⛔ G05/G06 (mock bilan sinalgan; qarang `docs/instagram-direct-setup.md`) |
| Meta webhook | `meta/signature.ts`, `meta/webhook-parse.ts` | `X-Hub-Signature-256` raw body; GET verify token alohida | `META_APP_SECRET`, `META_VERIFY_TOKEN` | — | ⛔ |
| Flight provider | `flight.ts` | — | — | ManualProvider | ✅ (qo‘lda) |

Demo adapterlar (`demo/adapters.ts`) faqat `APP_MODE=demo` da ishlaydi; staging/production’da mock adapter aniqlansa API va worker ishga tushmaydi (`assertAdaptersAllowed`).

## Webhook yo‘llari (backend)

| Yo‘l | Tekshiruv | Saqlash |
| --- | --- | --- |
| `GET /webhooks/meta` | `hub.verify_token` timing-safe | — |
| `POST /webhooks/meta` | raw body HMAC-SHA256 | har bir event alohida inbox qatori (`leadgen:<id>`, `ig_msg:<mid>`, `ig_echo:<mid>`, `ig_read:...`) |

Inbox commit muvaffaqiyatsiz bo‘lsa 5xx qaytariladi (AC26).

## Ruxsatlar matritsasi (G07 da to‘ldiriladi)

| Imkoniyat | Login yo‘li | Kerakli ruxsat (TZ’dagi misol) | Tasdiqlangan |
| --- | --- | --- | --- |
| Direct o‘qish/yuborish | Instagram Login | `instagram_business_basic`, `instagram_business_manage_messages` [S06] | ✅ test akkaunt bilan (Development rejimi, 2026-10-25). Barcha mijozlar uchun App Review / Advanced Access ⛔ |
| Lead Ads o‘qish | Facebook Login (Page) | Page va lead-forma ruxsatlari [S09] | ⛔ |
| Human Agent | tanlangan mahsulot | App Review [S07] | ⛔ |

## Retry va limitlar

- Retry jadvali (TZ §19.3): `packages/domain/src/misc.ts` `decideRetry`; maks 8 urinish / 24 soat, keyin `dead`; `unknown` holat avtomatik qayta yaratilmaydi; 401 → bitta sinxron refresh; 403/billing → connection `paused`.

## Tarixni qayta olish

| Jarayon | Kod | Ishga tushirish | Dalil |
| --- | --- | --- | --- |
| Lead Ads tarixi (`/{form-id}/leads`, cursor, checkpoint, webhook bilan bir xil dedupe kaliti, bo‘shliq hisoboti) | `lead-ads-backfill.service.ts` | `POST /api/v1/integrations/lead-ads/backfill` | `compliance.test.ts`; contract: `tests/contract/pagination-files.test.ts` |

Contract testlar sintetik fixture’lar bilan `time_created` filtri va `after` cursor’ni tekshiradi. **Ular live API dalili emas.** `META_LEADS_RETENTION_DAYS` (default 90) — G09 da tasdiqlanadigan taxmin.
