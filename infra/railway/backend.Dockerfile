# syntax=docker/dockerfile:1.7
# Railway: API + worker bitta konteynerda (demo rejim).
# Sabab: lokal fayl saqlash API va worker o‘rtasida umumiy disk talab qiladi (skan worker'da).
# Bu fayl infra/Dockerfile ni o‘zgartirmaydi; u — haqiqiy deploy uchun asosiy manba.
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
RUN npx prisma generate && npm run build -w @crm/api -w @crm/worker
ENV NODE_ENV=production STORAGE_LOCAL_DIR=/tmp/storage
RUN chmod +x infra/railway/backend-start.sh && mkdir -p /tmp/storage && chown -R node:node /app /tmp/storage
USER node
EXPOSE 4100
CMD ["sh", "infra/railway/backend-start.sh"]
