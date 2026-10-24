# Known limitations

Holat: 2026-10-24. Tizim **production tayyor emas** — quyidagi bloklar tashqi akkaunt yoki infratuzilmaga bog‘liq. Credential talab qilmaydigan majburiy funksiyalar kod va testlar bilan yopilgan (`docs/acceptance-matrix.md`).

## 1. Tashqi akkauntga bog‘liq (⛔)

- **G01–G09 live sinovlari bajarilmagan** — amoCRM test akkaunti va integratsiya kalitlari, Meta App / Page / Instagram professional akkaunt / test lead-forma, amoCRM Chats kanali (`channel_id`, `secret`) yo‘q (`docs/feasibility.md`). `npm run smoke:live` haqiqiy javobsiz hech qachon «passed» demaydi.
- Shu sababli tasdiqlanmagan: amoCRM REST/Chats va Meta Graph javob shakllari (contract testlar sintetik fixture’larda), Chats API imzo formati va `scope_id`, amojo sender ID ↔ `user_id` xaritasi, `leads?query=` bilan operation ID qidiruvi, Lead objektidagi `platform`, referral shakli, Lead Ads saqlanish oynasi (`META_LEADS_RETENTION_DAYS=90` taxmin), Meta javob oynalari (G07).
- AC06 (Instagram’da haqiqiy javob qabul qilinishi), AC36 (staging end-to-end).
- Direct yo‘li vaqtinchalik `custom_channel` (ADR 0002) — yakuniy tanlov G08 dan keyin.
- amoCRM native rollarini menejer faqat o‘z chatini ko‘radigan qilib sozlash — akkauntda qo‘lda.
- Direct tarixini import qilish chuqurligi (G09).

## 2. Infratuzilmaga bog‘liq (⛔)

- **ClamAV production deploy**: haqiqiy `clamav/clamav:1.4.3` daemon bilan lokal sinalgan (`npm run test:services`, 12 test). Production’da clamd’ni joylashtirish, signatura yangilanishi (freshclam) monitoringi va yuklama ostida skan vaqti sinalmagan.
- **Bulutli object storage**: S3-mos adapter implement qilingan va lokal SeaweedFS’da sinalgan (private bucket, anonim o‘qish rad etiladi). Haqiqiy bulut provayderi (AWS S3, Cloudflare R2, Yandex Object Storage va h.k.), server-side shifrlash (`S3_SSE`), versioning va lifecycle siyosati provayderda sozlanmagan va sinalmagan.
- **PITR production**: konfiguratsiya va yo‘riqnoma bor, lokal mashq o‘tgan; off-site (object storage) WAL arxivi, haqiqiy hajmdagi RTO ≤ 4 soat mashqi, boshqariladigan PostgreSQL bajarilmagan.
- Staging/production deploy, TLS, secret manager, hosting hududi, Docker registry, image imzolash va zaiflik skanerlash.
- Unumdorlikni ajratilgan 4 vCPU/8 GB muhitda qayta o‘lchash (hozirgi raqamlar noutbukda).
- Tashqi alerting kanali (metrikalar `/integrations` sahifasida va Redis hisoblagichlarida; Prometheus eksporti yo‘q).

## 3. Kompaniya qarori kerak

- Retention muddatlari: taklif (webhook 30 kun, texnik log 90 kun, yozishma 12 oy) kiritilgan, lekin **kompaniya tasdiqlamaguncha tozalash o‘chirilgan**. Audit, buyurtma va to‘lov saqlash muddati siyosati.
- Telefon raqami uchun standart mamlakat qoidasi (`phoneRule.confirmed=false`), ish jadvali, SLA, sticky owner, navbatchi — hozir seed qiymatlari; sozlamalar UI’si yo‘q.
- Hosting hududi va Meta/amoCRM’ga uzatiladigan shaxsiy ma’lumotlar doirasi.

## 3a. Moliya va hujjatlar (2026-10-25, `docs/tz-addendum-finance.md`)

