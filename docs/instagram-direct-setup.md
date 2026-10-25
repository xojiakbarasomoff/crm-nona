# Instagram Direct’ni ulash: Instagram API with Instagram Login

Holat: 2026-10-25. Kod tayyor va **mock Meta javoblari bilan sinalgan** (`tests/integration/instagram-login.test.ts`); **haqiqiy Instagram akkauntda hali tasdiqlanmagan**. Facebook Page talab qilinmaydi. Lead Ads (Facebook Login/Page) bu hujjatdan tashqarida va **bloklangan** holda qoladi.

## 1. Tanlangan yo‘l va nega

Meta’da Instagram Direct uchun ikki yo‘l bor: **Instagram API with Instagram Login** (Instagram professional akkaunt egasi to‘g‘ridan-to‘g‘ri Instagram’da avtorizatsiya qiladi, Facebook Page shart emas) va Instagram API with Facebook Login (akkaunt Facebook Page’ga bog‘langan bo‘lishi shart). Facebook Page topilmagani uchun faqat birinchisi ishlatiladi; ikkalasi aralashtirilmaydi (`/me/messages`, `graph.instagram.com`, `www.instagram.com/oauth/authorize`, `api.instagram.com`).

## 2. Talablar (Meta rasmiy hujjatlaridan, 2026-10-25 o‘qilgan)

| Talab | Tafsilot |
| --- | --- |
| Akkaunt | Instagram **professional** akkaunt (Business yoki Creator). Shaxsiy (PERSONAL) akkaunt ulanmaydi — kod rad etadi (`INSTAGRAM_NOT_PROFESSIONAL`). Hujjatda test akkaunti «public» bo‘lishi aytilgan. |
| Meta App | Meta developer akkaunt + Meta App, unga **Instagram** mahsuloti → **«API setup with Instagram login»** qo‘shiladi. Bu bo‘limda **Instagram app ID / Instagram app secret** ko‘rinadi (Meta App ID/secret’dan alohida bo‘lishi mumkin). |
| Ruxsatlar | `instagram_business_basic`, `instagram_business_manage_messages` (eski `business_manage_messages` 2025-01-27 dan o‘chirilgan). |
| Access daraja | **Standard Access**: ilova **o‘zingiz egalik qiladigan/boshqaradigan** akkauntlarga xizmat qilsa va ular App Dashboard’da qo‘shilgan bo‘lsa. **Advanced Access**: ilova **boshqa kompaniyalarning** (siz egasi bo‘lmagan) akkauntlariga xizmat qilsa. |
| App Review | Hujjatlar bir-biriga to‘liq mos emas: «Instagram App Review tugamaguncha jonli ma’lumotga kira olmaydi» deyiladi, boshqa joyda Standard Access test rollari bilan ishlashi aytiladi. **Ochiq aytamiz:** NONA Travel o‘z akkauntini o‘z ilovasiga ulasa, odatda Development rejimi + ilova roli bilan sinash mumkin; ammo **jonli (Live) rejim va boshqa mijozlarning akkauntlari uchun App Review + Advanced Access (ko‘pincha Business Verification) kerak bo‘ladi.** Test ulanish **barcha mijozlar uchun tayyor integratsiya emas**. |
| Xabar qoidalari | Foydalanuvchi birinchi yozgandan keyingina javob berish mumkin; standart oyna 24 soat (Click-to-Direct reklamadan — 7 kungacha). Human Agent tegi (7 kun) alohida ruxsat/review talab qiladi (`META_HUMAN_AGENT_GRANTED=false` qoldiriladi). Matn ≤ 1000 bayt. |
| Tokenlar | Avtorizatsiya kodi 1 soat, bir martalik → qisqa token → **uzun muddatli token (~60 kun)**; ≥24 soatlik tokenni yangilash mumkin, 60 kun yangilanmasa o‘ladi. Kod buni worker’da avtomatik yangilaydi (`instagram-token` sikli, 6 soatda bir, 14 kundan kam qolganlarni). |
| Jonli vs sinov | Meta panelida ilova **Development** rejimida ekan, faqat ilovada roli bor akkauntlar ishlaydi. |

## 3. Railway’dagi haqiqiy URL’lar (mavjud route’lardan)

