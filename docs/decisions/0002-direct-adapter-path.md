# ADR 0002 — Instagram Direct adapter yo‘li

Sana: 2026-10-24 · Holat: **vaqtinchalik** (G05–G08 live dalili kutilmoqda) · TZ: §3.2, §9

## Variantlar

1. Rasmiy tayyor amoCRM Instagram konnektori.
2. O‘z Meta adapterimiz + amoCRM Chats API custom kanali.

## Vaqtinchalik qaror

Kod bazasida **variant 2** uchun adapter interfeyslari va implementatsiya tayyorlanadi, chunki u TZ talab qiladigan provider message ID, scoped sender ID, echo, delivery holati va unknown outbound reconciliation’ni nazorat qilish imkonini beradi. Variant 1 ham `DirectChannelMode = 'native_connector'` sozlamasi orqali qo‘llab-quvvatlanadi: bu rejimda bizning Meta Direct adapterimiz **o‘chiriladi** (bitta Instagram akkauntini ikki konnektor parallel qayta ishlamasligi uchun, TZ §3.2), tizim faqat amoCRM’dan o‘qiydi.

Yakuniy tanlov G08 natijasi bilan qayd etiladi: kanal ro‘yxatdan o‘tkazilmaguncha (amoCRM Chats `channel_id`/`secret` berilmaguncha) Direct integratsiyasi **tayyor deb belgilanmaydi**.

## Autentifikatsiya ajratilishi

| Adapter | Auth mexanizmi | Konfiguratsiya |
| --- | --- | --- |
| `AmoRestClient` | OAuth 2.0 (authorization code, refresh) | `AMO_CLIENT_ID`, `AMO_CLIENT_SECRET`, `AMO_REDIRECT_URI` |
| `AmoChatsClient` | Kanal `secret` bilan so‘rov imzosi (Chats API o‘z formati) | `AMO_CHAT_CHANNEL_ID`, `AMO_CHAT_SECRET` |
| `MetaLeadsClient` | Page access token (Facebook Login) | `META_APP_ID`, `META_APP_SECRET`, connection credentials |
| `MetaDirectClient` | Instagram Login **yoki** Facebook Login — bittasi (`META_DIRECT_LOGIN`) | connection credentials |

Login usullari va permission nomlari aralashtirilmaydi. Lead Ads ruxsati Direct ruxsatidan alohida.

## Ochiq savollar (G-sinovlarda yopiladi)

- amoCRM Chats API imzo algoritmining aniq formati va kanal ro‘yxatdan o‘tkazish (G08) — kod rasmiy hujjat bo‘yicha yozilgan, live tasdiqlanmagan.
- Instagram Login yo‘lida Direct tarixini olish chuqurligi (G09).
- Human Agent tag mavjudligi va App Review holati (G07).