- **Foyda = sotuv − tannarx** (mijoz talabi, v1). Komissiya, soliq, bank to‘lovlari va valyuta farqi hisobga olinmaydi: bu buxgalteriya «sof foydasi» emas. Interfeys buni aytadi.
- **Valyuta kursi yo‘q:** bir nechta valyuta bo‘yicha yagona jami hisoblanmaydi; har valyuta alohida. Kurs manbai va sana qoidasi (TZ §12.3) tasdiqlanmaguncha konvertatsiya qo‘shilmaydi.
- **Turoperator kesimi lid darajasida:** turoperator lidga biriktiriladi. Uni keyin o‘zgartirsangiz, o‘tmishdagi sotuvlar dashboard’da yangi turoperator ostida guruhlanadi (narxlar o‘zgarmaydi; turoperatorning tarixiy snapshot’i saqlanmaydi). Xizmat qatoridagi yetkazib beruvchilar kesimi dashboard’da hali yo‘q (har qatorda saqlanadi va eksport/API orqali olinadi).
- **Menejer o‘z buyurtmalarida tannarx va foydani ko‘radi.** Tannarxni menejerdan yashirish kerak bo‘lsa, alohida capability qo‘shiladi (qaror kerak).
- **Kutilayotgan foyda** faqat ochiq buyurtmalardan (tannarxi ma’lumlari); takliflar (`offers`) tannarx saqlamaydi.
- Olib tashlangan xizmat qatorini tiklash interfeysi yo‘q (qator bazada va auditda saqlanadi).
- Hujjatlar: pasport fayllari uchun storage darajasida shifrlash (S3 SSE) provayderda sozlanmagan/sinalmagan; EXIF/OCR tekshiruvi yo‘q; haqiqiy ClamAV bilan kategoriya oqimi alohida sinalmagan (mavjud `services` testlari fayl oqimini sinaydi).
- **Test beqarorligi (eski, mazkur ishga aloqasiz):** `rbac-auth` dagi 2 ta integratsiya testi haqiqiy soatga bog‘liq: menejerlar faqat 09:00–19:00 (Asia/Tashkent) da navbatga olinadi, shu oraliqdan tashqarida yiqiladi (tuzatish: testda soatni qotirish).

## 4. Ma’lum texnik cheklovlar

- Audit yozuvlari o‘zgarmas: PII o‘chirishda audit `old/new` qiymatlaridagi shaxsiy ma’lumot qoladi (siyosat bo‘yicha saqlanadi).
- PII o‘chirilgandan keyin amoCRM kontakti va chat tarixi avtomatik o‘chirilmaydi — operator vazifasi ochiladi.
- Dublikat merge: amoCRM’da ikki kontakt bo‘lsa `merge_pending_amocrm` holatida qoladi.
- Kontakt ismi/telefonini web’dan amoCRM’ga yozish yo‘li yo‘q (faqat amoCRM’da tahrirlanadi va proyeksiyalanadi).
- `ENCRYPTION_KEY` rotatsiyasi uchun qayta shifrlash skripti yo‘q.
- Prisma 7: so‘rov rejasi va natijani map qilish Node process’ida — dashboard 20 parallelda 1,7–1,8 s (maqsad 2 s, zaxira kam). `$queryRaw` `void` ustunni o‘qimaydi.
- Node: ilova runtime’i Node 22.11 da ham ishlaydi, lekin `npm ci`/`npm install`, `prisma migrate|generate` va testlar Node ≥ 22.12 talab qiladi (Prisma 7). Tavsiya: 22.23.4 (`.nvmrc`).
- Next.js 15 va NestJS 11 hali patch oladi; 16/12 major’ga o‘tish alohida vazifa.
- Builtin (demo) skaner EICAR qatorini fayl ichida istalgan joyda topadi; haqiqiy ClamAV EICAR standartiga ko‘ra uni faqat fayl boshida taniydi (arxiv ichidagi faylda ham). Demo va real skaner natijalari shu holatda farq qiladi.
