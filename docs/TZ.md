# amoCRM asosida turizm CRM tizimi uchun texnik topshiriq

Versiya 1.0 • 24 oktabr 2026

Ijro muhiti: Claude Code. Hujjat tili: o‘zbekcha. Dastur kodi va texnik identifikatorlar: inglizcha. Asosiy interfeys: o‘zbek lotin yozuvi.

## 1 Maqsad va kutiladigan natija

Turizm kompaniyasi uchun amoCRM asosida ishlaydigan tizim ishlab chiqilsin. Tizim Instagram reklama lid-formasi yoki Direct xabaridan boshlangan murojaatni qabul qilish, menejerga taqsimlash, taklif va sotuvni yuritish, buyurtma hamda aviaqatnovlarni nazorat qilish imkonini bersin. Rahbar sotuvlar va menejerlar faoliyatini yagona dashboard orqali kuzatsin.

Asosiy yechim: amoCRM mijozlar va sotuvlarning asosiy tizimi bo‘ladi. Alohida backend integratsiyalarni, reyslarni, eslatmalarni va hisobotlarni boshqaradi. Turizm moduli web ilova sifatida ishlaydi va amoCRM kartochkasidan havola yoki rasmiy vidjet orqali ochiladi. Direct yozishmalarini amoCRM ichida yuritish alohida qabul qilish shartidir.

UON Travel funksional namuna sifatida olinadi. Ushbu TZ’da sanalgan imkoniyatlar bajariladi; UON’ning butun funksionalini yoki dizaynini takrorlash talab qilinmaydi.

Hujjatdagi sonli unumdorlik mezonlari, saqlash muddatlari va boshlang‘ich siyosatlar loyiha uchun taklif etilgan standartlardir. Ular platformaning kafolati hisoblanmaydi. Kompaniyaga oid noma’lum sozlamalar 26-bo‘limda jamlangan; ularning o‘rniga dasturga yashirin taxmin kiritilmasin.

## 2 Loyiha chegarasi

### 2.1 Birinchi ishlab chiqarish versiyasi

Quyidagilar birinchi to‘liq versiyaga kiradi:

- amoCRM OAuth ulanishi, kontaktlar, sotuv voronkasi, mas’ullar va vazifalar bilan ishlash.
- Instagram Lead Ads murojaatlarini avtomatik olish va Direct xabarlarini ikki tomonlama uzatish.
- Identifikatorlar bo‘yicha mijozni topish, takroriy hodisalarni yutish va dublikat nomzodlarini ko‘rsatish.
- Ish jadvali va faollikni hisobga oluvchi round-robin taqsimoti.
- Talablar, takliflar, buyurtmalar, yo‘lovchilar va ko‘p segmentli reyslar.
- 7 kun, 3 kun, 24 soat va 3 soat oldingi reys tekshiruvi eslatmalari.
- Qo‘lda yaratiladigan bir martalik va cheklangan takroriy eslatmalar.
- Rahbar va menejer dashboard’i, filtrlar va huquqlarga mos CSV eksporti.
- Rollar, audit, integratsiya monitoringi, qayta urinish va nosozlikdan tiklanish.
- Local demo, staging va production konfiguratsiyalari; avtomatlashtirilgan testlar va topshirish hujjatlari.

### 2.2 Alohida bosqichda bajariladigan imkoniyatlar

Real vaqt reys API’si, GDS orqali bronlash, chipta chiqarish, to‘lov qabul qilish, buxgalteriya, avtomatik qaytarim, AI javoblari, Telegram yoki SMS, mobil ilova va ko‘p kompaniyali SaaS birinchi versiyaga kirmaydi. Mazkur versiyada chipta menejer tomonidan tashqi bronlash tizimida rasmiylashtiriladi va natijasi CRM’da qayd etiladi.

Reys API’si ulanmasa ham qo‘lda tekshirish, uning natijasini qayd etish va eslatmalar to‘liq ishlashi shart. Dashboard reklama manbalari bo‘yicha lid, sotuv va konversiyani ko‘rsatadi. Xarajat, CPL yoki ROAS hisoblash uchun reklama sarfi ma’lumotlari kerak; bunday ma’lumotsiz bu ko‘rsatkichlar hisoblanmaydi.

## 3 Amalga oshirishdan oldingi texnik tekshiruv

### 3.1 Majburiy integratsiya sinovi

Katta hajmdagi ishlab chiqishdan oldin alohida test akkauntlarida ishlaydigan kichik integratsiya yaratiladi. Natijasi `docs/feasibility.md` fayliga yoziladi. Demo ishlashi production huquqlari mavjudligini anglatmaydi.

| ID | Tekshiruv | Qabul qilinadigan dalil |
| --- | --- | --- |
| G01 | amoCRM domeni, akkaunt ID’si, tarif va ruxsatlar | Test kontakt, lid va vazifa yaratilib, qayta o‘qilgan |
| G02 | OAuth ulash, yangilash va uzish | Token yangilangandan keyin API so‘rovi ishlagan; uzilgan ulanish bloklangan |
| G03 | Meta akkauntlari va aktivlar | Instagram professional akkaunti, tegishli Page va reklama aktivlari ro‘yxati qayd etilgan |
| G04 | Lead Ads | Test forma yuborilgach haqiqiy leadgen hodisasi va forma javoblari olingan |
| G05 | Direct kiruvchi xabar | Test mijozdan kelgan xabar va barqaror scoped sender ID olingan |
| G06 | Direct chiquvchi xabar | Menejer amoCRM ichida yozgan javob Instagram’da olingan |
| G07 | Ruxsat va xabar oynasi | Tanlangan login usuli, permission’lar, App Review holati va yuborish cheklovi qayd etilgan |
| G08 | amoCRM Chats API yoki tayyor kanal | Hisobga ulangan kanal, kiruvchi va chiquvchi xabarlar sinovi bor |
| G09 | Tarix va atributsiya imkoniyati | Qaysi tarix, media va reklama atributlari olinishi real javob bilan tasdiqlangan |

Har bir sinovga vaqt, test ssenariysi, maxfiy ma’lumotlari yashirilgan so‘rov va javob, cheklov hamda qaror yozilsin. Haqiqiy tokenlar hujjat yoki git tarixiga kiritilmasin.

### 3.2 Integratsiya yo‘lini tanlash

Direct uchun ikkita yo‘l tekshiriladi: mos va rasmiy tayyor amoCRM konnektori yoki o‘zimizning Meta adapterimiz bilan amoCRM Chats API kanali. Bitta Instagram akkauntining xabarlarini ikki faol konnektor parallel qayta ishlamasin. Tayyor konnektor tanlansa, uning tarix, mas’ul, hodisa ID’si va metrikalarni olish imkoniyati ham tekshirilsin.

O‘z kanalini yaratishda amoCRM Chats API uchun kanalni ro‘yxatdan o‘tkazish va alohida autentifikatsiya talab etiladi. Bu REST OAuth’dan alohida mexanizmdir [S03]. Tayyor konnektor talablarni bajarmasa, custom kanal asosiy yo‘l bo‘ladi. Kanal huquqi olinmaguncha Direct integratsiyasi tayyor deb belgilanmasin.

Meta Direct uchun Instagram Login yoki Facebook Login yo‘llaridan bittasi tanlanadi. Ularning token va ruxsatlarini aralashtirish mumkin emas. Masalan, Instagram Login yo‘lida `instagram_business_basic` va `instagram_business_manage_messages` doirasidagi imkoniyatlar tekshiriladi [S06]. Lead Ads uchun Page, lead-forma va lead ma’lumotlariga kirish alohida tekshiriladi; Direct ruxsati Lead Ads’ga avtomatik ruxsat bermaydi [S09].

Production uchun kerak bo‘ladigan App Review, kerakli access darajasi va biznes tasdiqlash holati aniqlansin. Faqat app rollaridagi test foydalanuvchilarda ishlaydigan integratsiya production qabulidan o‘tmaydi [S08].

## 4 Tizim arxitekturasi

### 4.1 Tarkibiy qismlar

| Qism | Vazifasi |
| --- | --- |
| amoCRM | Kontakt, lid, voronka, asosiy mas’ul, native chat va CRM vazifalari |
| Web ilova | Dashboard, reyslar, turizm buyurtmasi, eslatma va sozlamalar |
| Backend API | Biznes qoidalari, autentifikatsiya, RBAC, tekshirish va API |
| Worker | Webhook qayta ishlash, sinxronlash, taqsimlash, eslatma va qayta urinish |
| PostgreSQL | Turizm ma’lumotlari, integratsiya xaritasi, inbox, outbox va audit |
| Redis va BullMQ | Ishlar navbati, tezkor blokirovka va cheklangan kesh |
| amoCRM adapteri | REST API, OAuth, kontakt va lid sinxronlash |
| amoCRM chat adapteri | Ro‘yxatdan o‘tgan kanal orqali xabarlar almashinuvi |
| Meta adapterlari | Lead Ads va Direct uchun ajratilgan integratsiya oqimlari |
| FlightProvider | Kelajakdagi reys API’si; boshlanishida ManualProvider |

Backend modulli monolit bo‘lsin. API va worker bitta kod bazasidan alohida process sifatida ishga tushsin. Ushbu hajm uchun mikroservislar shart emas. Barcha biznes ma’lumotlarida `company_id` bo‘lsin; dastlab bitta kompaniya ishga tushiriladi. Bu ko‘p kompaniyali billing yoki SaaS yaratish majburiyatini keltirib chiqarmaydi.

### 4.2 Tavsiya etilgan texnologiyalar

TypeScript, Node.js’ning qo‘llab-quvvatlanadigan LTS relizi, NestJS, React va Next.js, PostgreSQL, Prisma, Redis, BullMQ, Docker Compose, OpenAPI, Vitest yoki Jest, Playwright ishlatilsin. Oddiy va qo‘llab-quvvatlashga qulay UI komponent kutubxonasi tanlansin.

Boshlanishida mos stable versiyalar tekshirilib, lockfile va container image versiyalari pin qilinsin. TZ’da eskirishi mumkin bo‘lgan aniq framework versiyasi majburlanmaydi. Meta API versiyasi konfiguratsiyada ochiq saqlansin va G07 dalili bilan qayd etilsin. Production’da versiyasiz yoki `latest`ga tayanilgan build bo‘lmasin.

### 4.3 Integratsiya yo‘nalishlari

Lead Ads oqimi: Meta webhook → doimiy inbox → lead ma’lumotlarini olish → identifikatsiya → taqsimlash → amoCRM kontakt va lid → mahalliy proyeksiya.

Direct oqimi: Meta webhook → inbox → suhbatni aniqlash → kontakt va lidni bog‘lash → amoCRM chatiga xabar. Javob oqimi: amoCRM chat webhook’i → yuborish huquqini tekshirish → Meta Send API → natijani qayd etish. Echo hodisasi yangi mijoz xabari sifatida qayta yuborilmasin.

Reys oqimi: buyurtma va segment → eslatmalar jadvali → worker → ilova bildirishnomasi va amoCRM vazifasi → menejer tekshiruvi → audit.

## 5 Ma’lumotlar uchun asosiy tizim va sinxronlash

