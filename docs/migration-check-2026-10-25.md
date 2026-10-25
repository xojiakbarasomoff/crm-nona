# Migratsiya isboti: eski sxema → yangi sxema (2026-10-25)

Maqsad: `20261025000000_suppliers_finance_documents` va `20261025000100_order_operator_refunds_cost_permission` migratsiyalari eski ma’lumotni (buyurtmalar, xizmatlar, to‘lovlar, hujjatlar, audit, summalar) o‘zgartirmasligini isbotlash.

## Usul

`npm run test:migration` (`tests/migration/legacy-upgrade.test.ts`):

1. `crm_mig_<vaqt>` nomli **vaqtinchalik** baza yaratiladi (foydalanuvchining `crm` bazasi ishlatilmaydi; faqat lokal xost; `migrate reset` ishlatilmaydi).
2. Faqat xususiyatdan oldingi 5 ta migratsiya (`20261024*`) qo‘llanadi — eski sxema.
3. Eski sxemaga mos ma’lumot kiritiladi: 3 buyurtma (tasdiqlangan 12 345,67 USD; narxsiz qoralama; bekor qilingan 999,00 EUR), 3 xizmat qatori (biri summasiz), yo‘lovchi, 4 to‘lov/qaytarim, 2 hujjat (`clean`, `pending`), 2 audit yozuvi.
4. Har bir jadvalning **eski ustunlari** bo‘yicha qator soni va `md5` kontrol yig‘indisi olinadi.
5. Birinchi xususiyat migratsiyasi qo‘llanadi; foydalanuvchi lidga turoperator tanlagan holat modellashtiriladi; ikkinchi migratsiya qo‘llanadi (`prisma migrate deploy`).
6. Tekshiriladi.

## Natija (9/9 o‘tdi)

| # | Tekshiruv | Natija |
| --- | --- | --- |
| 1 | Eski sxemada `suppliers`, `supplier_refunds`, `net_price_minor`, `tour_operator_id` yo‘q | ✅ |
| 2 | Eski ma’lumot kiritildi (3 buyurtma, 3 xizmat, 2 hujjat) | ✅ |
| 3 | 7 migratsiyaning hammasi `finished_at` bilan, `rolled_back_at` yo‘q | ✅ |
| 4 | 11 ta jadvalning eski ustunlari: qator soni va `md5` **bir xil** | ✅ |
| 5 | Summalar (1 234 567 / NULL / 99 900), valyutalar, holatlar, to‘lovlar yig‘indisi (to‘lov 1 099 900, qaytarim 149 900), hujjat nomi/sha256/skan holati/hajmi, audit soni — aynan saqlangan; summasiz xizmat qatori 0 ga aylanmagan | ✅ |
| 6 | Yangi ustunlar: tannarx `NULL` (0 emas), hujjat kategoriyasi `other`, `supplier_refunds` bo‘sh, qo‘shimcha huquqlar bo‘sh | ✅ |
| 7 | `orders.tour_operator_id` lidning migratsiya paytidagi tanlovidan **tiklangan** (tarixiy tasdiqlangan qiymat emas, qarang `KNOWN_LIMITATIONS.md`); tanlovsiz buyurtma `NULL`; migratsiya hech qanday sun’iy turoperator/buyurtma/xizmat qo‘shmagan | ✅ |
| 8 | `NOT VALID` CHECK eski qatorni rad etmaydi, yangi noto‘g‘ri qiymatni (manfiy yoki valyutasiz tannarx, noma’lum huquq) rad etadi | ✅ |
| 9 | Yangi dastur kodi (`OrdersService.getOrder`) eski buyurtmani o‘qiydi: foyda «aniqlanmagan» (0 emas), tannarx yo‘q; huquqsiz menejerga foyda maydoni berilmaydi | ✅ |

## Foydalanuvchining lokal bazasi

Ikkinchi migratsiya `crm` bazasiga faqat shu isbotdan keyin, **non-destructive** `prisma migrate deploy` bilan qo‘llandi; oldin `pg_dump` zaxira olindi. Qator soni migratsiyadan oldin va keyin bir xil: buyurtma 38, xizmat 21, hujjat 20, to‘lov 3.

## Cheklov

Test lokal PostgreSQL 16 da bajarildi. Railway (production) bazasiga bu migratsiyalar hali qo‘llanmagan va qo‘llanmaydi — main’ga merge/deploy qilinmaguncha.
