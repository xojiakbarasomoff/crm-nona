# TZ qo‘shimchasi: turoperatorlar, tannarx/foyda, hujjatlar

Sana: 2026-10-25 · Holat: implement qilingan, lokal demoda sinalgan; **production deploy qilinmagan**.
Bu qo‘shimcha `docs/TZ.md` ni to‘ldiradi; Facebook/Instagram integratsiyasiga tegmaydi (u hali kutilmoqda).

## A. Turoperatorlar va xizmat yetkazib beruvchilar

**Ma’lumotnoma** (`suppliers`): kompaniya nomi, mas’ul shaxs, telefon, email, izoh, holat (faol / arxiv), turi
(`tour_operator`, `hotel`, `transfer`, `airline`, `other`). Nom kompaniya ichida katta-kichik harfga qaramay noyob.

| Qoida | Tafsilot |
| --- | --- |
| Reklama manbasi bilan aralashmaydi | Manba — `leads.first_source` («Instagram Ads»: mijoz qayerdan kelgan). Turoperator — `leads.tour_operator_id` (xizmatni kim yetkazadi). Ikki alohida maydon, UI’da alohida bo‘limlar. |
| Lid darajasida bitta manba | Turoperator **lidda** saqlanadi; buyurtma kartasi uni lid orqali ko‘rsatadi (nusxa yo‘q). Lidga faqat `tour_operator` turidagi, faol yetkazib beruvchi tanlanadi. |
| Xizmat yetkazib beruvchisi | Har bir xizmat qatorida (mehmonxona, transfer, avia…) alohida `supplier_id`. |
| Arxiv | Arxivdagi yangi tanlanmaydi (422 `SUPPLIER_ARCHIVED`); eski tanlov va narxlar o‘zgarmaydi. |
| Tarixiy narxlar | Narxlar buyurtma/xizmat qatorlarida saqlanadi; ma’lumotnomada nom, aloqa yoki holat o‘zgarsa, eski kelishilgan narxlar o‘zgarmaydi. |
| Audit | Yaratish, tahrirlash, arxivlash/tiklash — `audit_logs` (eski/yangi qiymat). |

## B. Tannarx, sotuv va foyda

Maydonlar (buyurtma/paket darajasida va har bir xizmat qatorida):
**Net price** (tannarx, turoperator/yetkazib beruvchidan) · **Selling price** (sotuv, mijozga) · **Currency** ·
**Profit** (hisoblanadi, saqlanmaydi, tahrirlanmaydi).

> **Foyda = sotuv narxi − tannarx.**
> Qo‘shimcha xarajatlar (komissiya, soliq, bank to‘lovlari, valyuta farqi) hisobga olinmagan; bu buxgalteriya bo‘yicha
> yakuniy «sof foyda» emas. Interfeys buni har joyda aytadi.

Hisob qoidalari (`packages/domain/src/finance.ts`, sof funksiyalar, 18 ta unit test):