### 5.1 Maydonlarning egasi

| Ma’lumot | Asosiy tizim | Ikkinchi tizimdagi ko‘rinish |
| --- | --- | --- |
| Kontakt ismi, telefon, email | amoCRM | Mahalliy o‘qish proyeksiyasi va identifikatorlar |
| Lid statusi, voronka, mas’ul | amoCRM | Dashboard proyeksiyasi va o‘zgarish tarixi |
| Instagram scoped ID va provider message ID | Meta integratsiya yozuvi | Kontakt va chat bilan xarita |
| Reklama hodisasi va birinchi manba | Integratsiya bazasi | amoCRM qo‘shimcha maydonlari |
| Turizm buyurtmasi va taklif versiyalari | PostgreSQL | amoCRM’da buyurtma havolasi va qisqa xulosa |
| Segmentlar, tekshiruvlar va eslatmalar | PostgreSQL | Vazifalar va zarur qisqa xulosa |
| Xabarlar | Provayder ID’lari bilan integratsiya qaydi | amoCRM chatidagi mos xabarlar |
| Hisobotlar | Vaqtli hodisalar va proyeksiyalar | Dashboard |

Lid yoki kontaktni web ilovadan tahrirlash amoCRM’da tasdiqlanib bo‘lgach mahalliy proyeksiyaga qo‘llansin. So‘rov kutayotgan vaqtda interfeys `Sinxronlanmoqda` holatini ko‘rsatsin. Turizm maydoni mahalliy bazada saqlanib, amoCRM’ga xulosa yuborilsa, xulosa xatosi asl buyurtmani yo‘qotmasin.

### 5.2 Sinxronlash qoidalari

- API webhook’i hodisa signali sifatida ishlatiladi; kerakli obyekt amoCRM’dan qayta olinadi. Eski hodisa yangi holatni orqaga qaytarmasin.
- Har bir xaritada lokal ID, provider ID, `updated_at`, `last_synced_at`, `sync_state` va zarur holat xeshi bo‘lsin.
- Qayta yozish sikli `origin`, operatsiya ID’si va o‘zgargan qiymatlar xeshi orqali to‘xtatilsin. Faqat “oxirgi 5 soniyadagi hodisani tashlash” yechimi ishlatilmasin.
- amoCRM’da o‘zgargan status yoki mas’ul navbatdagi sinxronlashda aks etsin. Mahalliy audit oldingi qiymatni saqlasin.
- Mahalliy tahrir uchun optimistic lock versiyasi ishlatilsin. Eskirgan versiya bilan yozishga `409 CONFLICT` qaytarilsin.
- API’da atomik conditional update bo‘lmagan holatda serial navbat, yozishdan oldin o‘qish va yozishdan keyin solishtirish qo‘llansin. Tashqi qo‘lda tahrir bilan konflikt aniqlansa, ovozsiz ustiga yozish o‘rniga operatorga vazifa yaratilsin.
- Har 5 daqiqada incremental reconciliation bajarilsin. Pagination, checkpoint va kamida 10 daqiqalik overlap ishlatilsin; takroriy yozuvlar idempotent qayta ishlansin. Kunlik nazorat kerakli yo‘qolgan va o‘chirilgan yozuvlarni ham aniqlasin.
- Boshlang‘ich importda mavjud kontaktlar, faol lidlar, foydalanuvchilar, voronkalar va kerakli mavjud maydonlar olinadi. Import sahifalari qayta boshlanganda dublikat yaratilmasin.
- amoCRM’dan o‘chirilgan kontakt yoki lid avtomatik qayta yaratilmasin. Lokal yozuv tombstone bilan belgilanib, bog‘liq faol buyurtma bo‘lsa rahbarga ko‘rsatilsin.

Lokal tizim barcha tarixiy o‘zgarishlarni biladi deb taxmin qilinmasin. Hisobotlarda `Ma’lumotlar to‘liq yig‘ila boshlangan sana` va `Oxirgi sinxronlash` ko‘rsatilsin.

## 6 Foydalanuvchilar va kirish huquqlari

### 6.1 Rollar matritsasi

| Amal | Administrator | Rahbar | Menejer |
| --- | --- | --- | --- |
| Integratsiya va tizim sozlamalari | Ha | Yo‘q | Yo‘q |
| Foydalanuvchi va rol boshqaruvi | Ha | Yo‘q | Yo‘q |
| Barcha lid va buyurtmalarni ko‘rish | Ha | Ha | Faqat o‘ziniki |
| Lid va buyurtmani tahrirlash | Ha | Ha | Faqat o‘ziniki |
| Mas’ulni boshqa xodimga o‘tkazish | Ha | Ha | Yo‘q |
| Yozishmani ko‘rish va javob berish | Ha | Ha | Faqat o‘ziga biriktirilgan suhbat |
| Reys tekshiruvi va eslatmalar | Ha | Ha | Faqat o‘z buyurtmasi |
| Kompaniya dashboard’i | Ha | Ha | O‘z ko‘rsatkichlari |
| Dublikatlarni tasdiqlab birlashtirish | Ha | Ha | Faqat nomzod belgilash |
| Eksport | Ha | Ha | Standartda yo‘q |
| Auditni o‘qish | Ha | Ha | Faqat o‘z obyektining xavfsiz tarixi |
| Auditni o‘zgartirish | Yo‘q | Yo‘q | Yo‘q |

Huquq tekshiruvi backend query darajasida bajarilsin. Frontend tugmasini yashirish yetarli emas. ID orqali kartochka ochish, API, eksport, qidiruv, aggregate hisobotlar va realtime kanal ham bir xil cheklovga bo‘ysunsin. Mas’ul almashtirilganda eski menejerning aktiv ulanishlari ham kirishdan mahrum qilinsin.

amoCRM’ning native rollari ushbu siyosatga mos sozlansin. Backend keng huquqli integratsiya tokeni bilan ishlasa ham menejerga begona ma’lumotni qaytarmasin. amoCRM ichida chatga kirish huquqi cheklanmasa, lokal RBAC bilan bu talab bajarilgan hisoblanmaydi.

### 6.2 Login

Web ilovaga kirish uchun yopiq ro‘yxatdagi foydalanuvchilar ishlatiladi. Ochiq ro‘yxatdan o‘tish bo‘lmasin. Har bir lokal foydalanuvchi amoCRM `user_id` bilan bog‘lansin. Akkauntga integratsiya OAuth orqali ruxsat berilishi alohida web ilova foydalanuvchisi kimligini tasdiqlamaydi.

Boshlang‘ich variant: email va parol, Argon2id xeshi, HttpOnly va Secure session cookie, CSRF himoyasi, login rate limit va administrator uchun MFA. Administrator bir martalik aktivlashtirish havolasi orqali xodim qo‘shadi. Ishdan ketgan foydalanuvchi darhol bloklanadi; ochiq vazifalar va mijozlar yangi mas’ulga audit bilan o‘tkaziladi.

## 7 Mijozlar va murojaatlarni identifikatsiya qilish

### 7.1 Kontakt modeli

Kontakt kompaniya bilan muloqot qiluvchi shaxsni bildiradi. Kontakt bir nechta lid, buyurtma va aloqa identifikatoriga ega bo‘lishi mumkin. Buyurtmadagi yo‘lovchi kontakt bilan bir shaxs bo‘lishi shart emas. Oila nomidan chipta olayotgan bitta mijoz bir nechta yo‘lovchi uchun buyurtma beradi.

Telefon E.164 formatiga normallashtirilsin. Mamlakat kodi noma’lum raqam avtomatik ravishda `+998` deb talqin qilinmasin; tasdiqlangan kompaniya standart qoidasi yoki qo‘lda tekshiruv talab qilinsin. Asl qiymat ham saqlansin.

Instagram uchun asosiy identifikator `business_account_id + scoped_sender_id` juftligidir. Username o‘zgaradigan ko‘rsatish va qidirish maydoni bo‘lib, yagona ishonchli kalit hisoblanmaydi. Telefon Direct API’dan kelishi kafolatlanmaydi; mavjud bo‘lmagan ma’lumot bo‘sh qolsin.

### 7.2 Topish va dublikat qoidalari

1. Avval mavjud aniq provider ID xaritasi tekshirilsin.
2. Xarita bo‘lmasa, normallashtirilgan telefon va boshqa tekshirilgan identifikatorlar bo‘yicha nomzodlar topilsin.
3. Bitta aniq, ziddiyatsiz moslik topilsa mavjud kontaktga bog‘lansin.
4. Telefon va Instagram ikki xil kontaktni ko‘rsatsa yoki raqam oilaviy umumiy raqam bo‘lsa, avtomatik merge bajarilmasin. Tekshiruv navbatiga qo‘yilsin.
5. Faqat ism yoki username o‘xshashligi asosida merge qilinmasin.
6. Parallel ikki murojaat kelganda bir xil identifikator bo‘yicha DB lock va unique constraint dublikat yaratishni cheklasin.

Umumiy telefon bir nechta shaxsga tegishli bo‘lishi mumkin. Shu sabab telefon qiymatining o‘zi butun bazada mutlaq unique qilinmasin. Identifikator yozuvi shared yoki ambiguous deb belgilanishi mumkin. Bir scoped Instagram ID bir vaqtning o‘zida ikki faol kontaktga bog‘lanmasin.

Rahbar birlashtirishda asosiy kontaktni tanlaydi, ziddiyatli maydonlarni ko‘radi va yozishmalar hamda buyurtmalarni saqlaydi. amal auditga tushadi. amoCRM va lokal xaritalarning mos holati tekshirilmaguncha merge yakunlandi deb belgilanmasin.

### 7.3 Yangi lid va yangi xabar farqi

Har bir xabar yangi lid yaratmaydi. Mavjud suhbat o‘zining faol lidiga bog‘lanadi. Bir kontaktda bir xil safarga oid bitta faol lid bo‘lsa, takroriy murojaat unga yoziladi. Bir nechta faol lid bo‘lsa, suhbatning avvalgi bog‘lanishi ustun; safar aniqlanmasa menejer tanlaydi.

Oldingi safar bo‘yicha lid yopilgan bo‘lsa va yangi safar murojaati kelgan bo‘lsa, shu kontakt uchun yangi lid yaratiladi. Eski muvaffaqiyatli lid `Yangi lid`ga qaytarilmaydi. Har bir tashqi murojaat alohida `inquiry` yozuvida saqlanadi; lidlar statistikasi bilan murojaatlar statistikasi aralashmasin.

## 8 Instagram Lead Ads integratsiyasi

### 8.1 Qabul qilish oqimi

Meta Page `leadgen` webhook’idan kelgan hodisa doimiy inbox’da saqlanadi. Worker provider lead ID bo‘yicha ruxsat etilgan API’dan forma ma’lumotlarini oladi. Webhook ichida telefon va ism doimo keladi deb hisoblanmasin. Forma maydonlari konfiguratsiya orqali lokal maydonlarga moslanadi.

