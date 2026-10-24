# Feasibility (B0) — G01–G09

Oxirgi yangilanish: 2026-10-24 · TZ: §3

## Umumiy holat

**Hech bir G-sinov bajarilmagan.** Ish muhitida amoCRM, Meta yoki amoCRM Chats credential’lari va test akkauntlari mavjud emas (muhit o‘zgaruvchilari va repozitoriy tekshirildi; maxfiy qiymat chiqarilmadi). Shu sababli quyidagi barcha sinovlar ⛔ **blocked** holatida. Demo adapter va contract fixture’lar real integratsiya ishlaganini isbotlamaydi (TZ §23, §28).

Provider hujjatlari (TZ §27 [S01]–[S11]) TZ muallifi tomonidan 2026-10-24 da tekshirilgan. Ushbu sessiyada ular qayta ochilmadi; adapter kodi TZ’dagi talablar va umumiy ma’lum API shakllari asosida yozilgan va **live javob bilan tasdiqlanmagan**. Har bir adapter faylida tegishli manba ID’si ko‘rsatilgan.

## G-sinovlar

| ID | Tekshiruv | Holat | Yetishmayotgan aniq shart | Bog‘liq kod |
| --- | --- | --- | --- | --- |
| G01 | amoCRM domen, account ID, tarif, ruxsat | ⛔ | Test amoCRM akkaunti (`*.amocrm.ru` yoki `*.kommo.com` subdomeni), administrator huquqi, integratsiya yaratish huquqi; tarif nomi | `packages/integrations/src/amocrm/rest-client.ts` |
| G02 | OAuth ulash, yangilash, uzish | ⛔ | Ro‘yxatdan o‘tgan private integratsiya: `client_id`, `client_secret`, HTTPS `redirect_uri` (public URL yoki tunnel) | `packages/integrations/src/amocrm/oauth.ts` |
| G03 | Meta akkaunt va aktivlar | ⛔ | Meta Business Portfolio, Instagram professional akkaunt, unga ulangan Facebook Page, Meta App (app ID/secret), administrator kirishi | — |
| G04 | Lead Ads | ⛔ | G03 + test lead-forma, `leads_retrieval` va Page ruxsatlari, Page `leadgen` webhook obunasi, Lead Ads Testing Tool | `packages/integrations/src/meta/leads-client.ts` |
| G05 | Direct kiruvchi | ⛔ | G03 + tanlangan login yo‘li (Instagram Login: `instagram_business_basic`, `instagram_business_manage_messages`), webhook obunasi, test mijoz akkaunti (app rolida) | `packages/integrations/src/meta/direct-client.ts` |
| G06 | Direct chiquvchi (amoCRM ichidan) | ⛔ | G05 + G08 | `apps/worker/src/handlers/direct-outbound.ts` |
| G07 | Ruxsat, App Review, xabar oynasi | ⛔ | App Review holati, Advanced Access, Business Verification; Human Agent ruxsati mavjudligi | `packages/domain/src/messaging-policy.ts` |
| G08 | amoCRM Chats API kanal | ⛔ | amoCRM’dan kanal ro‘yxatdan o‘tkazilishi (`channel_id`, `secret`), akkauntga kanal ulanishi (`scope_id`) | `packages/integrations/src/amocrm/chats-client.ts` |
| G09 | Tarix va atributsiya | ⛔ | G04, G05 bajarilishi; real javobda `ad_id`, `campaign_id`, referral, media va tarix chuqurligi | — |

## Har bir sinov uchun yoziladigan shakl

Credential paydo bo‘lganda har G-sinov uchun quyidagi bo‘lim qo‘shiladi (tokenlar va PII redakt qilinadi):

```
### Gxx — <nom>
- Vaqt (UTC):
- Akkaunt / muhit: test | staging
- Ssenariy:
- So‘rov (redakt):
- Javob (redakt):
- Cheklov:
- Qaror:
- Fixture: tests/fixtures/<provider>/<file>.json
```

## Live smoke testni ishga tushirish

```
cp .env.example .env.staging   # haqiqiy qiymatlar, git’ga qo‘shilmaydi
npm run smoke:live -- --only=G01,G02
```

Credential bo‘lmasa skript har bir sinovni `blocked` deb chiqaradi va nol bo‘lmagan exit code qaytarmaydi, lekin hech qachon `passed` demaydi.

## Mustaqil davom etadigan ishlar

B1 (asos), B4 (turizm), B5 (eslatmalar), B6 KPI formulalari, B2/B3 ning inbox/outbox, dedupe, taqsimlash, imzo tekshiruvi va contract fixture qismlari — demo adapter bilan. Demo rejim UI’da katta `DEMO` belgisi bilan ko‘rsatiladi, production’da mock adapter bilan ishga tushish rad etiladi.
