-- (1) Buyurtmaning turoperatori — tarixiy bog‘lanish; (2) yetkazib beruvchidan qaytgan summalar;
-- (3) foydalanuvchiga qo‘shimcha huquq berish (tannarx/foyda ko‘rish).
-- Expand-only. Mavjud qatorlar o‘zgarmaydi; faqat orders.tour_operator_id lidning HOZIRGI turoperatoridan
-- bir marta nusxalanadi (shu lahzadagi statistika saqlanadi). Demo/sun’iy ma’lumot yaratilmaydi.

-- 1. orders.tour_operator_id: buyurtma yaratilganda lidning turoperatoridan olinadi; keyin lid o‘zgarsa ham saqlanadi.
ALTER TABLE "orders" ADD COLUMN "tour_operator_id" UUID;
UPDATE orders o SET tour_operator_id = l.tour_operator_id
  FROM leads l
  WHERE l.id = o.lead_id AND l.company_id = o.company_id AND l.tour_operator_id IS NOT NULL;
CREATE INDEX "orders_company_id_tour_operator_id_idx" ON "orders"("company_id", "tour_operator_id");
ALTER TABLE orders ADD CONSTRAINT orders_tour_operator_fk FOREIGN KEY (company_id, tour_operator_id) REFERENCES suppliers(company_id, id);

-- 2. Yetkazib beruvchidan qaytgan summalar (mijozga qaytarimlar — mavjud payments.kind = 'refund'; ular alohida).
CREATE TABLE "supplier_refunds" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "service_id" UUID,
  "supplier_id" UUID,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "received_at" TIMESTAMPTZ(3) NOT NULL,
  "reference" TEXT,
  "note" TEXT,
  "business_key" TEXT NOT NULL,
  "recorded_by_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_refunds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_refunds_company_id_business_key_key" ON "supplier_refunds"("company_id", "business_key");
CREATE INDEX "supplier_refunds_company_id_order_id_idx" ON "supplier_refunds"("company_id", "order_id");
ALTER TABLE supplier_refunds ADD CONSTRAINT supplier_refunds_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE supplier_refunds ADD CONSTRAINT supplier_refunds_order_fk FOREIGN KEY (company_id, order_id) REFERENCES orders(company_id, id);
ALTER TABLE supplier_refunds ADD CONSTRAINT supplier_refunds_supplier_fk FOREIGN KEY (company_id, supplier_id) REFERENCES suppliers(company_id, id);
ALTER TABLE supplier_refunds ADD CONSTRAINT supplier_refunds_service_fk FOREIGN KEY (service_id) REFERENCES order_services(id);
ALTER TABLE supplier_refunds ADD CONSTRAINT supplier_refunds_user_fk FOREIGN KEY (company_id, recorded_by_id) REFERENCES users(company_id, id);
ALTER TABLE supplier_refunds ADD CONSTRAINT supplier_refunds_amount_positive CHECK (amount_minor > 0);
-- Pul harakati yozuvlari kabi o‘chirilmaydi (xato bo‘lsa — tuzatuvchi yozuv/audit).
CREATE OR REPLACE FUNCTION supplier_refunds_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'supplier_refunds cannot be deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER supplier_refunds_no_delete BEFORE DELETE ON supplier_refunds FOR EACH ROW EXECUTE FUNCTION supplier_refunds_no_delete();

-- 3. Rolga qo‘shimcha shaxsiy huquqlar (hozircha faqat tannarx va foydani ko‘rish). Standart — bo‘sh.
ALTER TABLE "users" ADD COLUMN "extra_capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE users ADD CONSTRAINT users_extra_capabilities_valid CHECK (extra_capabilities <@ ARRAY['finance.cost.view']::TEXT[]);
