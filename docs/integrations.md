# Integratsiyalar

Hujjat holati: 2026-10-24. Provider hujjatlari TZ §27 [S01]–[S11] ro‘yxatidan; ular TZ muallifi tomonidan 2026-10-24 da tekshirilgan, ushbu ishlab chiqish sessiyasida qayta ochilmagan. **Hech bir adapter live akkauntda tasdiqlanmagan.**

## Adapterlar va autentifikatsiya

| Adapter | Kod | Auth | Konfiguratsiya | API versiya | Live holat |
| --- | --- | --- | --- | --- | --- |
| amoCRM REST | `packages/integrations/src/amocrm/rest-client.ts` | OAuth 2.0 (authorization code + refresh, rotatsiya) | `AMO_CLIENT_ID/SECRET/REDIRECT_URI`, `AMO_ALLOWED_DOMAINS` | REST v4 (`/api/v4/...`) | ⛔ G01/G02 |
| amoCRM OAuth | `amocrm/oauth.ts`, `apps/api/src/core/services/oauth.service.ts` | state (bir martalik, 10 daq, sessiyaga bog‘langan), domen allowlist | — | `/oauth2/access_token` | ⛔ G02 |
| amoCRM Chats (amojo) | `amocrm/chats.ts` | Kanal secret: HMAC-SHA1 so‘rov imzosi (Meta’dan farqli) | `AMO_CHAT_CHANNEL_ID`, `AMO_CHAT_SECRET` | `/v2/origin/custom/...` | ⛔ G08 |
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
| `POST /webhooks/amocrm/crm/{route_token}` | taxmin qilib bo‘lmaydigan route + `account[id]` mosligi; HMAC taxmin qilinmagan | `leads:<action>:<id>:<updated_at>`; obyekt doim amoCRM’dan qayta o‘qiladi |
| `POST /webhooks/amocrm/chat/{route_token}` | `X-Signature` HMAC-SHA1 (kanal secret) | `chat_reply:<amo_msg_id>` |

Inbox commit muvaffaqiyatsiz bo‘lsa 5xx qaytariladi (AC26).

## amoCRM maydonlar xaritasi (`npm run amo-config`)

Dry-run: yetishmayotgan status va maydonlarni ko‘rsatadi. `--apply`: faqat yetishmaganini yaratadi, ID’larni `integration_mappings` ga yozadi; qayta ishga tushirish idempotent (demo’da tekshirilgan: 2-apply 25/25 `mapped`).

| Lokal | amoCRM | Izoh |
| --- | --- | --- |
| Stage NEW…FOLLOW_UP | pipeline status (nom bo‘yicha topiladi yoki yaratiladi) | `pipeline_status`, kalit `pipelineId:statusId` |
| WON / LOST | tizim statuslari 142 / 143 | qo‘shimcha yopiq status yaratilmaydi |
| external_operation_id | lead custom field `EXTERNAL_OPERATION_ID` | timeout’dan keyin reconciliation |
| first_source, source_created_at, form_id, campaign_ref, ad_ref | lead custom fields | lid yaratishda |
| travel_lead_url, travel_order_id, travel_order_url, local_amount | lead custom fields | buyurtma xulosasi |
| next_departure_at, next_flight_no, next_check_state, next_reminder_at | lead custom fields | eng yaqin faol segment proyeksiyasi |
| instagram_username, instagram_scoped_ref | contact custom fields | — |
| native `price` | faqat `company.settings.amoPriceCurrency` = buyurtma valyutasi bo‘lsa | aks holda yozilmaydi |

## Ruxsatlar matritsasi (G07 da to‘ldiriladi)

| Imkoniyat | Login yo‘li | Kerakli ruxsat (TZ’dagi misol) | Tasdiqlangan |
| --- | --- | --- | --- |
| Direct o‘qish/yuborish | Instagram Login | `instagram_business_basic`, `instagram_business_manage_messages` [S06] | ⛔ |
| Lead Ads o‘qish | Facebook Login (Page) | Page va lead-forma ruxsatlari [S09] | ⛔ |
| Human Agent | tanlangan mahsulot | App Review [S07] | ⛔ |
| amoCRM REST | OAuth | integratsiya huquqlari | ⛔ |
| amoCRM Chats | kanal | kanal ro‘yxatdan o‘tkazish [S03] | ⛔ |

## Retry va limitlar

- Umumiy Redis limiter: `amo:<account_id>` kaliti bo‘yicha `AMO_RATE_LIMIT_RPS` (default 5) — barcha API/worker process’lari uchun bitta.
- Retry jadvali (TZ §19.3): `packages/domain/src/misc.ts` `decideRetry`; maks 8 urinish / 24 soat, keyin `dead`; `unknown` holat avtomatik qayta yaratilmaydi; 401 → bitta sinxron refresh; 403/billing → connection `paused`.

## Sinxronlash va tarixni qayta olish (2026-10-24 qo‘shildi)

| Jarayon | Kod | Ishga tushirish | Dalil |
| --- | --- | --- | --- |
| amoCRM boshlang‘ich importi (foydalanuvchi xaritasi, kontaktlar, faol lidlar; sahifa checkpoint’i, idempotent) | `core/services/amo-sync.service.ts` `importInitial` | `POST /api/v1/integrations/amocrm/import` (worker’da, 202) | `compliance.test.ts` (demo adapter) |
| Incremental reconciliation (lid + kontakt, 10 daq overlap, amoCRM’da native yaratilgan lidlar ham) | `reconcile` | worker, har `RECONCILE_INTERVAL_MS` (5 daq) | `compliance.test.ts` |
| Kunlik nazorat (amoCRM’dan yo‘qolgan lid → tombstone; yo‘q faol lid → import) | `dailyAudit` | worker, 24 soatda bir | `compliance.test.ts` |
| Lead Ads tarixi (`/{form-id}/leads`, cursor, checkpoint, webhook bilan bir xil dedupe kaliti, bo‘shliq hisoboti) | `lead-ads-backfill.service.ts` | `POST /api/v1/integrations/lead-ads/backfill` | `compliance.test.ts`; contract: `tests/contract/pagination-files.test.ts` |

Contract testlar sintetik fixture’lar bilan sahifalash, 204 javob, 401→refresh, `time_created` filtri va `after` cursor’ni tekshiradi. **Ular live API dalili emas.** `META_LEADS_RETENTION_DAYS` (default 90) — G09 da tasdiqlanadigan taxmin.