Web domeni: `https://web-production-e57d0a.up.railway.app` (backend ichki; Meta webhook’lari Next.js rewrite orqali backend’ga o‘tadi — `apps/web/next.config.mjs`).

| Meta panelidagi maydon | Qiymat |
| --- | --- |
| **Valid OAuth Redirect URI** (Business login settings) | `https://web-production-e57d0a.up.railway.app/api/v1/integrations/instagram/oauth/callback` |
| **Webhooks → Callback URL** | `https://web-production-e57d0a.up.railway.app/webhooks/meta` |
| **Webhooks → Verify token** | siz o‘ylab topgan tasodifiy qator; **xuddi shu qiymat** Railway’da `META_VERIFY_TOKEN` |
| **Deauthorize callback URL** | `https://web-production-e57d0a.up.railway.app/webhooks/meta/deauthorize` |
| **Data deletion request URL** | `https://web-production-e57d0a.up.railway.app/webhooks/meta/data-deletion` (holat sahifasi: `/data-deletion`) |
| Privacy Policy URL | Kompaniyaning o‘z siyosat sahifasi (kodda yo‘q; Live rejim uchun majburiy) |

Webhook obuna maydonlari: `messages`, `messaging_seen` (kod faqat shularni ishlatadi). Imzo: `X-Hub-Signature-256` (xom tana, HMAC-SHA256) — **faqat `META_APP_SECRET`** bilan tekshiriladi, zaxira sir yo‘q (1.1 ga qarang).

## 4. Railway sozlamalari (backend xizmati) — qiymatlarni chatga yozmang

`INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION` (Meta panelida ko‘rsatilgan versiya, masalan `v23.0` yoki yangiroq), ixtiyoriy `META_APP_SECRET`. `INSTAGRAM_REDIRECT_URI` berilmasa `APP_PUBLIC_URL + /api/v1/integrations/instagram/oauth/callback` olinadi (Railway’da `APP_PUBLIC_URL` web domeniga teng bo‘lishi kerak). Sirlar `railway variable set NOMI --stdin` orqali (qiymat terminal tarixiga/logga tushmaydi) yoki Railway panelidan kiritiladi.

## 5. Siz Meta panelida bajaradigan bosqichlar (ketma-ket)

1. https://developers.facebook.com → developer akkaunt (kompaniya egasining shaxsiy Facebook profili bilan, ikki bosqichli himoya yoqilgan holda).
2. **Create App** → «Other/Business» turi, nom: «NONA Travel CRM». (Business Portfolio kerak bo‘lsa — kompaniyaniki.)
3. Ilova paneli → **Add product → Instagram** → **API setup with Instagram login** (Facebook Login varianti emas).
4. **Roles → Roles / Instagram testers**: NONA Travel Instagram akkauntini qo‘shing (u **professional** va, hujjatga ko‘ra, **public** bo‘lishi kerak). Akkaunt egasi Instagram’da taklifni qabul qiladi (Instagram → Settings → Website permissions → Apps and websites → Tester invites).
5. Shu bo‘limda **Instagram app ID** va **Instagram app secret** ni ko‘ring; ularni Railway’ga `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` sifatida kiriting (menga yubormang).
6. **Set up Instagram business login** → «Business login settings»: yuqoridagi **OAuth Redirect URI**, **Deauthorize callback URL**, **Data deletion request URL** ni kiriting → Save.
7. **Configure webhooks**: Callback URL va Verify token (yuqoridagi jadval) → Save; `messages` (va `messaging_seen`) maydonlariga obuna bo‘ling. Verify token Railway’da sozlanib, backend qayta ishga tushgan bo‘lishi kerak, aks holda tasdiqlash 403 beradi.
8. Railway’da 4-bo‘limdagi o‘zgaruvchilarni kiriting (backend avtomatik qayta ishga tushadi).
9. CRM → **Integratsiyalar** → «Instagram Direct» → **«Instagram akkauntni ulash»**. Instagram oynasi ochiladi: **akkaunt egasi** o‘zi kirib, ikkala ruxsatni beradi. Parol/token CRM’ga yoki chatga kiritilmaydi. Qaytgach «Ulanishlar»da `META_DIRECT … live` va `webhookSubscribed: true` ko‘rinishi kerak.
10. Sinov: boshqa Instagram akkauntdan (ilovada roli bor test akkaunt) NONA akkauntiga Direct yozing → CRM’da kontakt, lid va mas’ul menejer paydo bo‘lishi kerak; ikkinchi xabar yangi lid yaratmasligi kerak.
11. Live rejim va boshqa mijozlar uchun: **App Review** (ikkala ruxsat uchun, screencast va use-case matni bilan) hamda kerak bo‘lsa Business Verification → Advanced Access. Bu bosqichgacha integratsiya **faqat test/ichki** hisoblanadi.

