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

- **ClamAV (clamd)**: protokol implement qilingan va soxta clamd bilan contract-testlangan; haqiqiy clamd bilan sinalmagan. Production’da `SCANNER=clamav` majburiy (builtin faqat EICAR’ni taniydi va demo’dan tashqarida rad etiladi).
- **Object storage**: faqat lokal private katalog adapteri bor. S3-mos storage adapteri yozilmagan; production uchun shifrlangan, backup qilinadigan volume yoki adapter qo‘shish kerak.
- **PITR production**: konfiguratsiya va yo‘riqnoma bor, lokal mashq o‘tgan; off-site (object storage) WAL arxivi, haqiqiy hajmdagi RTO ≤ 4 soat mashqi, boshqariladigan PostgreSQL bajarilmagan.
- Staging/production deploy, TLS, secret manager, hosting hududi, Docker registry, image imzolash va zaiflik skanerlash.
- Unumdorlikni ajratilgan 4 vCPU/8 GB muhitda qayta o‘lchash (hozirgi raqamlar noutbukda).
- Tashqi alerting kanali (metrikalar `/integrations` sahifasida va Redis hisoblagichlarida; Prometheus eksporti yo‘q).

## 3. Kompaniya qarori kerak

- Retention muddatlari: taklif (webhook 30 kun, texnik log 90 kun, yozishma 12 oy) kiritilgan, lekin **kompaniya tasdiqlamaguncha tozalash o‘chirilgan**. Audit, buyurtma va to‘lov saqlash muddati siyosati.
- Telefon raqami uchun standart mamlakat qoidasi (`phoneRule.confirmed=false`), ish jadvali, SLA, sticky owner, navbatchi — hozir seed qiymatlari; sozlamalar UI’si yo‘q.
- Hosting hududi va Meta/amoCRM’ga uzatiladigan shaxsiy ma’lumotlar doirasi.

## 4. Ma’lum texnik cheklovlar

- Audit yozuvlari o‘zgarmas: PII o‘chirishda audit `old/new` qiymatlaridagi shaxsiy ma’lumot qoladi (siyosat bo‘yicha saqlanadi).
- PII o‘chirilgandan keyin amoCRM kontakti va chat tarixi avtomatik o‘chirilmaydi — operator vazifasi ochiladi.
- Dublikat merge: amoCRM’da ikki kontakt bo‘lsa `merge_pending_amocrm` holatida qoladi.
- Kontakt ismi/telefonini web’dan amoCRM’ga yozish yo‘li yo‘q (faqat amoCRM’da tahrirlanadi va proyeksiyalanadi).
- `ENCRYPTION_KEY` rotatsiyasi uchun qayta shifrlash skripti yo‘q.
- Prisma 7: so‘rov rejasi va natijani map qilish Node process’ida — dashboard 20 parallelda 1,7–1,8 s (maqsad 2 s, zaxira kam). `$queryRaw` `void` ustunni o‘qimaydi.
- Mahalliy ishlab chiqish uchun Node ≥ 22.12 kerak (tavsiya 22.23.4).
- Next.js 15 va NestJS 11 hali patch oladi; 16/12 major’ga o‘tish alohida vazifa.
- AC10 bir marta yuklangan mashinada to‘liq suite’da muvaffaqiyatsiz bo‘ldi va qayta tiklanmadi; test diagnostika bilan kuchaytirilgan.