Kontakt topiladi yoki yaratiladi; tegishli lid topiladi yoki `Yangi lid` statusida yaratiladi. Instagram joylashuvi haqiqiy metadata yoki tasdiqlangan alohida forma xaritasi bilan aniqlansa manba `instagram_lead_ads` bo‘ladi; mas’ul 10-bo‘lim qoidasi bilan tayinlanadi. CRM kartochkasiga asl murojaat vaqti va forma ma’lumotlari yoziladi.

Bir Page yoki forma Facebook va Instagram’da birga ishlatilishi mumkin. Har bir Page leadgen hodisasini avtomatik Instagram deb belgilash mumkin emas. Joylashuv aniqlanmasa kanal `meta_lead_ads`, placement `unknown` bo‘lib qoladi va Instagram’ga tegishli aniq KPI’dan alohida ko‘rsatiladi. Kampaniyada Instagram yoqilganining o‘zi ayni lid Instagram’dan kelganiga dalil bo‘lmaydi.

### 8.2 Saqlanadigan atributlar

| Guruh | Maydonlar |
| --- | --- |
| Shaxs | full_name, phone_original, phone_normalized, email |
| Provider | leadgen_id, form_id, page_id, business_account_id |
| Reklama | ad_id, adset_id, campaign_id va ruxsat etilsa ularning nomlari |
| Vaqt | source_created_at, received_at, processed_at |
| CRM | contact_id, lead_id, responsible_user_id, source, stage |
| Diagnostika | event_id, correlation_id, mapping_version, processing_state |

Ma’lumot yo‘q bo‘lsa `null` va sababi saqlansin. Kampaniya nomini olish xatosi lidni yaratishni to‘xtatmasin; enrichment alohida qayta urinadi. Birinchi manba o‘zgarmas tarixiy atribut bo‘ladi, keyingi manbalar `inquiry` va atributsiya tarixiga qo‘shiladi.

Click-to-Direct reklamasidan yozilgan xabar lid-forma sifatida belgilanmasin. Bunday xabar `instagram_direct` kanali va mavjud bo‘lsa reklama referral metama’lumoti bilan saqlanadi. Reklama ID’si kelmasa kampaniya taxmin qilinmasin.

### 8.3 Qayta olish

Ruxsat etilgan API va mavjud saqlanish oynasi doirasida lead-formalar uchun reconciliation bajarilsin. Vaqt oralig‘i, forma ID’si va checkpoint saqlansin. Token uzilgan davrdagi barcha lidlarni doimo qaytarish mumkin deb va’da berilmasin; tiklash natijasi va bo‘shliqlar administratorga ko‘rsatilsin.

## 9 Instagram Direct integratsiyasi

### 9.1 Suhbat va tarix

Kiruvchi matn, provider message ID, sender ID, professional akkaunt ID’si, kelish vaqti, attachment metama’lumoti va suhbat bog‘lanishi saqlansin. Matn va ruxsat etilgan rasm yoki fayl turi ko‘rsatiladi. Qo‘llab-quvvatlanmagan media kelganda `Ushbu xabar turini Instagram’da oching` ko‘rinishi berilsin; xabar yo‘qolgandek ko‘rsatilmasin.

To‘liq eski Direct tarixini import qilish imkoniyati G09’da tekshiriladi. Ilovada tarix qaysi sanadan mavjudligi ko‘rsatiladi. API ko‘rishga ruxsat bermagan eski yozishmalar yaratilmasin yoki “to‘liq yuklandi” deyilmasin.

### 9.2 Xabar yuborish

Asosiy javob yozish joyi amoCRM’ning native chatidir. Web ilovada tarixni ko‘rish va shu chatni ochish havolasi bo‘lishi yetarli; ikkinchi mustaqil chat interfeysi birinchi versiyada shart emas.

Xabar qabul qiluvchi username bilan emas, tasdiqlangan scoped ID bilan aniqlanadi. Har bir yuborishdan oldin rol, suhbatning mas’uli, ulanish holati va Meta yuborish siyosati tekshiriladi. Odatdagi javob oynasi va ruxsat etilgan istisnolar tanlangan Meta mahsuloti bo‘yicha G07’da qayd etilsin [S07].

Oyna yopiq bo‘lsa foydalanuvchiga sabab ko‘rsatilsin. Human Agent imkoniyati faqat tegishli ruxsat va haqiqiy inson javobi ssenariysida ishlatilishi mumkin; u avtomatik reklama yoki reys eslatmasi yuborish uchun cheklovni chetlab o‘tish vositasi bo‘lmasin. Instagram xabari yuborilmagani ichki menejer eslatmasini to‘xtatmasin.

### 9.3 Yetkazish holatlari

Lokal xabar holatlari `received`, `queued`, `sending`, `accepted`, `delivered`, `read`, `failed`, `unknown` bo‘lsin. Provayder faqat qabul qilganini bildirsa `delivered` yoki `read` ko‘rsatilmasin. Har bir qo‘llab-quvvatlangan delivery hodisasi mavjud xabarga bog‘lansin.

Outbound timeout’dan keyin natija noaniq bo‘lsa xabar `unknown` bo‘ladi. Yetkazilgan xabarni yana yuborishdan oldin provider holati yoki echo orqali tekshirilsin. Avtomatik xavfsiz tekshiruv imkoni bo‘lmasa menejerga qayta yuborish qarori berilsin.

## 10 Lidlarni avtomatik taqsimlash

Boshlang‘ich algoritm: faol va ish jadvali mos menejerlar o‘rtasida teng round-robin. Keyinchalik weighted yoki xizmat turiga ko‘ra taqsimlash qo‘shish uchun strategiya interfeysi bo‘lsin; birinchi versiyada teng taqsimot yetarli.

Ustuvorlik tartibi:

1. Mavjud faol lidga kelgan murojaat uning mas’ulida qoladi.
2. Yangi lid uchun kontaktning mavjud menejeri faol va mos bo‘lsa, kompaniyaning `sticky_owner` sozlamasiga ko‘ra unga biriktiriladi.
3. Aks holda jadvali, xizmat turi va faol holati mos pool ichida round-robin ishlaydi.
4. Mos menejer bo‘lmasa `Taqsimlash kutilmoqda` navbati hosil bo‘ladi. amoCRM majburiy mas’ul talab qilsa konfiguratsiyadagi navbatchi rahbar qo‘yiladi; bu holat oddiy taqsimotdan alohida belgilanadi.

Taqsimot DB tranzaksiyasi va pool lock bilan atomik bajarilsin. Bir vaqtning o‘zida 100 lid kelganda pointer buzilmasin. Bir xil vaziyatdagi uch menejer o‘rtasida 100 lid farqi ko‘pi bilan 1 ta bo‘lsin. Sticky owner bilan ketgan lidlar ushbu tenglik tekshiruviga kiritilmaydi.

Standart SLA: ish vaqtida birinchi inson javobi 15 daqiqada. Kompaniya ish jadvalini administrator belgilaydi; boshqa vaqtda hisob keyingi ish vaqtidan boshlanadi. Muddat yaqinlashganda menejerga, kechikkanda rahbarga ichki bildirishnoma berilsin. Standartda SLA buzilishi sabab avtomatik qayta biriktirish yo‘q; rahbar ongli ravishda qayta tayinlaydi.

Mas’ul o‘zgarsa lid, lokal buyurtma, faol eslatmalar va tegishli amoCRM vazifalari moslashtirilsin. Bajarilgan tarixiy harakatlarning muallifi almashtirilmasin. Har bir qaror sabab, algoritm versiyasi va avvalgi mas’ul bilan auditga tushsin.

## 11 Sotuv voronkasi va harakatlar

### 11.1 Bosqichlar

| Kod | Ko‘rinadigan nom | Bosqichga o‘tish sharti va harakat |
| --- | --- | --- |
| NEW | Yangi lid | Kontakt yoki aloqa identifikatori, manba va mas’ul; birinchi aloqa vazifasi |
| CONTACTED | Mijoz bilan aloqa o‘rnatildi | Haqiqiy aloqa natijasi qayd etilgan |
| QUALIFIED | Mijoz talablari aniqlandi | Xizmat turi, yo‘nalish, taxminiy sana, yo‘lovchilar soni va budjet holati |
| PREPARING_OFFER | Taklif tayyorlanmoqda | Menejer va bajarish muddati belgilangan |
| OFFER_SENT | Taklif mijozga yuborildi | Taklif versiyasi, yuborilgan vaqt va kanal qayd etilgan |
| AWAITING_PAYMENT | To‘lov kutilmoqda | Summa, valyuta, to‘lov muddati va tasdiqlangan taklif |
| WON | Sotuv muvaffaqiyatli yakunlandi | Buyurtma, kelishilgan qiymat va sotuv tasdiqlash dalili bor |
| LOST | Bekor qilindi | Sabab kodi va izoh; faol sotuv vazifalari bekor qilinadi |
| FOLLOW_UP | Qayta aloqa talab qilinadi | next_contact_at, izoh va mas’ul; follow-up vazifasi |

FOLLOW_UP istalgan ochiq bosqichdan kiriladigan faol holatdir. `return_stage` saqlanadi va muloqot qayta boshlansa tegishli bosqichga qaytiladi. WON va LOST yopiq holatlardir. Native amoCRM WON va LOST statuslari xaritalanadi, qo‘shimcha takroriy yopiq status yaratilmasin. Voronka va custom status ID’lari akkauntdan olinadi [S05].

### 11.2 Muhim jarayon qoidalari

WON sotuv natijasini bildiradi. U to‘lovning to‘liqligi, chipta chiqarilganligi yoki safar tugaganligi bilan bir xil emas. `payment_state`, `ticketing_state` va `fulfillment_state` alohida yuritiladi. Reyslar WON’dan keyin ham faol nazoratda qoladi.

Majburiy maydonlar web ilovada server tomonidan tekshiriladi. Native amoCRM’da ham tarif va API imkoniyati doirasida required-field sozlamalari ishlatilsin. amoCRM’dan kelgan yetarli ma’lumotsiz status o‘tishi texnik jihatdan to‘xtatilmasa, u “anomaliya” sifatida qayd qilinib mas’ulga tuzatish vazifasi berilsin; yashirin ravishda orqaga qaytarilmasin.

Bosqichga qayta kirish yangi mazmunli follow-up kerak bo‘lsa yangi vazifa yaratishi mumkin. Bir hodisaning takroriy yetkazilishi ayni vazifani takror yaratmasin. Har bir avtomatizatsiya uchun `entity + rule + transition_id` dedupe kaliti bo‘lsin. Native Digital Pipeline va custom worker bir xil ishni parallel bajarmasin.

Yopilgan lid qayta ochilishi rahbar yoki administrator tomonidan sabab bilan bajariladi. Tarixda barcha yopilish va qayta ochilishlar saqlanadi. Bir lidni ikki marta WON qilish dashboard’da ikki sotuv deb sanalmasin.

## 12 Talablar takliflar va buyurtmalar

### 12.1 Safar talablari

Lidda xizmat turi `avia`, `tour_package`, `hotel`, `visa`, `other`; borish va kelish nuqtalari; ketish va qaytish oralig‘i; katta, bola va chaqaloqlar soni; budjet qiymati yoki `aniqlanmagan`; valyuta va izohlar saqlansin. Keraksiz maydonlar har bir xizmat turida majburiy bo‘lmasin.

