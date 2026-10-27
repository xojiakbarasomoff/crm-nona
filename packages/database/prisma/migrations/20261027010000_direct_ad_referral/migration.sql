-- Instagram Direct reklama dalili: faqat qo'shimcha o'zgarishlar, mavjud manba (first_source) va tarix o'zgartirilmaydi.
ALTER TABLE "leads" ADD COLUMN "ad_referral_at" TIMESTAMPTZ(3);
ALTER TABLE "leads" ADD COLUMN "ad_referral" JSONB;
CREATE INDEX "leads_company_id_ad_referral_at_idx" ON "leads"("company_id", "ad_referral_at");

CREATE TABLE "ig_ad_referrals" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "scoped_peer_id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "ad_id" TEXT,
    "referral" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "lead_id" UUID,
    "applied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ig_ad_referrals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ig_ad_referrals_connection_id_event_key_key" ON "ig_ad_referrals"("connection_id", "event_key");
CREATE INDEX "ig_ad_referrals_connection_id_scoped_peer_id_idx" ON "ig_ad_referrals"("connection_id", "scoped_peer_id");

-- Faqat allaqachon saqlangan haqiqiy dalil bo'yicha: Direct murojaatida Meta referral source=ADS yoki ad_id bo'lsa.
-- Dalilsiz lidlar «Таргет» yoki «Органика» deb belgilanmaydi.
UPDATE "leads" l
SET "ad_referral_at" = e."received_at", "ad_referral" = e."referral"
FROM (
    SELECT DISTINCT ON (i."lead_id") i."lead_id", i."received_at", i."attribution" -> 'referral' AS "referral"
    FROM "inquiries" i
    WHERE i."channel" = 'instagram_direct'
      AND i."lead_id" IS NOT NULL
      AND (upper(i."attribution" -> 'referral' ->> 'source') = 'ADS' OR coalesce(i."attribution" -> 'referral' ->> 'adId', '') <> '')
    ORDER BY i."lead_id", i."received_at" ASC
) e
WHERE l."id" = e."lead_id" AND l."ad_referral_at" IS NULL;
