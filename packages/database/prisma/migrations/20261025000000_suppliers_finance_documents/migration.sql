-- Turoperatorlar / yetkazib beruvchilar, tannarx (net price), xizmat qatorlari va hujjat kategoriyalari.
-- Expand-only: mavjud jadval va qatorlar o‘zgarmaydi, faqat yangi jadval/ustunlar qo‘shiladi. Eski buyurtmalarda
-- tannarx NULL (noma’lum) bo‘lib qoladi — hech qachon 0 deb to‘ldirilmaydi.
-- Yangi CHECK cheklovlar NOT VALID: faqat yangi/o‘zgargan qatorlarga qo‘llanadi (eski ma’lumot tekshirilmaydi).

-- 1. Yetkazib beruvchilar ma’lumotnomasi (turoperator, mehmonxona, transfer, avia agent, boshqa).
CREATE TABLE "suppliers" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'tour_operator',
  "contact_person" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "suppliers_company_id_id_key" ON "suppliers"("company_id", "id");
CREATE INDEX "suppliers_company_id_status_kind_idx" ON "suppliers"("company_id", "status", "kind");
-- Nomi kompaniya ichida katta-kichik harfga qaramay noyob (Prisma ifodali indeksni ifodalay olmaydi).
CREATE UNIQUE INDEX suppliers_company_name_ci_key ON suppliers (company_id, lower(name));
ALTER TABLE suppliers ADD CONSTRAINT suppliers_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE suppliers ADD CONSTRAINT suppliers_kind_valid CHECK (kind IN ('tour_operator', 'hotel', 'transfer', 'airline', 'other'));
ALTER TABLE suppliers ADD CONSTRAINT suppliers_status_valid CHECK (status IN ('active', 'archived'));

-- 2. Lid: tanlangan turoperator (reklama manbasi — leads.first_source — bilan aralashmaydi).
ALTER TABLE "leads" ADD COLUMN "tour_operator_id" UUID;
CREATE INDEX "leads_company_id_tour_operator_id_idx" ON "leads"("company_id", "tour_operator_id");
ALTER TABLE leads ADD CONSTRAINT leads_tour_operator_fk FOREIGN KEY (company_id, tour_operator_id) REFERENCES suppliers(company_id, id);

-- 3. Buyurtma: paket darajasidagi tannarx (sotuv narxi — agreed_amount_minor — mavjud ustun).
ALTER TABLE "orders" ADD COLUMN "net_price_minor" BIGINT;
ALTER TABLE orders ADD CONSTRAINT orders_net_price_nonneg CHECK (net_price_minor IS NULL OR net_price_minor >= 0) NOT VALID;
ALTER TABLE orders ADD CONSTRAINT orders_net_price_has_currency CHECK (net_price_minor IS NULL OR currency IS NOT NULL) NOT VALID;

-- 4. Xizmat qatorlari: tannarx, yetkazib beruvchi, paketga kiritilganligi, tafsilotlar (mehmonxona/transfer), soft-delete.
ALTER TABLE "order_services"
  ADD COLUMN "net_minor" BIGINT,
  ADD COLUMN "supplier_id" UUID,
  ADD COLUMN "included_in_package" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "details" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "removed_at" TIMESTAMPTZ(3),
  ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "order_services_company_id_order_id_idx" ON "order_services"("company_id", "order_id");
ALTER TABLE order_services ADD CONSTRAINT order_services_supplier_fk FOREIGN KEY (company_id, supplier_id) REFERENCES suppliers(company_id, id);
ALTER TABLE order_services ADD CONSTRAINT order_services_amount_nonneg CHECK (amount_minor IS NULL OR amount_minor >= 0) NOT VALID;
ALTER TABLE order_services ADD CONSTRAINT order_services_net_nonneg CHECK (net_minor IS NULL OR net_minor >= 0) NOT VALID;
ALTER TABLE order_services ADD CONSTRAINT order_services_money_has_currency CHECK ((amount_minor IS NULL AND net_minor IS NULL) OR currency IS NOT NULL) NOT VALID;

-- 5. Hujjat kategoriyalari.
ALTER TABLE "attachments" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'other';
ALTER TABLE attachments ADD CONSTRAINT attachments_category_valid CHECK (category IN ('passport', 'invoice', 'payment_receipt', 'air_ticket', 'voucher', 'other'));
CREATE INDEX "attachments_company_id_owner_type_category_idx" ON "attachments"("company_id", "owner_type", "category");