### 12.2 Taklif

Taklifda raqam, versiya, lid, variantlar tavsifi, kiritilgan xizmatlar, summa, valyuta, amal qilish muddati, izoh, yaratuvchi va yuborilgan vaqt bo‘lsin. Har bir o‘zgarish yangi versiya yaratadi; mijozga yuborilgan eski narx ustiga yozilmaydi. Birinchi versiyada taklif matni va xavfsiz ilova bilan ishlash yetarli; murakkab PDF konstruktor talab qilinmaydi.

### 12.3 Buyurtma

Buyurtma bir asosiy lid va kontakt bilan bog‘lanadi. Birinchi versiyada bitta lid uchun bitta faol buyurtma bo‘lsin; uning ichida bir nechta xizmat, yo‘lovchi va segment bo‘lishi mumkin. Yangi mustaqil safar uchun yangi lid va yangi buyurtma yaratiladi.

Buyurtma raqami kompaniya ichida unique va o‘zgarmas, masalan `TR-2026-000123`. Ketma-ketlik atomik yaratiladi; bo‘sh raqamlar xato hisoblanmaydi. Sotuv tasdiqlanganda bazada buyurtma mavjud bo‘lmasa, idempotent ravishda draft yoki confirmed buyurtma yaratiladi. Mavjud draft bo‘lsa yangisi ochilmaydi.

| Maydonlar guruhi | Talab |
| --- | --- |
| Bog‘lanish | order_no, lead_id, contact_id, responsible_user_id |
| Tijorat | agreed_amount, currency, offer_version_id, confirmed_at |
| To‘lov | unpaid, partial, paid, refund_pending, refunded; qo‘lda qayd etilgan payment yozuvlari |
| Chipta | not_required, pending, reserved, issued, voided |
| Xizmat | draft, confirmed, in_progress, completed, cancelled |
| Qo‘shimcha | xizmatlar, yo‘lovchilar, segmentlar, izoh va xavfsiz fayllar |

Pul `Decimal` yoki valyuta aniqligiga mos minor unit bilan saqlansin; floating-point ishlatilmasin. To‘lov yozuvi summa, valyuta, vaqt, usul, dalil va muallifga ega bo‘lsin. To‘lovni qayd etish pul o‘tkazmasini amalga oshirmaydi. Valyutalar farq qilsa kurs va sanasi aniq yozilmaguncha avtomatik qarzdorlik konvertatsiyasi qilinmasin.

## 13 Aviachiptalar va reyslar moduli

### 13.1 Segment modeli

Bir buyurtmada bir nechta borish, ulanish va qaytish segmenti bo‘lishi mumkin. Faqat bitta `departure_date` ustuni bilan cheklanish mumkin emas. Har bir segment uchun quyidagilar saqlansin:

| Guruh | Maydonlar |
| --- | --- |
| Yo‘nalish | origin_iata, destination_iata, aeroport nomlari |
| Reys | marketing_carrier, operating_carrier agar mavjud, flight_number |
| Vaqt | departure_at_utc, departure_timezone, departure_local_original; arrival uchun ham shular |
| Bron | PNR, bron provayderi, zarur bo‘lsa ticket reference |
| Holat | operational_status, schedule_revision, check_state, notification_state |
| Nazorat | last_checked_at, checked_by, next_reminder_at, evidence_source |
| Bog‘lanish | order_id, segment_no, tegishli yo‘lovchilar |

Ticket raqami zarur bo‘lsa yo‘lovchi va segment bilan bog‘lanadi. Bitta PNR bir nechta yo‘lovchini qamrab olishi mumkin. PNR va chipta raqamlari umumiy ro‘yxatda niqoblanadi; to‘liq ko‘rish huquq bilan tekshiriladi. Pasport nusxasi va to‘liq pasport rekvizitlari ushbu versiya uchun majburiy emas.

### 13.2 Vaqt zonalari

Bazada barcha absolyut vaqtlar UTC `timestamptz` sifatida saqlansin. Jo‘nash va yetib kelish aeroporti uchun IANA vaqt zonasi alohida bo‘lsin. Kompaniya dashboard’i standarti `Asia/Tashkent`; aeroport vaqti esa uning o‘z zonasida ko‘rsatiladi.

UI’da masalan `25 oktabr 10:30 — aeroport vaqti, Asia/Dubai` va kerak bo‘lsa Toshkent vaqti ko‘rsatiladi. Faqat `UTC+4` bilan uzoq muddatli hisob qilish yetarli emas. DST tufayli mavjud bo‘lmagan yoki ikki marta uchraydigan lokal vaqt kiritilsa foydalanuvchi offsetni tasdiqlaydi.

Boshlang‘ich 7 va 3 kun oldingi eslatmalar mos ravishda 168 va 72 soat oldin hisoblanadi. Hisoblash UTC absolyut vaqtga nisbatan bajariladi; “oldingi kalendar kuni” qoidasi alohida sozlanmaguncha ishlatilmaydi.

### 13.3 Statuslar

Reysning fizik holati, menejer tekshiruvi va mijozni xabardor qilish uchta alohida maydonda yuritilsin. Shu orqali `Reys vaqti o‘zgardi` va `Mijoz xabardor qilindi` ma’lumotlari bir-birini yo‘qotmaydi.

| UI’dagi holat | Asosiy maydon |
| --- | --- |
| Tekshirish kutilmoqda | check_state = pending |
| Tekshiruv vaqti keldi | check_state = due |
| Reys tekshirilmoqda | check_state = in_progress |
| Reys ma’lumotlari tekshirildi | check_state = checked |
| Reys vaqti o‘zgardi | operational_status = schedule_changed |
| Reys bekor qilindi | operational_status = cancelled |
| Mijoz xabardor qilindi | notification_state = notified |
| Qayta tekshirish talab etiladi | check_state = recheck_required |

Ro‘yxatda bitta asosiy rangli indikator va qo‘shimcha teglar ko‘rsatilishi mumkin. `Mijoz xabardor qilindi` deyish uchun kanal, vaqt, muallif va natija yozilgan bo‘lsin. CRM’da ichki belgi qo‘yish o‘z-o‘zidan Instagram xabari yubormasin.

### 13.4 Tekshiruvni yakunlash

Menejer `Tekshirishni boshlash` va `Natijani saqlash` amallarini bajaradi. Natijada joriy parvoz vaqti, aeroport yoki terminal mavjud bo‘lsa, tekshiruv manbasi, tekshiruv vaqti, o‘zgarish, izoh va mijozga xabar zarurati qayd etiladi.

Manba `manual` yoki kelajakdagi provider nomidir. Qo‘lda tekshirilgan natija “real vaqt API ma’lumoti” deb ko‘rsatilmasin. Har bir tekshiruv o‘sha paytdagi `schedule_revision` va milestone’ga bog‘lansin. 7 kun oldin tekshirish 24 soat oldingi tekshiruvni avtomatik bajarmaydi.

Reys vaqti, raqami yoki aeroporti o‘zgarsa revision oshadi, oldingi tekshiruv yangi revision uchun eskirgan hisoblanadi, kelajak eslatmalari qayta hisoblanadi. O‘zgarish tarixi saqlanadi. Bekor qilingan reysda odatiy uchish eslatmalari to‘xtaydi va mijoz bilan bog‘lanish vazifasi ochiladi.

## 14 Avtomatik va qo‘lda eslatmalar

### 14.1 Avtomatik eslatmalar

Standart milestone’lar: `T-168h`, `T-72h`, `T-24h`, `T-3h`. Administrator ularni yoqadi, o‘chiradi yoki o‘zgartiradi. Qoidalar versiyalanadi; o‘zgarish faqat kelajakdagi tegishli occurrence’larni qayta rejalaydi.

Eslatma buyurtma tasdiqlangan, segment faol va jo‘nash vaqti ma’lum bo‘lsa rejalashtiriladi. Jo‘nash vaqti noma’lum bo‘lsa “Reys vaqti kiritilmagan” vazifasi ochiladi. Yangi buyurtma uchishga 2 soat qolganda kiritilsa, o‘tib ketgan to‘rt milestone birvarakayiga yuborilmasin; bitta `Shoshilinch tekshiruv` occurrence yaratiladi.

Due occurrence uchun ilova bildirishnomasi va mas’ulga amoCRM vazifasi yaratiladi. Ikkalasi bitta mantiqiy eslatma bilan bog‘liq bo‘ladi. DB unique kaliti: `company + segment + schedule_revision + rule_version + milestone`. Har bir kanal uchun delivery alohida yuritiladi.

Eslatmada mijoz, buyurtma raqami va havolasi, yo‘nalish, reys raqami, jo‘nashning aeroport vaqti va vaqt zonasi, tekshirish zarurati bo‘lsin. Namuna:

“Diqqat. TR-2026-000123 buyurtmasi bo‘yicha uchish yaqinlashmoqda. Mijoz: Ali Valiyev. TAS–IST, TK 371, 25 oktabr 08:20 Asia/Tashkent. Reys holati, uchish vaqti va aeroport ma’lumotlarini tekshiring. Natijani buyurtmada qayd eting.”

### 14.2 Bajarish va kechikish

Menejer tekshiruv natijasini saqlaganda tegishli occurrence bajariladi va bog‘langan amoCRM vazifasi yopiladi. amoCRM vazifasini bevosita yopish reys tekshiruv natijasini avtomatik yaratmaydi. Natija yetishmasa ilovada `Natija kiritilishi kerak` holati saqlanadi.

Standart ichki siyosat: T-3h eslatmasi 15 daqiqa bajarilmasa rahbarga eskalatsiya; boshqa reys eslatmalari 60 daqiqada. Aeroportga oid shoshilinch eslatmalar kompaniyaning oddiy ish vaqti tugagani uchun kechiktirilmasin. Faol menejer yo‘qligi navbatchi mas’ulga chiqariladi.

Jo‘nashdan keyin bajarilmagan eslatma tarixda `missed` bo‘lib qoladi va cheksiz qayta yuborilmaydi. Reys vaqti keyinga surilsa yangi revision qoidalari ishlaydi. Buyurtma bekor qilinsa rejalangan occurrence va tegishli ochiq CRM vazifalari bekor qilinadi; bajarilganlari o‘chirilmaydi.

### 14.3 Qo‘lda eslatma

Menejer buyurtma yoki segment uchun mazmun, mahalliy sana-vaqt, IANA zona, mas’ul va takrorlanishni belgilaydi. Bir martalik, har kuni yoki har hafta takrorlanish qo‘llansin. Takroriy eslatmada tugash sanasi yoki maksimal son majburiy bo‘lsin. To‘liq cheklanmagan RRULE muharriri talab qilinmaydi.

Holatlar: `scheduled`, `due`, `completed`, `snoozed`, `cancelled`, `missed`. Snooze eski yuborish tarixini o‘zgartirmaydi va keyingi vaqtni audit bilan yangilaydi. Menejer o‘z buyurtmasidagi eslatmani yaratadi; boshqa xodimga tayinlash rahbar yoki administratorga tegishli.

### 14.4 Scheduler ishonchliligi