## 6. Oqim va javob yuborish — kodda nima bor

- **Kiruvchi:** Meta → `POST /webhooks/meta` (imzo) → inbox → kontakt (`instagram_scoped`) → lid → navbatdagi mas’ul menejer → `chat.import` (amoCRM Chats’ga). Suhbat `(connection, IGSID)` bo‘yicha yagona; bir xil `mid` qayta kelsa takrorlanmaydi; keyingi xabarlar yangi lid yaratmaydi (sinalgan).
- **Chiquvchi:** menejer javobni **amoCRM chatida** yozadi → amoCRM Chats webhook (`/webhooks/amocrm/chat/{scope}`) → `meta.send` → `graph.instagram.com/<ver>/me/messages`. Natija «accepted» (yetkazildi deb **aytilmaydi**, faqat Meta qabul qilgani). Live ulanish live mijozdan, demo ulanish demo mijozdan yuboradi — aralashmaydi.
- **BLOK (6-band):** CRM’ning o‘zida javob yozish oynasi **yo‘q** — dizayn bo‘yicha javob amoCRM chatidan keladi. Shuning uchun chiquvchi javob uchun **amoCRM akkaunti + OAuth ulanishi (G01/G02) va amoCRM Chats kanali (`AMO_CHAT_CHANNEL_ID`, `AMO_CHAT_SECRET`, G08)** kerak; ular yo‘q. Instagram’ga yuborish kodi mock bilan sinalgan, haqiqiy yuborish sinalmagan. Agar amoCRM keyinga qoldirilsa, CRM ichida javob yozish oynasi qo‘shish alohida vazifa (so‘rasangiz qilaman).
- **Railway demo rejimi:** ilova `APP_MODE=demo` va boshqa adapterlar (amoCRM, Lead Ads, Chats) mock; faqat Instagram Direct ulanishi `live`. DEMO belgisi saqlanadi — bu «real integratsiyalar tayyor» degani emas.

## 6.1. Hujjat bilan tasdiqlangan qoidalar (Meta hujjatlari, 2026-10-25) va ular kodda qanday qo‘llanadi

| Masala | Hujjatdagi aniq matn | Kodda |
| --- | --- | --- |
| Akkauntni webhook’ga obuna qilish | «Set up Instagram Webhooks»: Instagram Login uchun `POST https://graph.instagram.com/v26.0/<INSTAGRAM_ACCOUNT_ID>/subscribed_apps` + `subscribed_fields` + `access_token` (**Instagram User access token**); muvaffaqiyat `{"success": true}`. Unified/Facebook Login variantlari `graph.facebook.com` va boshqa token — ishlatilmaydi. | `subscribeInstagramWebhooks` (`instagram-login.ts`): aynan shu shakl (token query parametrida). Muvaffaqiyatsiz bo‘lsa ulanish `degraded / webhook_subscription_unconfirmed`. |
| Webhook imzosi | «Generate a SHA256 signature using the payload and your app’s **App Secret**», sarlavha `X-Hub-Signature-256: sha256=…`, tekshiruv xom tana ustida. Hujjat alohida «Instagram app secret» ni imzo uchun **tilga olmaydi**. | **Bitta** sir: `META_APP_SECRET`. Mos kelmasa 401, hodisa **saqlanmaydi va qayta ishlanmaydi**. Instagram app secret imzo uchun ishlatilmaydi (faqat OAuth token almashish uchun). |
| OAuth account ID ↔ webhook account ID | Instagram Login «Get started»: `/me` dagi `user_id` = «The Instagram professional account ID, `<IG_ID>`… This ID is value of the `id` field received in webhook notifications for this account». Webhook namunasi: `entry.id` = professional akkaunt ID. | Ulanishning `accountId` = `/me → user_id`. Webhook `entry.id` bilan **aniq** mos kelmasa hodisa saqlanmaydi (`metrics:webhook_unknown_account` hisoblagichi), qayta ishlanmaydi. |
| Tasdiqlash (GET) | `hub.mode=subscribe`, `hub.challenge` (qaytariladi), `hub.verify_token` (App Dashboard’dagi Verify Token bilan mos) | `GET /webhooks/meta` (timing-safe). |

