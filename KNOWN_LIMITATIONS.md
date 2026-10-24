# Known limitations

Holat: 2026-10-24. Tizim **production tayyor emas**. Quyidagilar bajarilmagan yoki tashqi dalil talab qiladi.

## 1. Tashqi integratsiyalar (bloklangan)

- G01–G09 live sinovlarining hech biri bajarilmagan: amoCRM test akkaunti, OAuth integratsiya, Meta App / Page / Instagram professional akkaunt, amoCRM Chats kanali mavjud emas (`docs/feasibility.md`).
- amoCRM REST, Chats API va Meta Graph adapterlari hujjatdagi shakllar bo‘yicha yozilgan, lekin **real javob bilan tasdiqlanmagan**. Xususan: Chats API imzo formati, `scope_id` olish, amojo sender ID ↔ amoCRM `user_id` xaritasi, `leads?query=` bilan operation ID qidiruvi, Lead objektidagi `platform` maydoni, Instagram referral shakli.
- Direct yo‘li vaqtinchalik `custom_channel` (ADR 0002); yakuniy tanlov G08 dan keyin.
- Meta javob oynasi (24 soat) va Human Agent oynasi konfiguratsiya; G07 da tasdiqlanishi kerak.
- AC06 (Instagram’da haqiqiy qabul) va AC36 (staging E2E) bajarilmagan.
- amoCRM native rollarini menejerlar faqat o‘z chatini ko‘radigan qilib sozlash akkaunt darajasida qo‘lda bajarilishi va tekshirilishi kerak (TZ §6.1).
- Lead Ads reconciliation (token uzilgan davrdagi lidlarni qayta olish, TZ §8.3) implement qilinmagan; Direct tarixini import qilish (G09) yo‘q.

## 2. Funksional bo‘shliqlar

- Fayllar/attachment: jadval bor, lekin yuklash, MIME/hajm tekshiruvi, virus skaner holati va signed URL endpoint’lari implement qilinmagan (TZ §12.2, §21). Taklifga xavfsiz ilova biriktirib bo‘lmaydi.
- Instagram media attachment’lari faqat metadata sifatida saqlanadi; backend media yuklamaydi (SSRF himoyasi kerak bo‘lmaydi, lekin ko‘rsatish ham yo‘q).
- SLA: birinchi javob muddati hisoblanadi va `first_contact` vazifasining muddati sifatida ishlatiladi, lekin «muddat yaqinlashmoqda / kechikdi» bildirishnomalari uchun alohida scheduler yo‘q.
- amoCRM kunlik «yo‘qolgan/o‘chirilgan yozuvlar» nazorati (TZ §5.2) yo‘q; 5 daqiqalik incremental reconciliation faqat lidlar uchun (kontaktlar emas). Boshlang‘ich import (mavjud kontakt/lidlar) CLI sifatida yo‘q.
- Kontakt/lidni web’dan tahrirlash: lokal turizm maydonlari va bosqich/mas’ul bor; kontakt ismi/telefonini amoCRM’ga yozish yo‘li yo‘q.
- Dublikat merge: amoCRM tomonida ikki kontakt bo‘lsa holat `merge_pending_amocrm` bo‘lib qoladi — amoCRM merge’ini tasdiqlash oqimi yo‘q.
- Mas’ul o‘zgarganda amoCRM vazifalarini qayta biriktirish outbox’ga qo‘yiladi; amoCRM task yopilishini (native) webhook orqali kuzatish yo‘q.
- Kompaniya sozlamalari UI’si (ish jadvali, SLA, sticky owner, navbatchi, telefon qoidasi, lead-form xaritasi, retention) yo‘q — hozircha DB/seed orqali.
- PII o‘chirish/anonimlashtirish va retention tozalash job’lari (raw webhook 30 kun va h.k.) implement qilinmagan; muddatlar kompaniya tomonidan tasdiqlanmagan.
- Monitoring: metrikalar Redis hisoblagichlari va `/integrations/health` sahifasida; Prometheus/alerting eksporti, tashqi bildirishnoma kanali yo‘q. Heartbeat bor, lekin «kanal oqimi uzildi» detektori yo‘q.
- CPL/ROAS: reklama sarfi ma’lumoti olinmaydi, shuning uchun hisoblanmaydi (TZ §2.2 bo‘yicha to‘g‘ri xatti-harakat).
- Login rate limit email+IP bo‘yicha; IP-only global limit va hisobni vaqtincha qulflash yo‘q.

## 3. Infratuzilma

- Staging/production deploy konfiguratsiyasi, TLS, secret manager, private object storage, hosting hududi tanlanmagan.
- Backup: lokal `pg_dump`/`pg_restore` mashqi bajarilgan; RPO 15 daqiqa uchun PITR/WAL arxivi va RTO 4 soat mashqi alohida muhitda bajarilmagan (AC35).
- Unumdorlik o‘lchovi lokal noutbukda; ajratilgan 4 vCPU/8 GB muhitda qayta o‘lchanmagan. 15 daqiqalik webhook sig‘im testi bajarilmagan (60 s bajarildi).
- Docker image’lar lokal build qilingan; registry, imzolash va zaiflik skanerlash yo‘q.

## 4. Texnik qarz

- Stack versiyalari: NestJS 11, Next.js 15, Prisma 6, ESLint 9 ataylab tanlangan (ADR 0005). ESLint 9 rasmiy qo‘llab-quvvatlash muddati tugagan; production’dan oldin yangi major’larga o‘tish va xavfsizlik yangilanishlarini tekshirish kerak.
- Prisma migratsiyalari qo‘lda boshqariladi (`migrate deploy`), chunki partial unique va kompozit FK’lar raw SQL’da. Yangi migratsiyani `prisma migrate diff` bilan yaratib, raw SQL obyektlarini o‘chiruvchi qatorlarni olib tashlash shart (`docs/runbook.md`).
- Integration testlar har ishga tushganda yangi `crm_it_<timestamp>` bazasini yaratadi va o‘zi yaratganini o‘chiradi; Prisma’ning `migrate reset` AI-guard’i chetlab o‘tilmagan.
- Dashboard 20 soniyalik Redis kesh va in-process single-flight ishlatadi; bir nechta API instansiyada stampede himoyasi faqat instansiya ichida.
