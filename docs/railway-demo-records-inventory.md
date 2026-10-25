# Railway demo bazasidagi sun’iy yozuvlar ro‘yxati (faqat o‘qish, 2026-10-25)

**Hech narsa o‘chirilmagan va o‘zgartirilmagan.** Ro‘yxat Railway production muhitidagi ilovaga demo rahbar hisobi (`user1`) bilan kirib, faqat `GET` so‘rovlari orqali tuzildi (login sessiya va `login` auditini yaratadi — boshqa yozuv yo‘q). Ilova rejimi: `appMode=demo`, kirgan rol: `HEAD`.

## Muhim aniqlik: turoperator/narx yozuvlari yo‘q

Railway’da hozir `main` kodi ishlaydi (bu feature-branch deploy qilinmagan): `GET /api/v1/suppliers` → **404**, ya’ni `suppliers`/`supplier_refunds` jadvallari va `net_price_minor` ustuni u yerda yo‘q. Shuning uchun Railway’da **sun’iy turoperator va tannarx yozuvlari yo‘q**. Oldingi hisobotimdagi «Railway’da sun’iy turoperator/buyurtmalar bor» degan gapim noto‘g‘ri edi: bor narsa — sun’iy lidlar, buyurtmalar va to‘lovlar (quyida).

## Demo ekanining dalillari

- 5 ta buyurtmaning hammasida `sale_evidence = «Demo kvitansiya (sun’iy)»`.
- Hammasi 2026-10-24 19:11–19:12 UTC oralig‘ida bir necha soniyada yaratilgan (skript bilan), lidlar `/api/v1/demo/lead-ads` orqali (kanal `meta_lead_ads`/`instagram_lead_ads`, amoCRM ID 50000001+ — demo amoCRM adapteri).
- Ilova `APP_MODE=demo`; mijoz ismlari to‘qima (real mijoz yo‘q).

## Buyurtmalar (5) va ularga bog‘langan yozuvlar

| Buyurtma | ID | Lid (ID) | Kontakt (ID) | Summa | Holat | To‘lovlar (ID) |
| --- | --- | --- | --- | --- | --- | --- |
| TR-2026-000001 | cbb2349e-940b-44db-8644-13b7d2b7cfe7 | Xolmatov Sardor — Seul (20eddf38-4e3f-4651-92cb-5da9f75f671d) | Xolmatov Sardor (eb1b748a-8b7c-4ae7-8866-0d720e6bf6e5) | 9000000.00 UZS | draft/paid | be03e48f-f221-406b-b531-2d711fb90c73 (payment 9000000.00 UZS) |
| TR-2026-000002 | 9e7fdb93-e800-4f19-a412-e664d94d3d24 | Saidova Gulnora — Maldiv (3c03529c-d448-4f2e-bf55-31baa00a145f) | Saidova Gulnora (1eece9fc-fc5f-49da-8f01-51aad42c7329) | 12500000.00 UZS | draft/partial | 72082361-fe02-4cd4-b360-0b7b3a6f29fd (payment 6250000.00 UZS) |
| TR-2026-000003 | da868a01-cf97-482a-9efd-19853c414739 | Mirzayev Davron — Baku (0752065a-0279-4c2f-9a32-04433f0f4e34) | Mirzayev Davron (68ca4370-c494-46ce-b1c3-bd78880c7579) | 16000000.00 UZS | draft/paid | 9a140971-e691-4914-829a-f7a87855abde (payment 16000000.00 UZS) |
| TR-2026-000004 | 3db1ca70-0c55-492f-9771-68b6e357d7cb | Rustamov Farhod — Dubay (8c8579b8-041c-4f8f-8435-2fc209e38230) | Rustamov Farhod (244a37a4-e539-483a-87aa-caf8c42849ef) | 19500000.00 UZS | draft/partial | 09118999-21ce-4b6b-b5c6-3df3a8bb2773 (payment 9750000.00 UZS) |
| TR-2026-000005 | 0a5f7462-3b15-45d1-8489-e2e828a86265 | Abdullayeva Malika — Kuala-Lumpur (5f0db318-766c-4376-828e-01501d3861f8) | Abdullayeva Malika (44ffdf8b-a89f-435e-bf77-851cfb45c2a5) | 23000000.00 UZS | draft/paid | 12c6a94b-cea6-4235-ac96-6233de96b644 (payment 23000000.00 UZS) |

Buyurtmalarda xizmat qatorlari: 0, yo‘lovchilar: 0.

## Lidlar (16) va kontaktlar (16)

Hammasi sun’iy demo lidlar (2026-10-24 19:11–19:12 UTC). Buyurtmasi bor lidlar oxirgi ustunda.