**Ochiq qolgan nuqta (yashirilmaydi):** hujjat «your app’s App Secret» deydi, lekin Instagram Login mahsulotida panelda alohida «Instagram app secret» ham ko‘rinadi va boshqa dasturchilar (rasmiy emas) imzo uning bilan bo‘lganini xabar qilgan. Kod hujjatdagi qoidani qo‘llaydi (`META_APP_SECRET`). Agar haqiqiy sinovda `INVALID_SIGNATURE` (401) chiqsa, **zaxira qabul qilish yoqilmaydi**: `META_APP_SECRET` qiymatini Meta panelidagi to‘g‘ri sirga o‘zgartiring (Settings → Basic → App Secret yoki Instagram bo‘limidagi secret) — qaysi biri ishlaganini birinchi jonli sinov aniqlaydi va shu yerda yozib qo‘yiladi.

**Jonli natija (2026-10-25, tasdiqlangan):** Meta panelidagi «messages → Тестировать» hodisasi **Instagram app secret** (`INSTAGRAM_APP_SECRET`) bilan imzolangan (`META_APP_SECRET` bilan 401, log: `wouldMatchOtherSecret=true`). Shuning uchun kod endi `object: "instagram"` hodisalarini faqat Instagram app secret bilan, Lead Ads (`page`) hodisalarini faqat `META_APP_SECRET` bilan tekshiradi — zaxira qabul qilish yo‘q. `INSTAGRAM_APP_SECRET` sozlanmagan (demo) muhitda `instagram` obyekti `META_APP_SECRET` bilan tekshiriladi. `deauthorize`/`data-deletion` `signed_request` hozircha `META_APP_SECRET` bilan (jonli tasdiqlanmagan).

## 6.2. «Faol/tayyor» faqat haqiqiy sinovdan keyin

Ulanish credential kiritilgach `degraded / awaiting_live_verification` holatida turadi va Integratsiyalar sahifasida «tayyor emas» deb ko‘rsatiladi. **Tayyor (`ok`)** faqat ikkala haqiqiy sinov o‘tgach: (1) imzosi to‘g‘ri va akkaunt ID mos kelgan haqiqiy kiruvchi Direct xabari qayta ishlandi; (2) Meta haqiqiy javob xabarini qabul qildi («accepted»). Javob sinovi amoCRM chatisiz bajarib bo‘lmaydi (6-band BLOK), shuning uchun u hal bo‘lmaguncha ulanish «kiruvchi tasdiqlangan, tayyor emas» bo‘lib qoladi.

## 7. Hali tasdiqlanmagan (birinchi jonli sinovda tekshiriladi)

1. Webhook imzosi aynan `META_APP_SECRET` bilan mos kelishi (6.1 dagi ochiq nuqta). Hujjat endpoint va ID mosligini tasdiqlaydi, lekin ularning haqiqiy akkauntda ishlashi hali ko‘rilmagan.
2. `subscribed_apps` haqiqiy javobi (`success: true`).
3. `enable_fb_login=0` parametri qiymati; `/me` maydonlari (`user_id,username,account_type`).
5. Human Agent tegi, App Review talablari, Meta’ning joriy Graph versiyasi.
6. `/health` va `/ready` backend ichki marshrutlari: Railway’ning ichki healthcheck’i ishlatadi; ommaviy domen orqali ochiq emas (deploy muvaffaqiyatli bo‘lgani bilan tasdiqlangan, to‘g‘ridan-to‘g‘ri so‘rov yuborilmagan).
