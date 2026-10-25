-- Soddalashtirilgan ish jarayoni: faqat qo'shimcha o'zgarishlar (mavjud satrlar o'zgartirilmaydi).
-- «Нет ответа» statusi Stage'ga qo'shiladi; eski bosqichlar o'z joyida qoladi va interfeysda «В работе» bo'lib ko'rinadi.
ALTER TYPE "Stage" ADD VALUE IF NOT EXISTS 'NO_ANSWER';

CREATE TYPE "LeadType" AS ENUM ('NEW', 'REFERRAL', 'REPEAT');
ALTER TABLE "leads" ADD COLUMN "lead_type" "LeadType" NOT NULL DEFAULT 'NEW';

-- «Продажа» bloki: mavjud buyurtma (orders) qatoriga ixcham maydonlar.
ALTER TABLE "orders" ADD COLUMN "sale_service_type" TEXT;
ALTER TABLE "orders" ADD COLUMN "sold_what" TEXT;
ALTER TABLE "orders" ADD COLUMN "departure_at" TIMESTAMPTZ(3);
ALTER TABLE "orders" ADD COLUMN "departure_note" TEXT;
ALTER TABLE "orders" ADD COLUMN "remind_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "remind_at" TIMESTAMPTZ(3);
ALTER TABLE "orders" ADD COLUMN "remind_timezone" TEXT;
CREATE INDEX "orders_company_id_departure_at_idx" ON "orders"("company_id", "departure_at");