Eslatma jadvali PostgreSQL’da asosiy hisoblanadi. Faqat uzoq muddatli Redis delayed job’lariga tayanilmasin. Scheduler kamida har 30 soniyada `due_at <= now` yozuvlarni batch qilib oladi, DB lock bilan claim qiladi va worker’ga uzatadi. Redis qayta ishga tushsa pending occurrence’lar bazadan tiklanadi.

Worker jo‘natishdan avval segment revision’i, buyurtma holati va occurrence bekor qilinmaganligini qayta tekshiradi. Jadval o‘zgarganidan oldin navbatga kirgan eski ish bildirishnoma yubormasin. Process uzilganda lease tugagach yozuv qayta olinadi. Takroriy ishning allaqachon bajarilgan yon ta’siri qayta yaratilmasin.

## 15 Dashboard va ko‘rsatkichlar

### 15.1 Ko‘rsatkichlarning aniq ta’rifi

| Ko‘rsatkich | Hisoblash qoidasi |
| --- | --- |
| Yangi lidlar | Tanlangan davrda yaratilgan unique lidlar; webhook yoki xabar soni emas |
| Murojaatlar | Tanlangan davrdagi unique inquiry; provider event dedupe’dan keyin |
| Ads va Direct lidlari | Lidning birinchi qayd etilgan manbasi bo‘yicha ajratish |
| Qayta ishlangan | Shu lid kohortasida kamida bir inson harakati qayd etilgan lidlar |
| Jarayonda | Filtrga mos, joriy holati ochiq lidlar; snapshot ko‘rsatkichi |
| Javob kutilmoqda | So‘nggi haqiqiy mijoz xabaridan keyin inson javobi yo‘q ochiq suhbatlar |
| Muvaffaqiyatli sotuvlar | Davr ichida WON bo‘lgan unique lidlar; qayta yopish dedupe qilinadi |
| Bekor qilingan | Davrda LOST bo‘lgan unique lidlar va alohida bekor qilingan buyurtmalar |
| Kohorta konversiyasi | Davrda yaratilgan lidlardan hozir WON bo‘lganlari / shu davrda yaratilgan barcha lidlar × 100 |
| Yopilganlar konversiyasi | Davrda yopilganlardan WON / shu davrda WON va LOST yig‘indisi × 100 |
| Sotuv summasi | WON buyurtmalarning kelishilgan qiymati; valyutalar bo‘yicha alohida |
| Qabul qilingan to‘lov | Tasdiqlangan payment yozuvlari, qaytarimlar alohida ko‘rsatiladi |
| Birinchi javob vaqti | Birinchi kiruvchi murojaatdan birinchi inson javobigacha; bot va ichki izoh hisoblanmaydi |
| Menejer natijalari | Lid mas’uli va yopilish paytidagi mas’ul tarixiga ko‘ra ajratilgan qiymatlar |

Maxraj nol bo‘lsa konversiya `—` bo‘ladi. Dashboard’da davrga tegishli ko‘rsatkichlar va joriy holat snapshot’lari aniq yozuv bilan ajratilsin. Keyinroq WON bo‘lgan eski lidlar sonini yangi lidlar soniga bo‘lib, noto‘g‘ri konversiya chiqarilmasin.

First response uchun median va p90, kuzatilgan suhbatlar soni va hali javobsizlar soni ko‘rsatilsin. Real o‘tgan vaqt va ish soatlari bo‘yicha SLA vaqti alohida qiymatlar bo‘lsin. Telefon orqali birinchi aloqa qilingan bo‘lsa, faqat qayd etilgan dalil bilan “qayta ishlangan” belgilanadi; Direct javob vaqti o‘ylab topilmaydi.

UZS va USD summalari to‘g‘ridan-to‘g‘ri qo‘shilmasin. Bitta bazaviy valyutadagi ko‘rsatkich kerak bo‘lsa tasdiqlangan kurs manbasi, kurs sanasi va conversion rule qo‘shiladi. Birinchi versiyada valyutalar bo‘yicha alohida yig‘indi yetarli. Sotuv summasi kompaniya foydasi sifatida nomlanmasin.

### 15.2 Filtrlar

Sana oralig‘i, manba, mas’ul, xizmat turi, sotuv statusi va uchish sanasi bo‘lsin. Sana oralig‘i kompaniya zonasida tanlanadi va backend’da UTC chegaralarga aylantiriladi. Interval boshlanishi kiradi, oxiri kirmaydi. Kun, hafta va oy kesimida grafiklar bo‘lsin.

Manba filtri standartda birinchi manbaga tegishli. Oxirgi murojaat manbasi kerak bo‘lsa alohida rejim sifatida ko‘rsatiladi. Mas’ul filtri joriy yuklamada hozirgi mas’ulga, tarixiy sotuvda yopilish paytidagi mas’ulga tegishli ekani izoh bilan ko‘rsatilsin.

### 15.3 Reyslar dashboard’i

Faol segmentlar `departure_at_utc ASC` tartibida chiqadi. Mijoz, buyurtma havolasi, yo‘nalish, reys, aeroport vaqti, mas’ul, tekshiruv holati, oxirgi tekshiruv va keyingi eslatma ko‘rsatiladi. `Bugun`, `24 soat ichida`, `7 kun ichida`, `Tekshiruv kechikkan`, `Vaqti o‘zgargan` tezkor filtrlari bo‘lsin.

Yangi yoki o‘zgargan ma’lumot web ilovaga SSE orqali uzatilishi mumkin; 30 soniyalik polling fallback bo‘lsin. Faqat haqiqiy yangilanish vaqti ko‘rsatilsin. Tashqi API uzilganda dashboard `Ma’lumotlar eskirgan` holatini ko‘rsatsin.

## 16 Ma’lumotlar bazasi modeli

### 16.1 Asosiy jadvallar

Har bir biznes jadvalda `id` UUID, `company_id`, `created_at`, `updated_at` va zarur bo‘lsa `version` bo‘lsin. Provider ID’lari string yoki xavfsiz katta son sifatida saqlansin; JavaScript aniqlik chegarasida yo‘qolmasin.

| Jadval | Asosiy maydonlar va bog‘lanish |
| --- | --- |
| companies | nom, timezone, ish jadvali, SLA sozlamalari |
| users | email, password_hash, role, active, amo_user_id |
| manager_pools | navbat strategiyasi, pointer, xizmat turi va active |
| manager_pool_members | pool, user, jadval va available holati |
| integration_connections | provider, account_id, encrypted credentials, expires_at, health |
| integration_mappings | entity_type, local_id, external_id, sync_state |
| contacts | amo_contact_id, ism, asosiy aloqa, mas’ul proyeksiyasi |
| contact_identifiers | type, normalized_value, scope, contact_id, verified, shared |
| inquiries | provider_event_id, contact, lead, kanal, source_created_at, attribution |
| leads | amo_lead_id, contact, stage, owner, service_type, requirements, origin |
| lead_events | old_stage, new_stage, old_owner, new_owner, effective_at, observed_at |
| conversations | provider_thread_id yoki scoped peer, account, contact, lead, last_inbound_at |
| messages | provider_message_id, direction, type, content, state, actor, timestamps |
| offers | lead, version, content, amount, currency, valid_until, sent_at |
| orders | order_no, lead, contact, owner, amount, currency va alohida holatlar |
| order_services | order, service_type, tavsif va qiymat |
| passengers | ism, tug‘ilgan sana zarur bo‘lsa, order bilan bog‘lanish |
| flight_segments | order, segment_no, aeroportlar, vaqt zonalari, revision va statuslar |
| tickets | passenger, segment yoki ticket_segments orqali segmentlar, masked reference |
| flight_checks | segment, revision, milestone, result, evidence, checked_by, checked_at |
| payments | order, amount, currency, type, status, reference, recorded_by |
| reminder_rules | offset_seconds, enabled, version, escalation policy |
| reminder_occurrences | order, segment, due_at, state, assignee, revision, dedupe_key |
| notification_deliveries | occurrence, channel, external_task_id, state, attempts |
| webhook_inbox | provider, external_event_id, payload_ref, state, attempts, received_at |
| outbox_operations | operation_id, target, action, payload_ref, state, next_attempt_at |
| audit_logs | actor, entity, action, old_value, new_value, correlation_id |
| attachments | owner entity, object_key, MIME, size, scan_state, retention |

N:N bog‘lanishlar uchun join jadvallari yaratiladi: masalan `order_passengers`, `segment_passengers`, `ticket_segments`. Bir yo‘lovchining qaytish chiptasi boshqa raqamda bo‘lishi mumkin. Keraksiz shaxsiy ma’lumotni qayta ishlatish uchun global passenger katalogi majburiy emas.

### 16.2 Cheklovlar va indekslar

- `company + amo_contact_id`, `company + amo_lead_id` va `company + order_no` unique.
- `provider + connection + external_event_id` inbox dedupe uchun unique. Bir webhook ichidagi har bir xabar yoki lead hodisasi alohida kalit oladi.
- `connection + provider_message_id` unique. Message ID akkauntlar orasida universal deb taxmin qilinmasin.
- `company + business_account_id + scoped_sender_id` uchun bitta aktiv kontakt xaritasi.
- `company + entity_type + external_id` integration mapping uchun unique.
- `company + lead_id` uchun bitta aktiv order cheklovi; bekor qilingan tarix saqlanadi.
- `company + segment + revision + rule_version + milestone` avtomatik occurrence uchun unique.
- Flights uchun `company, departure_at_utc` va `company, owner_id, check_state, departure_at_utc`; reminder uchun `state, due_at`; inbox uchun `state, next_attempt_at` indekslari.
- Money manfiy bo‘lmasin; refund alohida transaction type bilan qayd etilsin. Segment tartib raqami order ichida unique bo‘lsin.
- Barcha foreign key’lar kompaniya chegarasini ham saqlasin. Boshqa kompaniya ID’sini bog‘lash API yoki migratsiya orqali mumkin bo‘lmasin.

Moliyaviy va audit yozuvlariga oddiy kaskad o‘chirish ishlatilmasin. Soft-delete siyosati va zarur qayta identifikatsiyani cheklovchi PII tozalash alohida bajariladi.

## 17 amoCRM sozlamalari va maydonlar xaritasi

`amo-config` buyruq yoki admin wizard mavjud voronka va maydonlarni tekshiradi. Dry-run rejimi bajariladigan ishlarni ko‘rsatadi; apply rejimi yetishmagan qismlarni yaratadi va ID’larni mapping’da saqlaydi. Qayta ishga tushirilganda ayni voronka va maydonlar takror yaratilmasin. Mavjud kompaniya jarayonlari o‘chirib yuborilmasin.

| Obyekt | Native yoki qo‘shimcha maydon |
| --- | --- |
| Kontakt | NAME, PHONE, EMAIL; Instagram username va scoped reference |
| Lid | Native name, responsible_user_id, pipeline_id, status_id |
| Manba | channel, first_source, source_created_at, form_id, campaign/ad references |
| Turizm talabi | service_type, route_summary, travel_date_range, passengers_count |
| Sotuv | native budget va aniq local amount/currency xaritasi |
| Bog‘lanish | external_operation_id, travel_order_id, travel_order_url |
| Avia xulosa | next_departure_at, next_flight_no, next_check_state, next_reminder_at |

