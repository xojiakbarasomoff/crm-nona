# ADR 0005 — Stack va versiyalar

Sana: 2026-10-24 (qayta ko‘rib chiqildi shu kuni, dependency audit’dan keyin) · Holat: qabul qilingan · TZ: §4.2, §25

## Qaror

npm workspaces; barcha to‘g‘ridan-to‘g‘ri versiyalar `package.json` da aniq pin qilingan, tranzitiv versiyalar `package-lock.json` da.

| Komponent | Versiya | Qo‘llab-quvvatlash holati (2026-10-24) |
| --- | --- | --- |
| Node.js | **22.23.4** (`.nvmrc`, Docker `node:22.23.4-alpine3.24`) | 22 — maintenance LTS, 2027-04-30 gacha. 22.11.0 dan keyin 9 ta xavfsizlik relizi chiqqan edi — yangilandi. Minimal: 22.12 (Prisma 7 talabi) |
| TypeScript | 5.9.x | typescript-eslint 8.72 `<6.1` ni qo‘llaydi; TS 7 (native) ekotizim tayyor bo‘lgach |
| NestJS | 11.2.8 | 2026-10-23 da patch chiqqan — qo‘llab-quvvatlanmoqda. 12.x ga o‘tish alohida vazifa |
| Next.js | 15.5.28 | 2026-10-14 da patch — qo‘llab-quvvatlanmoqda. 16.x ga o‘tish alohida vazifa |
| React | 19.3.1 | Prisma 7 CLI ham 19.3 olib keladi; bitta nusxa bo‘lishi uchun moslashtirilgan |
| Prisma | **7.10.1** + `@prisma/adapter-pg` | 6.19.3 2026-04 dan beri patch olmagan edi — 7 ga o‘tildi (generator `prisma-client`, `prisma.config.ts`, pg driver adapter) |
| Zod | **4.6.7** (+ zod-to-openapi 9.1) | 3.x da xotira tugashi zaifligi (`<4.6.6`) — yangilandi |
| Vitest | **4.1.12** | 3.x/tinypool critical RCE (dev) — yangilandi |
| ESLint | **10.13.0** | 9.x rasman EOL — yangilandi |
| BullMQ / ioredis | 5.x / 5.x | — |
| Playwright | 1.56.x | — |
| PostgreSQL / Redis | 16.4 / 7.4.1 (image pin) | — |

`overrides` (tranzitiv, tekshirilgan): `multer 2.5.0` (Nest platform-express ichida, DoS), `postcss 8.5.31` (Next ichida, XSS/file read), `esbuild 0.28.2` (faqat tsup ichida), `vite 6.4.5` (vitest uchun; vite 8 ning ixtiyoriy peer zanjiri npm arborist’ni qulatadi).

Natija: `npm audit` — **0 zaiflik**; unit 75, integration 81, E2E 6 — Node 22.23.4 + Prisma 7 bilan o‘tdi.

## Prisma 7 ga o‘tishning oqibatlari

- Rust query engine yo‘q: so‘rovlar `pg` orqali, so‘rov rejasi va natijani map qilish Node process’ida. `DB_POOL_MAX` (default 25).
- `$queryRaw` `void` turidagi ustunni o‘qiy olmaydi — bunday funksiyalar (`pg_advisory_xact_lock`) `$executeRaw` bilan chaqiriladi.
- Generatsiya qilingan client `packages/database/src/generated` (git’da emas): `npm run db:generate` majburiy.
- `include` alohida so‘rov sifatida bajariladi; yuklama ostidagi ro‘yxat (`/flights`) bitta SQL join’ga o‘tkazildi.

## Build modeli

- Ichki paketlar TypeScript manbasi sifatida eksport qilinadi; typecheck build talab qilmaydi.
- API va worker `tsup` bilan bundle qilinadi; Nest DI `@Inject(Token)` bilan (decorator metadata’siz).
- Web: Next.js `transpilePackages`; UI — kichik ichki komponentlar to‘plami.