| Lid | ID | Kontakt ID | Bosqich | Yaratilgan | Buyurtma |
| --- | --- | --- | --- | --- | --- |
| Xolmatov Sardor — Seul | 20eddf38-4e3f-4651-92cb-5da9f75f671d | eb1b748a-8b7c-4ae7-8866-0d720e6bf6e5 | NEW | 2026-10-24T19:12:01.708Z | TR-2026-000001 |
| Saidova Gulnora — Maldiv | 3c03529c-d448-4f2e-bf55-31baa00a145f | 1eece9fc-fc5f-49da-8f01-51aad42c7329 | NEW | 2026-10-24T19:12:00.700Z | TR-2026-000002 |
| Mirzayev Davron — Baku | 0752065a-0279-4c2f-9a32-04433f0f4e34 | 68ca4370-c494-46ce-b1c3-bd78880c7579 | WON | 2026-10-24T19:12:00.699Z | TR-2026-000003 |
| Rustamov Farhod — Dubay | 8c8579b8-041c-4f8f-8435-2fc209e38230 | 244a37a4-e539-483a-87aa-caf8c42849ef | WON | 2026-10-24T19:11:59.713Z | TR-2026-000004 |
| Abdullayeva Malika — Kuala-Lumpur | 5f0db318-766c-4376-828e-01501d3861f8 | 44ffdf8b-a89f-435e-bf77-851cfb45c2a5 | WON | 2026-10-24T19:11:59.712Z | TR-2026-000005 |
| Ismoilova Zarina — Antalya | 2bf43219-6e11-4ea2-b542-82aaa141de4f | d238f07d-1f8c-4a7a-af22-6c485e8d38f0 | CONTACTED | 2026-10-24T19:11:58.711Z | — |
| Nazarov Ulugbek — Istanbul | 462e9448-ce1b-418c-9c1e-4d41284afa2b | 6ff9f125-6fec-42b6-a7e6-d79f6ca7cb46 | CONTACTED | 2026-10-24T19:11:58.709Z | — |
| Hamidova Shahlo — Bali | 12f4399c-c058-4d11-82f6-0f9bf9ccd74d | 5023b59c-7444-4165-9977-1a780c4e9eb4 | CONTACTED | 2026-10-24T19:11:57.714Z | — |
| Qodirov Otabek — Tbilisi | 31a2f7b0-ee2d-4f22-9304-0fe96f82f760 | 2b6d4a53-f5b2-41c9-810e-f88c53ad5e2d | QUALIFIED | 2026-10-24T19:11:57.707Z | — |
| Yusupova Dilfuza — Dubay | 95cdc33d-6d57-4439-9dfa-24b05821d2a8 | 1187db16-65e8-47ed-8a54-046603c8157d | QUALIFIED | 2026-10-24T19:11:56.743Z | — |
| Tursunov Akmal — Sharm-el-Sheyx | 936fcb54-c468-4e62-ba34-0141a1020b59 | c8511285-e5cf-42fe-b445-8f0d4328a15a | FOLLOW_UP | 2026-10-24T19:11:56.741Z | — |
| Ergasheva Madina — Antalya | e45fe992-7f87-417f-ab22-35b7bf1c317f | 3e53499a-2408-486f-8d41-7a45852179af | LOST | 2026-10-24T19:11:55.710Z | — |
| Aliyev Bobur — Maldiv | 796902af-f200-41b0-a34e-437912bc6eb0 | 92dfe30b-c7cc-4029-ae0b-623e78667bbe | LOST | 2026-10-24T19:11:54.722Z | — |
| Sobirov Jasur — Seul | 5a97b889-98af-48b6-9325-2280b0b8b5f6 | 155679c4-7347-4330-9dd0-8c6d36ebd738 | NEW | 2026-10-24T19:11:54.718Z | — |
| Rahimova Nigora — Dubay | 5b8b7595-602e-4b64-8a05-f8bf719f9da9 | 5d5be92e-e272-4476-a335-954cdbf309cb | NEW | 2026-10-24T19:11:53.729Z | — |
| Karimov Sherzod — Istanbul | 51a7de90-6854-4162-a85b-21d7f89e700d | 6ba847c3-716e-425d-aa37-34860689c916 | NEW | 2026-10-24T19:11:53.726Z | — |

## Ro‘yxatga kirmagan yon yozuvlar (API orqali sanab bo‘lmaydi)

Quyidagilar shu lidlar bilan birga avtomatik yaratilgan bo‘lishi mumkin, lekin faqat o‘qish API’si ularni to‘liq sanamaydi; o‘chirishdan oldin to‘g‘ridan-to‘g‘ri (faqat o‘qish) SQL bilan tekshirish kerak: `inquiries`, `conversations`/`messages`, `crm_tasks`, `reminder_*`, `notifications`, `audit_logs` (`entity_id` = yuqoridagi ID’lar), `outbox_operations`, `integration_mappings`, hamda demo amoCRM adapterining Redis kalitlari (`demo:*`). `railway ssh` ishlatilmadi (u hisobga SSH kalit qo‘shishni talab qiladi).

## O‘chirish haqida

Hozircha **o‘chirilmaydi** (so‘rovingiz). O‘chirilsa, tartib: to‘lovlar → buyurtmalar → lidlar → kontaktlar (FK’lar `RESTRICT`; to‘lov/buyurtma o‘chirishni bazadagi triggerlar bloklashi mumkin, shuning uchun alohida, tekshirilgan skript va zaxira nusxa kerak).