Ko‘p segmentli to‘liq model bitta amoCRM kartochkasidagi matnga siqib asosiy manba qilinmasin. Avia maydonlari eng yaqin faol segmentning proyeksiyasidir; to‘liq ma’lumot buyurtma modulida turadi. Har bir manba native `source_id` yaratish bilan teng emas; Sources API talab qilinsa alohida tasdiqlanadi.

Native `price` maydoni va akkaunt valyutasi kasr aniqligi yoki ko‘p valyutani qamrab olmasa, biznes qiymati lokal Decimal/currency juftligida saqlanadi. Amo kartochkasidagi qisqa qiymat uchun konvertatsiya yoki rounding qoidasi sozlama bilan ochiq ko‘rsatiladi [S04].

## 18 Backend API shartnomasi

Quyidagi yo‘llar yaratilayotgan backend API’sidir. Ular amoCRM yoki Meta’ning rasmiy endpoint’lari sifatida talqin qilinmasin. Tashqi endpoint’lar adapter ichida rasmiy hujjatlarga muvofiq implement qilinadi.

### 18.1 Endpoint guruhlari

| Method va yo‘l | Vazifa |
| --- | --- |
| POST /api/v1/auth/login | Sessiya ochish |
| POST /api/v1/auth/logout | Sessiyani tugatish |
| GET /api/v1/me | Foydalanuvchi va huquqlar |
| GET /api/v1/dashboard | Filtrlangan ko‘rsatkichlar |
| GET /api/v1/leads | Ro‘yxat, qidiruv va voronka |
| GET /api/v1/leads/{id} | Lid va tarix |
| PATCH /api/v1/leads/{id}/stage | Statusni biznes qoidalari bilan yangilash |
| PATCH /api/v1/leads/{id}/assignee | Rahbar tomonidan qayta tayinlash |
| GET /api/v1/contacts/{id} | Profil, murojaatlar va buyurtmalar |
| GET /api/v1/duplicates | Dublikat nomzodlari |
| POST /api/v1/duplicates/{id}/resolve | Bog‘lash yoki merge qarorini boshlash |
| POST /api/v1/leads/{id}/offers | Taklif yoki yangi versiya |
| POST /api/v1/orders | Buyurtma yaratish |
| GET /api/v1/orders/{id} | To‘liq buyurtma |
| PATCH /api/v1/orders/{id} | Buyurtma tahriri |
| POST /api/v1/orders/{id}/payments | To‘lovni qo‘lda qayd etish |
| POST /api/v1/orders/{id}/segments | Reys segmenti qo‘shish |
| PATCH /api/v1/segments/{id} | Jadval va ma’lumotlarni o‘zgartirish |
| POST /api/v1/segments/{id}/checks | Tekshiruv natijasi |
| GET /api/v1/flights | Saralangan segmentlar dashboard’i |
| POST /api/v1/reminders | Qo‘lda eslatma |
| PATCH /api/v1/reminders/{id} | Tahrir, snooze yoki bekor qilish |
| POST /api/v1/reminders/{id}/complete | Natija bilan bajarish |
| GET /api/v1/integrations/health | Ulanish va navbat diagnostikasi |
| POST /api/v1/integrations/replay/{id} | Ruxsatli operator tomonidan xavfsiz replay |
| GET /api/v1/events | Huquqlarga mos SSE oqimi |

OAuth boshlash va callback yo‘llari provider bo‘yicha alohida bo‘lsin. Webhook endpoint’lari: `GET/POST /webhooks/meta`, `POST /webhooks/amocrm/crm/{opaque_connection}`, `POST /webhooks/amocrm/chat/{scope}`. Meta GET verifikatsiya challenge’i POST hodisa qabulidan alohida tekshirilsin.

### 18.2 Umumiy API qoidalari

OpenAPI sxemasi kod bilan birga saqlansin. Input allowlist va schema validation bo‘lsin. Ro‘yxatlarda cursor yoki cheklangan pagination, sort allowlist va standart limit 50, maksimal 200 bo‘lsin. Barcha vaqtlar ISO 8601 offset bilan berilsin.

Mutatsiyalar uchun `Idempotency-Key` va payload hash qabul qilinsin. Bir kalit turli payload bilan ishlatilsa `409` qaytarilsin. Buyurtma va moliyaviy yozuvning permanent biznes unique kalitlari qisqa muddatli idempotency keshidan mustaqil ishlasin. CRM tomonidagi uzoq operatsiya `202` va kuzatiladigan `operation_id` bilan qaytishi mumkin.

Xato shakli: `error.code`, foydalanuvchiga tushunarli `message`, zarur `field_errors`, `request_id`. `401`, `403`, `404`, `409`, `422`, `429` farqlansin. Begona obyektga murojaat qilganda uning mavjudligi oshkor bo‘lmasin. Ichki stack trace yoki provider tokeni javobga chiqmasin.

## 19 Webhook navbat va xatolardan tiklanish

### 19.1 Hodisani qabul qilish

Meta uchun imzo raw request body’dan `X-Hub-Signature-256` asosida tekshirilsin; body JSON sifatida qayta serialize qilinmasin. Taqqoslash timing-safe bo‘lsin. Endpoint verification token’i bilan payload imzosi ikki xil tekshiruvdir [S10].

amoCRM Chats API’ning imzo formati o‘z hujjati bo‘yicha implement qilinadi; Meta imzosi bilan bir xil deb olinmasin [S03]. amoCRM CRM webhook’larida universal HMAC bor deb taxmin qilinmasin. Amaldagi format `x-www-form-urlencoded` bo‘lishi mumkin [S11]. Hisob identifikatori tekshirilsin, taxmin qilib bo‘lmaydigan connection route ishlatilsin va muhim o‘zgarishlar tegishli amoCRM akkauntidan qayta o‘qib tasdiqlansin. Payload’ga qarab foydalanuvchi huquqi oshirilmasin.

Valid hodisa avval PostgreSQL inbox’ga commit qilinadi, keyin muvaffaqiyatli HTTP javobi qaytariladi. Maqsad p95 2 soniyadan kam. DB yozuvi muvaffaqiyatsiz bo‘lsa muvaffaqiyat javobi berilmasin; provider retry qila olishi uchun tegishli 5xx qaytarilsin. Og‘ir tashqi API chaqiruvlar webhook request ichida bajarilmasin.

Navbatga uzatish transactional outbox orqali ishlaydi. DB commit bo‘lib Redis uzilgan bo‘lsa ham yozuv pending qoladi va qayta olinadi. Faqat Redis’ga yozib, keyin provider’ga `200` qaytarish yetarli emas.

### 19.2 Takroriy va tartibsiz hodisalar

Tizim at-least-once yetkazishga mos qurilsin. Barcha tashqi yon ta’sirlar avtomatik exactly-once bo‘ladi deb va’da berilmasin. Bir event 10 marta kelganda bir inquiry, bitta mos lid va bir mantiqiy vazifa hosil bo‘lishi kerak.

amoCRM’da kontakt yoki lid yaratish timeout bilan tugasa obyekt yaratilgan bo‘lishi mumkin. Qayta yaratishdan avval oldindan saqlangan `operation_uuid` yoki boshqa tekshiriladigan correlation maydoni bilan reconciliation bajarilsin. Ishonchli aniqlash imkoni bo‘lmasa operatsiya `unknown` holatga olinib operatorga ko‘rsatilsin; cheksiz blind retry bilan yangi lidlar yaratilmasin.

Provayder event ID bermasa kanonik hodisa identifikatori va mazmunli maydonlar asosida dedupe kaliti hisoblanadi. Vaqt bo‘lagiga asoslangan xesh haqiqiy turli xabarlarni yutib yubormasligi shart. Mos yozuvning oldingi versiyasi kelganda eng so‘nggi obyekt qayta olinadi.

### 19.3 Retry siyosati

| Xato turi | Harakat |
| --- | --- |
| Vaqtinchalik tarmoq xatosi yoki 5xx | Yon ta’sir noaniqligini hisobga olgan exponential backoff va jitter |
| 429 | Provider ko‘rsatmasi yoki Retry-After’ga mos kutish; umumiy limiter |
| 401 | Bitta sinxronlangan token refresh; muvaffaqiyatsiz bo‘lsa qayta ulash |
| 400 yoki validatsiya | Avtomatik cheksiz retry yo‘q; mapping xatosi va operator ko‘rigi |
| 403 yoki ruxsat yo‘q | Tegishli operatsiyani pauza qilish va administratorga signal |
| Tarif yoki to‘lov bilan bog‘liq blok | Provider kodi saqlanadi, mutatsiyalar to‘xtaydi, administratorga ko‘rsatiladi |
| Natijasi noma’lum mutatsiya | Reconciliation yoki operator; avtomatik qayta yaratish yo‘q |

Oddiy vaqtinchalik ishlar uchun standart maksimal 8 urinish, umumiy davomiylik 24 soatgacha; shoshilinch reys eslatmalari alohida tez eskalatsiya yo‘liga ega. Keyin dead-letter holati, sabab va xavfsiz replay tugmasi bo‘lsin. Replay bir xil biznes kalitlarini saqlasin.

amoCRM limiter boshlang‘ichda integratsiya uchun 5 request/second qilib sozlanadi va akkauntdagi umumiy limit ham hisobga olinadi. Rasmiy hujjatda integratsiya va akkaunt darajasida alohida limitlar bor [S01]. Limiter barcha API va worker process’lari orasida umumiy bo‘lsin; xabar yoki polling oqimi muhim vazifalarni och qoldirmasin.

### 19.4 OAuth va tokenlar

Access va refresh tokenlar shifrlangan holda saqlansin. `expires_in` qiymati ishlatilsin, amal qilish muddati kodga ko‘milmasin. Yangilash connection lock bilan bajarilsin va yangi token juftligi atomik almashtirilsin. Parallel worker’lar eski refresh tokenni qayta ishlatmasin [S02].

OAuth state bir martalik, vaqt bilan cheklangan va sessiyaga bog‘langan bo‘lsin. Redirect URI qat’iy tekshirilsin. Amo akkaunt domeni allowlist bilan tasdiqlansin; foydalanuvchi bergan ixtiyoriy URL’ga token jo‘natilmasin. Ulanish uzilganda yangi API ishlari pauza qilinadi, ammo mavjud audit va buyurtmalar o‘chirilmaydi.

## 20 Interfeys sahifalari

### 20.1 Navigatsiya

Asosiy bo‘limlar: Dashboard, Lidlar, Mijozlar, Buyurtmalar, Reyslar, Eslatmalar. Rahbar uchun Menejerlar va Hisobotlar; administrator uchun Integratsiyalar, Foydalanuvchilar va Sozlamalar qo‘shiladi.

Desktop asosiy ish muhiti. 1366 px ekran va 768 px planshet kengligida asosiy amallar ishlasin. Kichik ekranda jadval uchun boshqariladigan scroll bo‘lishi mumkin. Sahifa umumiy gorizontal siljib ketmasin.

### 20.2 Asosiy ko‘rinishlar