1. **Pul** — `bigint` minor birliklar (`parseMoney/formatMoney`); floating point yo‘q. Manfiy foyda to‘g‘ri ko‘rsatiladi. Sotuv va tannarx manfiy kiritilmaydi (DB CHECK + API 422).
2. **Valyutalar** hech qachon kurssiz qo‘shilmaydi: har bir hisob valyuta bo‘yicha alohida; valyuta filtri mavjud. Valyutani o‘zgartirishda sotuv va tannarx qayta kiritilishi shart (422 `CURRENCY_CHANGE_REQUIRES_AMOUNTS`) — jimgina qayta nomlash yo‘q.
3. **Tannarx noma’lum = `NULL`**, hech qachon `0` emas. Eski buyurtmalar migratsiyadan keyin ham `NULL`. Foyda «Aniqlanmagan»; dashboard bunday buyurtmalar sonini ko‘rsatadi va ular tannarx/foyda jamiga kirmaydi. (Tannarx `0` aniq kiritilsa — bu haqiqiy qiymat, foyda = sotuv.)
4. **Paket va xizmatlar ikki marta sanalmaydi.** Jami = paket narxi + paketdan **tashqari** xizmatlar yig‘indisi. `included_in_package = true` xizmat ma’lumot uchun ko‘rsatiladi, yig‘indiga qo‘shilmaydi. Paket narxi yo‘q bo‘lsa — jami xizmatlar yig‘indisi. Xizmat qatori olib tashlansa (soft-delete, `removed_at`) hisobdan chiqadi, tarixi auditda qoladi.
5. Bir valyutada bitta qatorda tannarx yo‘q bo‘lsa, shu valyutaning foydasi butunlay «aniqlanmagan» (qisman yig‘indi 0 sifatida sanalmaydi).
6. **WON** uchun «kelishilgan summa» paket narxi **yoki** paketdan tashqari narxli xizmat bo‘lishi mumkin.
7. To‘lov holati (`unpaid/partial/paid`) jami sotuvga (yagona valyutada) nisbatan hisoblanadi; bir nechta valyuta bo‘lsa — avtomatik hisoblanmaydi, izoh chiqadi.
8. **Narx o‘zgarishlari auditga yoziladi**: `price_updated` (buyurtma), `service_added`, `service_price_updated`, `service_removed` — eski va yangi qiymatlar bilan.
9. **amoCRM’ga tannarx va foyda yuborilmaydi.** `order.summary` oq ro‘yxatli maydonlarni yuboradi; `local_amount` — faqat sotuv jami (xizmatlar bilan, yagona valyutada). Test: `finance.test.ts › amoCRM ga tannarx va foyda chiqmaydi`.

## C. Dashboard (moliya bo‘limi)

**Tasdiqlangan sotuv** = davrda birinchi marta «Sotuv yakunlandi» (WON) bo‘lgan lidlarning, bekor qilinmagan va to‘liq qaytarilmagan buyurtmalari.

Ko‘rsatkichlar (valyuta bo‘yicha): jami sotuv · jami tannarx · hisoblangan foyda (+marja) · foyda aniqlanmagan buyurtmalar soni (va ularning sotuvi) ·
**Kutilayotgan foyda** (ochiq buyurtmalar, tannarxi ma’lumlari; tasdiqlangan emas) · bekor qilingan va to‘liq qaytarilgan buyurtmalar · turoperatorlar va menejerlar kesimida sotuv/foyda.

*Jami tannarx* va *foyda* faqat tannarxi to‘liq ma’lum buyurtmalar bo‘yicha (aks holda «sotuv − tannarx ≠ foyda» bo‘lib qolardi); tannarxsiz buyurtmalar alohida satrda.

Filtrlar: **davr, menejer (`ownerId`), turoperator (`tourOperatorId`), xizmat turi (`serviceType`), valyuta (`currency`)** (+ mavjud: manba, bosqich, reys sanasi).

Bekor qilish va qaytarim qoidalari:

| Holat | Jami sotuv/foydaga | Qayerda ko‘rinadi |
| --- | --- | --- |
| Buyurtma bekor qilindi | **kirmaydi** | «Bekor qilingan buyurtmalar» (davrda bekor qilinganlar, tarixiy summa bilan). Tarixiy summalar **o‘chirilmaydi**, bekor qilingan buyurtma tahrirlanmaydi. |
| To‘liq qaytarim (`paymentState = refunded`) | **kirmaydi** | «To‘liq qaytarilgan». |
| Qisman qaytarim | **foydani o‘zgartirmaydi** | «Qaytarimlar» (pul harakati) alohida; to‘lov holati `partial`. |
| Ochiq buyurtma | tasdiqlangan jamiga kirmaydi | «Kutilayotgan foyda». |

Menejer kesimi — yopilish paytidagi mas’ul (mavjud qoidaga mos). Turoperator kesimi — lidga biriktirilgan turoperator
(turoperator keyin o‘zgartirilsa, o‘tmishdagi sotuv yangi turoperator ostida guruhlanadi; narxlar o‘zgarmaydi).

**Eksport:** `GET /api/v1/exports/orders.csv` (sotuv, tannarx, foyda, holat) — faqat `export` huquqi (rahbar, administrator), auditga yoziladi; tannarxi noma’lum buyurtmada foyda bo‘sh va `profit_state=undetermined`.

