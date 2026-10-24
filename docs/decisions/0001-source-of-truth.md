# ADR 0001 — Source of truth va lokal proyeksiya

Sana: 2026-10-24 · Holat: qabul qilingan · TZ: §5, §16

## Kontekst

amoCRM mijoz va sotuvning asosiy tizimi. Turizm buyurtmasi, segmentlar, eslatmalar, audit va analitika PostgreSQL’da. Ikkinchi mustaqil kontakt/sotuv bazasi yaratilmasligi kerak.

## Qaror

| Ma’lumot | Egasi | Lokal jadval | Lokal yozish qoidasi |
| --- | --- | --- | --- |
| Kontakt ismi, telefon, email | amoCRM | `contacts` (proyeksiya) | Faqat amoCRM tasdiqlagandan keyin (`sync_state`) |
| Lid status, voronka, mas’ul | amoCRM | `leads` (proyeksiya), `lead_events` (tarix) | Web ilovadagi o‘zgarish → outbox → amoCRM → tasdiq → proyeksiya. Kutish paytida `sync_state=pending` («Sinxronlanmoqda») |
| Instagram scoped ID, message ID | Integratsiya yozuvi | `contact_identifiers`, `messages` | Lokal egasi |
| Reklama hodisasi, birinchi manba | Integratsiya bazasi | `inquiries`, `leads.first_source*` | Lokal egasi, amoCRM ga maydon sifatida yuboriladi |
| Turizm buyurtmasi, taklif, segment, tekshiruv, eslatma | PostgreSQL | `orders`, `offers`, `flight_segments`, ... | Lokal egasi; amoCRM’ga faqat xulosa (xato asl yozuvni yo‘qotmaydi) |

Qo‘shimcha qoidalar:

- Har bir tashqi xarita `integration_mappings` da: `local_id`, `external_id`, `updated_at`, `last_synced_at`, `sync_state`, `state_hash`.
- Qayta yozish sikli `origin` + `operation_id` + `state_hash` bilan to‘xtatiladi (vaqt oynasi emas).
- Eski hodisa: webhook faqat signal; obyekt amoCRM’dan qayta o‘qiladi va `source_updated_at` monoton tekshiriladi (AC30).
- amoCRM’da o‘chirilgan obyekt lokal `deleted_at` (tombstone) bilan belgilanadi, qayta yaratilmaydi.
- Lokal tahrir `version` (optimistic lock) bilan; eskirgan versiya `409 CONFLICT`.

## Oqibat

- `contacts`/`leads` jadvallarida amoCRM ID’siz «haqiqiy» yozuv faqat `sync_state=pending_create` holatida mavjud bo‘ladi va outbox orqali yaratiladi; demo rejimida demo adapter ID beradi.
- Dashboard tarixiy ma’lumotni faqat `data_collection_started_at` dan boshlab ishonchli ko‘rsatadi.
