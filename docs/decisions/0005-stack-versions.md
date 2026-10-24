# ADR 0005 — Stack va versiyalar

Sana: 2026-10-24 · Holat: qabul qilingan · TZ: §4.2, §25

## Qaror

npm workspaces (Node 22 LTS bilan birga keladigan npm; pnpm o‘rnatilmagan, qo‘shimcha global tool talab qilinmasin). Versiyalar `package-lock.json` bilan pin qilingan.

| Komponent | Versiya | Izoh |
| --- | --- | --- |
| Node.js | 22 LTS | `.nvmrc`, Docker `node:22.11-alpine` (pinned) |
| TypeScript | 5.9.x | 7.x (native port) chiqqan, lekin ekotizim (typescript-eslint, Nest decorators) bilan moslik tekshirilmagan |
| NestJS | 11.x | 12.x mavjud; 11 bilan tanish va barqaror. Upgrade alohida vazifa |
| Next.js | 15.5.x | 16.x mavjud; App Router 15 da barqaror |
| Prisma | 6.19.x | 7.x driver-adapter modeliga o‘tgan; migratsiya alohida vazifa |
| Zod | 3.25.x | `@asteasolutions/zod-to-openapi` 7.x bilan OpenAPI generatsiyasi |
| BullMQ / ioredis | 5.x / 5.x | |
| Vitest | 3.2.x | Unit va integration |
| Playwright | 1.56.x | E2E |
| PostgreSQL | 16.4 (image pin) | |
| Redis | 7.4.1 (image pin) | |

Eng yangi major’lar emas, balki shu sessiyada ishlatilishi tekshiriladigan barqaror major’lar tanlandi. Ular hozir ham xavfsizlik yangilanishlarini oladigan liniyalar ekanini production’dan oldin qayta tekshirish `KNOWN_LIMITATIONS.md` ga yozilgan.

## Build modeli

- Ichki paketlar TypeScript manbasi sifatida eksport qilinadi (`exports.types` → `src`). Typecheck build talab qilmaydi.
- API va worker production uchun `tsup` (esbuild) bilan bundle qilinadi; Nest DI `emitDecoratorMetadata`ga tayanmaydi — barcha konstruktor parametrlari `@Inject(Token)` bilan aniq yoziladi. Shu sabab dev’da `tsx`, testda Vitest bevosita ishlaydi.
- Web: Next.js `transpilePackages`.
- UI: tashqi komponent kutubxonasi o‘rniga kichik ichki komponentlar to‘plami (`apps/web/src/components`) va oddiy CSS — bog‘liqlik kam, accessibility nazorat ostida.