## D. Lid va buyurtma kartalari — bo‘limlar va ma’lumot manbalari

| Bo‘lim | Manba (bitta; nusxa yo‘q) |
| --- | --- |
| Mijoz ma’lumotlari va aloqa tarixi | `contacts` + `conversations/messages` (buyurtma kartasi so‘nggi 5 xabarni va mijoz kartasiga havolani ko‘rsatadi) |
| Safar talablari | `leads.requirements` (kartada faqat o‘qiladi, tahrir — lid kartasida) |
| Yo‘lovchilar | `passengers` (buyurtma) |
| Turpaket va turoperator | `leads.tour_operator_id`; paket narxi — `orders.agreed_amount_minor`, `orders.net_price_minor` |
| Mehmonxona (nomi, manzil, kirish/chiqish, xona, ovqatlanish) | `order_services` (`service_type=hotel`, `details`) |
| Transfer (yo‘nalish, sana-vaqt, transport, yetkazib beruvchi) | `order_services` (`service_type=transfer`, `details`, `supplier_id`) |
| Parvozlar | mavjud ko‘p segmentli reyslar moduli (`flight_segments`), o‘zgarmadi |
| Tannarx, sotuv, foyda, to‘lovlar | `orders`/`order_services`/`payments`; foyda — hisoblanadi |
| Hujjatlar | `attachments` (kategoriya + egasi) |
| Izohlar, vazifalar, tarix | `orders.note`, `reminder_occurrences`, `audit_logs` |

Tafsilotlar zod bilan tekshiriladi: mehmonxona (nom, `checkOut > checkIn`), transfer (yo‘nalish, sana-vaqt).

## E. Hujjatlar

Kategoriyalar: `passport`, `invoice` (hisob-faktura), `payment_receipt` (to‘lov cheki), `air_ticket` (aviachipta), `voucher` (mehmonxona/tur vaucheri), `other`.
Bog‘lash (`ownerType`): `contact` (mijoz), `order` (buyurtma), `passenger` (yo‘lovchi), + mavjud `lead`, `offer`. Buyurtma kartasida (`related=1`) buyurtma, yo‘lovchilar va mijoz hujjatlari bitta ro‘yxatda, egasi bilan.

Xavfsizlik (mavjud mexanizm qayta ishlatildi + qo‘shimcha):
- private storage, virus tekshiruvi (skandan o‘tmaguncha yuklab bo‘lmaydi), foydalanuvchiga bog‘langan qisqa muddatli imzolangan havola, `Cache-Control: no-store`, `Content-Disposition: attachment`, CSP sandbox;
- **har bir so‘rovda backend huquqni tekshiradi** (egasi obyekt orqali: boshqa menejerning buyurtma/yo‘lovchi/mijoz hujjati → 404);
- pasport: faqat PDF/rasm (ofis fayli 422); ro‘yxatda fayl nomi o‘rniga «Pasport nusxasi»; audit va jurnallarga **fayl nomi yozilmaydi**; so‘rov jurnali faqat `path` (imzo/query yo‘q);
- kategoriya keyin o‘zgartirilishi mumkin (`PATCH /attachments/{id}`), audit bilan.

## F. Huquqlar

| Amal | Administrator | Rahbar | Menejer |
| --- | --- | --- | --- |
| Turoperatorlar ro‘yxati (nom, tur, holat) | ha | ha | ha |
| Aloqa ma’lumotlari | ha | ha | yo‘q |
| Ma’lumotnomani o‘zgartirish/arxivlash (`suppliers.manage`) | ha | ha | yo‘q (403) |
| Lidga turoperator tanlash | ha | ha | faqat o‘z lidi |
| Narx, tannarx, xizmat qatorlari | hammasi | hammasi | faqat o‘z buyurtmasi (boshqasi 404) |
| Dashboard moliyasi | kompaniya | kompaniya | faqat o‘z doirasi |
| `orders.csv` / `leads.csv` eksport | ha | ha | yo‘q (403) |
| Hujjatlar | hammasi | hammasi | faqat o‘z obyektlari (boshqasi 404) |