- Dashboard: KPI kartalari, manba va kunlar bo‘yicha grafik, voronka, menejerlar jadvali, yaqin reyslar.
- Lidlar: amoCRM native voronkasiga havola hamda lokal ro‘yxat; status o‘zgarishi server qoidalari bilan.
- Mijoz kartasi: aloqa, Instagram, murojaatlar, chat havolasi, buyurtmalar va izohlar.
- Buyurtma kartasi: xizmat, taklif, to‘lov, yo‘lovchilar, segmentlar, tekshiruvlar, eslatmalar va audit.
- Reyslar: eng yaqin jo‘nashdan boshlab saralangan jadval va tekshiruv formasi.
- Integratsiyalar: connection holati, oxirgi webhook, oxirgi sync, xatolar, backlog va qayta ulash.

Barcha forma va jadvallarda loading, empty, error, permission denied va stale holatlari bo‘lsin. Xato yuz berganda foydalanuvchi kiritgan matn saqlansin. Rangga qo‘shimcha matnli status, klaviatura bilan ishlash va asosiy accessibility belgilaridan foydalanilsin. Demo ma’lumot production ma’lumotiga o‘xshatib aralashtirilmasin.

## 21 Xavfsizlik audit va saqlash

TLS, DB va backup shifrlash, secret manager yoki himoyalangan deployment secret’lari ishlatilsin. Token, client secret va chat kaliti frontend bundle, browser storage, log yoki git’ga chiqmasin. Mahalliy `.env` gitignore’da bo‘lsin; repozitoriyda faqat `.env.example` saqlansin.

Fayllar private object storage’da saqlanib, qisqa muddatli signed URL bilan berilsin. MIME va hajm tekshirilsin; virus tekshiruvi tugamagan fayl ochilmasin. Boshlang‘ich limit har fayl uchun 10 MB. Media URL’ni backend yuklaganda SSRF himoyasi va provider allowlist bo‘lsin. Instagram attachment havolasi doimiy ishlaydi deb hisoblanmasin.

Audit quyidagilarni qamrasin: login, rol o‘zgarishi, integration connect/disconnect, lid statusi va mas’uli, kontakt merge’i, narx va to‘lov tahriri, reys revision’i, tekshiruv, mijozni xabardor qilish, eslatma va eksport. Auditda muallif, vaqt, obyekt, oldingi va yangi qiymat hamda correlation ID bo‘lsin. Oddiy foydalanuvchi auditni o‘zgartira olmasin.

Taklif etilgan retention: raw webhook 30 kun, texnik log 90 kun, yozishma mazmuni 12 oy. Audit, buyurtma va to‘lov yozuvlari kompaniya tasdiqlagan siyosatga ko‘ra saqlansin. Siyosat sozlanadi; production’dan oldin tasdiqlanmagan muddat yashirin default bo‘lib qolmasin. Raw payload logga chiqarilmasin, alohida shifrlangan va cheklangan joyda saqlansin.

Shaxsiy ma’lumotni o‘chirish yoki anonimlashtirish amali kontakt, yozishma, fayl, qidiruv proyeksiyasi va tegishli provider nusxalarini ko‘rib chiqsin. Alohida saqlanishi zarur moliyaviy yozuvlar uchun kompaniya siyosati qo‘llansin. Backup’dan tiklashda oldingi o‘chirish talablari qayta qo‘llanishi uchun tombstone saqlansin.

Hosting hududi, Meta va amoCRM’ga uzatiladigan shaxsiy ma’lumotlar doirasi kompaniya tomonidan production’dan oldin tasdiqlansin. Demo va testlarda sun’iy ma’lumot ishlatilsin.

## 22 Unumdorlik monitoring va tiklash

### 22.1 Boshlang‘ich yuk profili

Qabul qilish muhiti uchun 20 xodim, 50 000 kontakt, 100 000 lid, 1 000 000 xabar va 10 000 reys segmenti bo‘yicha test dataset tayyorlansin. Bu biznes hajmi haqidagi ma’lumot emas, tizimni tekshirish uchun loyiha maqsadidir. Asosiy API/DB muhitida kamida 4 vCPU va 8 GB RAM ekvivalenti ajratilgan konfiguratsiya qayd etilsin; DB va Redis resurslari alohida o‘lchansin.

| Mezon | Maqsad |
| --- | --- |
| Webhook durable ACK | p95 2 soniyadan kam |
| Lokal oddiy GET API | p95 500 ms dan kam, 20 parallel foydalanuvchida |
| Dashboard javobi | p95 2 soniyadan kam, qayd etilgan dataset va filtrlar bilan |
| Kiruvchi eventdan amoCRM’da ko‘rinish | Normal limit va ishlayotgan provider’da p95 60 soniyagacha |
| Eslatma due’dan ichki ko‘rinishgacha | p95 60 soniyagacha, tashqi nosozliksiz |
| Webhook sig‘imi | 10 event/second kirishda 15 daqiqa davomida durable yo‘qotishsiz |
| Ichki xizmat SLO | Oyiga 99,5 foiz, tashqi provayder uzilishlari alohida ko‘rsatiladi |

Qisqa burst’da webhook qabul qilish tezligi amoCRM’ga yozish tezligidan katta bo‘lishi mumkin. Navbatning o‘sishi, tugash vaqti va backlog ko‘rsatilsin; rate limitdan oshib tezlashtirish qilinmasin. “Real vaqt” tashqi provayderning kafolatlangan nol kechikishi sifatida talqin qilinmaydi.

### 22.2 Kuzatiladigan holatlar

Structured log’da request_id, correlation_id, provider va operation state bo‘lsin. PII redaction ishlasin. Metrikalar: webhook_count, signature_failures, processing_lag, queue_depth, oldest_job_age, retries, DLQ, token_refresh_failures, sync_conflicts va overdue_reminders.

Admin uchun signal: faol kanal oqimi kutilmagan tarzda uzilishi, 5 daqiqadan ortiq normal backlog, token yangilash xatosi, takroriy 429, scheduler ishlamay qolishi yoki T-3h eskalatsiyasi. Bildirishnoma kanali boshlanishida ichki monitoring va ilova bo‘ladi; tashqi kanal alohida sozlanadi. Faqat yangi lid kelmagani sabab nosozlik deb xulosa qilinmasin, heartbeat va texnik so‘rov bilan tekshirilsin.

### 22.3 Backup va qayta tiklash

Production maqsadi: RPO 15 daqiqagacha, RTO 4 soatgacha. Bunga mos boshqariladigan PostgreSQL PITR yoki ekvivalent WAL arxivlash bo‘lsin; faqat kunlik dump ushbu RPO’ni bajarmaydi. Fayllar versioning va mos backup siyosatiga ega bo‘lsin. Restore ssenariysi alohida muhitda amalda bajarilsin.

Health endpoint process tirikligini, readiness esa DB va zarur qaramliklarni ko‘rsatsin. Scheduler va worker uchun alohida heartbeat bo‘lsin. Deployment’dan keyin backlog va pending outbox xavfsiz davom etsin. Oldingi versiyaga rollback uchun DB migratsiyalari expand/contract uslubida rejalashtirilsin.

## 23 Qabul qilish ssenariylari

Har bir ssenariy uchun test dalili, kutilgan natija va haqiqiy natija saqlansin. Quyidagi mezonlar ishlab chiqarish versiyasining Definition of Done qismidir.

| ID | Ssenariy | Kutiladigan natija |
| --- | --- | --- |
| AC01 | Yangi test Lead Ads formasi | Bitta inquiry, kontakt yoki mos bog‘lanish, bitta lid, to‘g‘ri manba va mas’ul |
| AC02 | Bir hodisa 10 marta keladi | Lid, xabar va vazifa dublikatlari yaratilmaydi |
| AC03 | Ikki parallel kanal bir telefon yuboradi | Ziddiyatsiz bitta kontakt yoki aniq conflict navbati; silent merge yo‘q |
| AC04 | Telefon bir oilada umumiy | Shaxslar tasodifan birlashtirilmaydi |
| AC05 | Direct yangi xabar va davomiy suhbat | Birinchi xabarda lid, keyingi xabarlarda o‘sha suhbat; har xabar uchun yangi lid yo‘q |
| AC06 | amoCRM ichidan inson javobi | Xabar Instagram’da olinadi, provider ID va holat saqlanadi |
| AC07 | Meta yuborish oynasi yopiq | Sabab ko‘rsatiladi va taqiqlangan yuborish bajarilmaydi |
| AC08 | Click-to-Direct reklama | Direct manbasi va mavjud referral saqlanadi; forma sifatida sanalmaydi |
| AC09 | Kampaniya metadata’si olinmaydi | Lid ishlashda davom etadi, enrichment xatosi alohida ko‘rinadi |
| AC10 | 3 teng menejerga parallel 100 yangi lid | Sticky holatlar chiqarilganda taqsimot farqi ko‘pi bilan 1 |
| AC11 | Faol menejer yo‘q | Navbat yoki belgilangan navbatchi va rahbarga signal |
| AC12 | Menejer boshqa mijoz ID’sini so‘raydi | API, fayl, SSE va eksport orqali ma’lumot ochilmaydi |
| AC13 | Native amoCRM’da mas’ul o‘zgaradi | Lokal huquqlar va faol vazifalar yangilanadi, tarix muallifi saqlanadi |
| AC14 | Native statusda majburiy maydon yetishmaydi | Anomaliya va tuzatish vazifasi; yolg‘on “to‘liq” holat yo‘q |
| AC15 | WON va takroriy webhook | Bitta faol buyurtma, bitta sotuv hisoblanadi |
| AC16 | Borish, ulanish va qaytish segmentlari | Alohida vaqtlar, tekshiruvlar va eslatmalar |
| AC17 | Boshqa vaqt zonasi va DST holati | UTC hisob va aeroport vaqti to‘g‘ri; noaniq vaqt tasdiqlanadi |
| AC18 | 168h, 72h, 24h, 3h milestone | Har biri uchun bitta mantiqiy occurrence va kerakli kanallar |
| AC19 | Uchishga 2 soat qolganda order kiritiladi | Bitta shoshilinch tekshiruv; to‘rtta eski eslatma yo‘q |
| AC20 | Oldingi milestone tekshirilgan | Keyingi milestone mustaqil tekshiruv talab qiladi |
| AC21 | Reys jadvali o‘zgaradi | Revision oshadi, eski queued ish tashlanadi, kelajak jadval yangilanadi |
| AC22 | Reys yoki order bekor qilinadi | Odatiy kelajak eslatmalari to‘xtaydi; tarix va zarur follow-up saqlanadi |
| AC23 | Native CRM vazifasi natijasiz yopiladi | Reys tekshirildi deb hisoblanmaydi |
| AC24 | Qo‘lda recurring eslatma va snooze | Cheklangan takrorlanish, to‘g‘ri keyingi vaqt va tarix |
| AC25 | Worker yoki Redis qayta ishga tushadi | DB pending ishlari tiklanadi, yuborilgan yon ta’sir dublikat bo‘lmaydi |
| AC26 | DB ishlamaydi va webhook keladi | Muvaffaqiyat ACK berilmaydi; soxta “qabul qilindi” yo‘q |
| AC27 | Provider’da 429 yoki 5xx | Limiter, backoff, retry va ko‘rinadigan backlog |
| AC28 | Parallel OAuth refresh | Bitta yangilash va atomik yangi token juftligi |
| AC29 | Lid yaratish javobi timeout | Reconciliation; tasdiqsiz yangi lid qayta yaratilmaydi |
| AC30 | Tartibsiz eski status hodisasi | So‘nggi haqiqiy holat orqaga qaytmaydi |
| AC31 | UZS va USD sotuvlari | Alohida yig‘indi; noto‘g‘ri umumiy summa yo‘q |
| AC32 | Boshqa davrda yaratilgan lid hozir yopiladi | Kohorta va yopilganlar konversiyasi ta’rif bo‘yicha farqlanadi |
| AC33 | Bot javob, keyin inson javobi | First response inson javobidan hisoblanadi |
| AC34 | Integration o‘chiriladi | Ishlar pauzada, administrator ko‘radi, tarix yo‘qolmaydi |
| AC35 | Backup restore sinovi | Belgilangan RPO/RTO dalil bilan tekshiriladi |
| AC36 | Staging end-to-end safar | Forma yoki DM → lid → taklif → sotuv → segment → eslatma → tekshiruv |

