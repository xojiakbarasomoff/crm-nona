# syntax=docker/dockerfile:1.7
# Multi-stage build for api, worker and web. Base image is pinned (TZ §4.2).
FROM node:22.11.0-alpine3.20 AS base
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/integrations/package.json packages/integrations/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npx prisma generate --schema packages/database/prisma/schema.prisma \
 && npm run build -w @crm/api -w @crm/worker \
 && NEXT_TELEMETRY_DISABLED=1 npm run build -w @crm/web

FROM base AS runtime-node
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/database/prisma ./packages/database/prisma
USER node

FROM runtime-node AS api
COPY --from=build /app/apps/api/dist ./apps/api/dist
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:4100/health || exit 1
# Migrations run as a separate release step: `npx prisma migrate deploy --schema packages/database/prisma/schema.prisma`
CMD ["node", "apps/api/dist/main.js"]

FROM runtime-node AS worker
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
CMD ["node", "apps/worker/dist/main.js"]

FROM base AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3100
ENV PORT=3100 HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