Qaror: menejer **o‘z** buyurtmalarida tannarx va foydani ko‘radi («menejer faqat o‘ziga tegishli ma’lumotlarni ko‘rsin»). Kompaniya tannarxni menejerdan yashirmoqchi bo‘lsa — alohida capability (`finance.cost.view`) qo‘shiladi (hozir yo‘q).

## G. Migratsiya

`packages/database/prisma/migrations/20261025000000_suppliers_finance_documents/migration.sql` — **expand-only**: yangi `suppliers` jadvali;
`leads.tour_operator_id`; `orders.net_price_minor`; `order_services.net_minor/supplier_id/included_in_package/details/removed_at/updated_at`;
`attachments.category`. Mavjud qatorlar o‘zgarmaydi (tannarx `NULL`, kategoriya `other`). Yangi CHECK’lar `NOT VALID`
(eski qatorlar tekshirilmaydi, yangilari tekshiriladi). Kompozit tenant FK’lar (`leads_tour_operator_fk`, `order_services_supplier_fk`).
Qo‘llash: `npm run db:migrate` (`prisma migrate deploy`); baza reset qilinmaydi. Rollback: ustunlar ishlatilmasa zarar yo‘q; qaytarish uchun yangi «contract» migratsiyasi yoziladi (eski kod yangi ustunlarsiz ishlay oladi).

## H. API (yangi/o‘zgargan) — `docs/openapi.json`

`GET/POST /suppliers`, `PATCH /suppliers/{id}` · `POST /orders/{id}/services` (kengaytirilgan), `PATCH/DELETE /services/{id}` ·
`PATCH /orders/{id}` (`netPrice`) · `GET /orders/{id}` (`finance`, `suppliers`, `tourOperator`) · `PATCH /leads/{id}` (`tourOperatorId`) ·
`GET /dashboard` (+`tourOperatorId`, `currency`, `finance`) · `GET /exports/orders.csv` ·
`POST/GET /attachments` (`category`, `ownerType` kengaytirilgan, `related`), `PATCH /attachments/{id}`.

## I. Qabul mezonlari va testlar

| ID | Mezon | Test |
| --- | --- | --- |
| AC37 | 1 200 sotuv, 1 000 tannarx → 200 foyda; karta = dashboard | unit `finance.test.ts`; integration `finance.test.ts › 1 200 sotuv…` |
| AC38 | Manfiy foyda | unit + integration `manfiy foyda…` |
| AC39 | Tannarxi noma’lum eski buyurtma: «aniqlanmagan», 0 emas, dashboard soni | unit + integration `tannarxi noma’lum…` |
| AC40 | Turli valyutalar kurssiz qo‘shilmaydi; valyuta filtri; valyutani jimgina almashtirib bo‘lmaydi | unit + integration `turli valyutalar…` |
| AC41 | Paket va xizmatlar ikki marta sanalmaydi | unit + integration `paket narxi va uning ichidagi…` |
| AC42 | Bekor qilish va qaytarim qoidalari | unit + integration `bekor qilingan…`, `qaytarim…` |
| AC43 | Boshqa menejerning hujjatini ochishga urinish rad etiladi | integration `boshqa menejerning hujjatini…` |
| AC44 | Karta qiymatlari dashboard’da mos chiqadi | integration (AC37, AC41), E2E `finance` |
| AC45 | Turoperator ma’lumotnomasi: huquqlar, arxiv, nom noyobligi, eski narxlar o‘zgarmaydi | integration `turoperatorlar ma’lumotnomasi…` |
| AC46 | Menejer/rahbar doirasi, eksport huquqi | integration `ruxsatlar…` |
| AC47 | Hujjat kategoriyalari, bog‘lash, pasport cheklovi, audit’da fayl nomi yo‘q | integration `hujjatlar…` |
| AC48 | Tannarx/foyda amoCRM’ga chiqmaydi | integration `amoCRM ga…` |

## J. Cheklovlar va ochiq savollar

`KNOWN_LIMITATIONS.md` «Moliya va hujjatlar» bo‘limiga qarang.
