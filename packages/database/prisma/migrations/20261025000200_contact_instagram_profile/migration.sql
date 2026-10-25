-- Instagram mijoz profili (User Profile API): username/name kontaktda alohida maydon sifatida.
-- Expand-only: faqat yangi nullable/defaultli ustunlar; mavjud qatorlar va ma'lumot o'zgarmaydi.
ALTER TABLE "contacts"
  ADD COLUMN "instagram_username" TEXT,
  ADD COLUMN "instagram_name" TEXT,
  ADD COLUMN "instagram_profile_fetched_at" TIMESTAMPTZ(3),
  ADD COLUMN "instagram_profile_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "instagram_profile_next_attempt_at" TIMESTAMPTZ(3),
  ADD COLUMN "instagram_profile_error" TEXT;
