# syntax=docker/dockerfile:1.7
# Railway: Next.js web. API_INTERNAL_URL build vaqtida rewrite'ga yoziladi (next.config.mjs).
FROM node:22.23.4-alpine3.24
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/integrations/package.json packages/integrations/
RUN npm ci --no-audit --no-fund
COPY . .
ARG API_INTERNAL_URL=http://backend.railway.internal:4100
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build -w @crm/web
RUN cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
 && if [ -d apps/web/public ]; then cp -r apps/web/public apps/web/.next/standalone/apps/web/public; fi
ENV NODE_ENV=production HOSTNAME=0.0.0.0
USER node
WORKDIR /app/apps/web/.next/standalone
EXPOSE 3100
CMD ["node", "apps/web/server.js"]