Avtomatlashtirilgan testlar: biznes qoidalari uchun unit; haqiqiy PostgreSQL/Redis bilan integration; provider adapterlari uchun contract fixture; UI va rollar uchun E2E. Meta va amoCRM sandbox/test akkauntlaridagi smoke test alohida bajariladi. Mock testlar tashqi integratsiya ishlashini isbotlamaydi.

## 24 Ishlab chiqish bosqichlari va topshiriladigan natijalar

### B0 Integratsiya imkoniyatlarini isbotlash

G01–G09 sinovlari, tanlangan Direct yo‘li, ruxsatlar matritsasi va `docs/feasibility.md`. Bloklangan tashqi ruxsat aniq yoziladi. Shu vaqt davomida demo adapter bilan boshqa modullarni ishlab chiqish mumkin; real integratsiya ishladi deb ko‘rsatilmaydi.

### B1 Loyiha asosi

Monorepo, Docker Compose, DB migratsiyalari, auth, RBAC, audit va CI. Sun’iy seed ma’lumot. Backend health va API dokumentatsiya. Boshqa menejer mijozini o‘qish taqiqlanganligi test bilan isbotlanadi.

### B2 amoCRM va lid jarayoni

OAuth, configurable mapping, kontakt/lid importi, inbox/outbox, CRM webhook, dedupe, taqsimlash va statuslar. Native qo‘lda tahrirning sinxronlash sinovlari. Source of truth qoidalari test bilan yopiladi.

### B3 Instagram oqimlari

Lead Ads, Direct ikki tomonlama chat, message ID xaritasi, echo suppression, permission va messaging-window tekshiruvi, token nosozligi va reconciliation. AC01–AC09 testlari.

### B4 Turizm operatsiyalari

Talab, taklif versiyalari, buyurtma, to‘lov qaydlari, yo‘lovchilar, multi-segment va vaqt zonalari. `manual` reys tekshiruvlari. Sun’iy ma’lumotlar bilan to‘liq safar ssenariysi.

### B5 Eslatma va nazorat

Scheduler, milestone, qo‘lda recurrence, eskalatsiya, native task bog‘lanishi, revision bilan qayta rejalash va reyslar dashboard’i. Worker restart va eski queued job sinovlari.

### B6 Hisobot va tayyorlash

KPI formulalari, menejer ko‘rsatkichlari, filtrlar, RBAC eksport, performance, monitoring, backup restore va staging UAT. Real integratsiya dalillari va ochiq muammolar ro‘yxati bilan topshiriladi.

Har bosqich mustaqil ko‘rib chiqiladigan commit’larda bajarilsin. Bosqich tugadi deyish uchun shu bosqichning ishga tushadigan kodi, migratsiyasi, zarur testi va hujjati mavjud bo‘lsin. Dizayn ekrani yoki faqat mock data bosqichning funksional tayyorligi hisoblanmaydi.

## 25 Repository tuzilishi va ishga tushirish shartlari

### 25.1 Tavsiya etilgan tuzilma

| Yo‘l | Tarkib |
| --- | --- |
| apps/web | Next.js interfeys va API client |
| apps/api | NestJS modullari va webhook endpoint’lari |
| apps/worker | Shu biznes modullaridan foydalanadigan worker bootstrap |
| packages/domain | Sof biznes qoidalari va qiymat turlari |
| packages/integrations | amoCRM REST, Chats, Meta Leads, Meta Direct, FlightProvider |
| packages/contracts | DTO, sxema va OpenAPI turlari |
| packages/database | Prisma schema, migratsiya va sun’iy seed |
| infra | Docker Compose va deploy konfiguratsiya |
| tests | Contract fixture, integration va E2E |
| docs | Arxitektura, qarorlar, feasibility, runbook va qabul dalillari |

`demo` rejimida tashqi provayderlar mock adapter bilan ishlaydi, katta ko‘rinadigan DEMO belgisi bo‘ladi va real mijozga xabar yuborilmaydi. `staging` test aktivlari bilan, `production` tasdiqlangan aktivlar bilan ishlaydi. Production’da mock adapter aniqlansa dastur ishga tushishni rad etsin.

### 25.2 Konfiguratsiya guruhlari

DB/Redis URL, ilova public URL, session va encryption secrets, amoCRM base domain/client ID/client secret/redirect URI, chat channel ID/secret/scope, Meta app ID/secret/verify token/API version, provider account IDs, object storage va monitoring parametrlari hujjatlashtirilsin. Haqiqiy access tokenlar odatiy `.env` nusxasida tarqatilmasin; ulanishdan keyin shifrlangan bazada saqlansin.

Paket manager skriptlari kamida `dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `db:migrate`, `db:seed` vazifalarini bajarsin. Docker Compose uchun bitta hujjatlashtirilgan local ishga tushirish yo‘li bo‘lsin. Testlar uchun production sirlar talab qilinmasin.

### 25.3 Yakuniy topshirish to‘plami

To‘liq source code va lockfile; ishlaydigan local/staging konfiguratsiya; migratsiya va seed; OpenAPI; maydonlar mapping’i; integration setup; administrator va menejer qo‘llanmasi; monitoring, replay, backup/restore va token qayta ulash runbook’i; test natijalari hamda qabul ssenariylari dalillari topshirilsin.

Tugallanmagan qismlar `KNOWN_LIMITATIONS.md`da ochiq yozilsin. Kod ichida business-critical `TODO`, soxta provider javobi yoki ishlamaydigan tugma qolmasin. Tashqi App Review kutilyapti degan holat bilan real Direct ishladi degan holat ajratilsin.

## 26 Ish boshlashdagi konfiguratsiya qarorlari

Quyidagi qiymatlar aniqlanmaguncha local demo va mustaqil modullarni ishlab chiqish davom etadi. Ularga bog‘liq production amali esa haqiqiy qiymat bilan tekshiriladi.

| Qaror | Hozirgi loyiha standarti yoki kerakli ma’lumot |
| --- | --- |
| Kompaniya va amoCRM | Domen, account ID, tarif, test va production akkauntlar |
| Instagram | Professional akkaunt, Page va reklama aktivlari, administrator kirishi |
| Direct kanali | B0’da tekshirilgan tayyor konnektor yoki custom Chats API |
| Xodimlar | Administrator, rahbar, menejerlar va amo_user_id xaritasi |
| Taqsimlash | Teng round-robin; sticky_owner va ish jadvali tasdiqlanadi |
| Valyuta | Asosiy valyuta va boshqa valyutalar; birlashtirilgan summa hozircha yo‘q |
| Vaqt zonasi | Kompaniya Asia/Tashkent; har aeroportning o‘z IANA zonasi |
| Sotuv tasdiqlash | WON uchun buyurtma va tasdiq dalili; to‘lov holati alohida |
| Eslatmalar | 168h, 72h, 24h, 3h; T-3h uchun navbatchi mas’ul kerak |
| Reys holati | Birinchi versiyada qo‘lda; real provider alohida tanlanadi |
| Hosting va xavfsizlik | Hudud, domen, TLS, secret, private storage va backup |
| Saqlash | Retention muddatlari va o‘chirish tartibi kompaniya bilan tasdiqlanadi |

## 27 Rasmiy texnik manbalar

2026-yil 24-oktabrda rasmiy hujjatlar va ularning qidiruvda ko‘rinadigan tegishli bo‘limlari tekshirildi. Platforma huquqlari, tarif imkoniyati va API versiyasi B0’da real akkaunt bilan yana tasdiqlanadi. Quyidagi manbalar integratsiya cheklovlari uchun berilgan; biznes modeli va ichki API ushbu loyiha uchun ishlab chiqilgan talabdir.

[S01] amoCRM API cheklovlari va tavsiyalar. https://www.amocrm.ru/developers/content/api/recommendations

[S02] amoCRM OAuth va token almashinuvi. https://www.amocrm.ru/developers/content/oauth/step-by-step

[S03] amoCRM Chats API boshlash va alohida avtorizatsiya. https://www.amocrm.ru/developers/content/chats/chat-start

[S04] amoCRM lidlar API’si va standart maydonlar. https://www.amocrm.ru/developers/content/crm_platform/leads-api

[S05] amoCRM voronkalar va statuslar. https://www.amocrm.ru/developers/content/crm_platform/leads_pipelines

[S06] Meta Instagram Login va ruxsatlar. https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login

[S07] Meta Instagram xabar yuborish imkoniyatlari. https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api

[S08] Meta Instagram webhook’lari va App Review. https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks

[S09] Meta Lead Ads ma’lumotlarini olish. https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/

[S10] Meta webhook verifikatsiyasi va payload imzosi. https://developers.facebook.com/docs/graph-api/webhooks/getting-started/

[S11] amoCRM CRM webhook formatlari. https://www.amocrm.ru/developers/content/crm_platform/webhooks-format

## 28 Claude Code uchun bajarish tartibi

Ushbu fayl repozitoriyda `docs/TZ.md` sifatida saqlanadi. Hamroh `CLAUDE_CODE_START.md` faylidagi boshlang‘ich topshiriq Claude Code’ga beriladi. Avval repository tekshiriladi va B0–B1 ishlari bajariladi. Keyingi bosqichlar ishlaydigan oldingi bosqich ustiga qo‘shiladi.

Claude Code yo‘q permission, provider ID, API endpoint yoki integration imkoniyatini o‘ylab topmasin. Real ruxsat yo‘q bo‘lsa adapter interfeysi, contract test va aniq belgilangan demo bilan mustaqil ishni davom ettirsin. Tashqi integratsiya faqat haqiqiy end-to-end dalil mavjud bo‘lsa ishlaydi deb belgilanadi.

Har bosqich yakunida bajarilgan qism, o‘zgargan fayllar, ishga tushirish usuli, o‘tgan testlar, tekshirilmagan tashqi shartlar va keyingi bosqich yozilsin. Tekshirilmagan natija “tayyor” deb berilmasin.
