# NONA Travel: target reklamalaridan lid olish

## Qo‘shilgan imkoniyat

Administrator **Интеграции → Рекламные формы Facebook и Instagram** orqali Facebook bilan kiradi,
NONA Travel reklama formasi tegishli bo‘lgan Page’ni va kerakli formalarni tanlaydi.
Forma yuborilganda imzosi tekshirilgan webhook doimiy inbox’ga yoziladi; worker haqiqiy Graph API’dan
javoblarni oladi va mijoz/lid yaratadi yoki mavjud safarga bog‘laydi. Ism, telefon, email,
barcha maxsus savol javoblari va reklama atributlari saqlanadi. Forma javoblari lid va mijoz kartasida ko‘rinadi.
Menejer faqat o‘ziga tegishli yozuvlarni ko‘radi; ulash faqat administratorga ochiq.

Instagram Direct ulanishi bu ulanishdan alohida. Direct OAuth/tokenlari o‘zgarmaydi.
amoCRM kerak emas. Reklama budjeti, kampaniyalar yoki e’lonlarni bu kod yaratmaydi/o‘zgartirmaydi.

## Deploy (mavjud bazani saqlagan holda)

1. Kodni tekshirib, odatiy Railway deploy jarayoni bilan API, worker va web’ni yangilang.
   Yangi DB migratsiyasi talab qilinmaydi. `db:reset`, seed yoki production bazani almashtirish kerak emas.
2. API va worker’da `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`,
   `META_GRAPH_VERSION` bir xil Meta/Facebook ilovasiga mos bo‘lsin.
   `INSTAGRAM_APP_ID/SECRET` bilan almashtirmang: ular Direct uchun.
   `ENCRYPTION_KEY` mavjud qiymatini o‘zgartirmang.
3. Meta ilovasi «Вход через Facebook для компаний» (Facebook Login for Business) bo‘lsa, scope e’tiborga olinmaydi: Конфигурации bo‘limida «User access token» konfiguratsiyasini yarating (ads_management, leads_retrieval, pages_manage_metadata, pages_read_engagement, pages_show_list) va uning ID’sini `META_LEADS_CONFIG_ID` ga qo‘ying.
   `META_LEADS_REDIRECT_URI` default qiymati:
   `<APP_PUBLIC_URL>/api/v1/integrations/lead-ads/oauth/callback`.
   Railway’dagi aniq URL’ni Meta ilovasining Facebook Login valid OAuth redirect URI ro‘yxatiga qo‘shing.
4. Meta App Dashboard’da Page webhook uchun `<APP_PUBLIC_URL>/webhooks/meta`, mavjud verify token
   va `leadgen` maydonini sozlang. Bu GET challenge hamda POST HMAC-SHA256 tekshiruvlari alohida.
5. Facebook Login uchun `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`,
   `pages_read_engagement`, `ads_management` ruxsatlarini tayyorlang. Kompaniya tashqi foydalanuvchi
   bo‘lsa, kerakli App Review/access va Business sozlamalari haqiqiy akkaunt bilan tekshiriladi.
   Meta Business’dagi Page/ad account/Leads Access ruxsatlari ham kerak: OAuth’ning o‘zi ularni bermaydi.
6. Administrator ulash tugmasini bosadi, Meta oynasida ruxsat beradi, to‘g‘ri Page va formalarni tanlaydi.
   Page tokenlari brauzerga qaytarilmaydi: tanlash vaqtida server Redis’ida shifrlangan, 10 daqiqalik,
   shu admin sessiyasiga bog‘langan holda; ulashdan keyin bazada shifrlangan holda saqlanadi.
7. Page’ning `leadgen` obunasi API’dan qayta o‘qib tasdiqlanadi. Eski subscription maydonlari saqlanadi.
   Yaqin 7 kunlik formalar tarixi navbatga qo‘yiladi; mavjud Meta retrieval oynasi/ruxsatlari bilan cheklanadi.

## Haqiqiy qabul sinovi — reklama xarajatisiz

1. Meta Lead Ads Testing Tool’da aynan tanlangan Page/form uchun test lid yuboring.
2. CRM’da **Лиды** ni ochib, **Instagram Lead Ads** yoki **Meta Lead Ads** manbasini tekshiring.
   Formaning platformasi aniq kelmasa, manba **Meta Lead Ads (место неизвестно)** bo‘lib qoladi;
   u avtomatik Instagram deb taxmin qilinmaydi.
3. Kartada ism/telefon, tanlangan yo‘nalish va maxsus savol javoblarini tekshiring.
4. Bir xil webhook qayta yuborilganda ikkinchi inquiry/lid yaratilmasin.
5. **Интеграции** da `Получение заявок проверено` faqat haqiqiy imzolangan webhook
   qayta ishlangandan keyin ko‘rinadi. Faqat OAuth, subscription yoki backfill bu dalil hisoblanmaydi.
6. Begona menejer uchun kartaga kirish rad etilishini tekshiring. Demo formani yuborish live ulanishni tekshirmaydi.

`APP_MODE=demo` bo‘lsa ham `mode=live` Page har doim haqiqiy Graph adapterdan foydalanadi.
Haqiqiy adapter sozlanmaganida demo adapterga zaxira yo‘l yo‘q. Demo simulyatori faqat demo ulanishni tanlaydi.

## Lokal tekshiruvlar va cheklov

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
Haqiqiy PostgreSQL/Redis bilan `npm run test:integration -- tests/integration/lead-ads-login.test.ts`.
Testlar Facebook HTTP javoblarini fixture bilan almashtiradi; Meta akkauntida live tasdiq hisoblanmaydi.

Bu o‘zgarish avtomatik Meta ruxsatini olmaydi, Railway secretlarini bilmaydi, targetni yoqmaydi.
Page tokeni bekor qilinsa qayta ulash kerak. Lead Ads tarixining hammasini qaytarish kafolatlanmaydi.
Yangi formani reklamada ishlatishdan oldin CRM’da shu formani tanlab ulash kerak.

## Rasmiy manbalar

- https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-leadgen/
- https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/retrieving
- https://developers.facebook.com/documentation/pages-api/manage-pages

Ruxsatlar ro‘yxati 2026-10-25 kuni rasmiy Meta hujjatlarining qidiruv natijalari bilan tekshirildi.
Hujjat sahifalarining to‘liq ochilishi 429 bilan cheklangan; endpoint kontraktlari haqiqiy akkauntdagi qabul sinovida tasdiqlanishi kerak.
