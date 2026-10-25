-- Qo'lda lid yaratish: kontaktda ism/familiya/Telegram username, lidda izoh.
-- Expand-only: faqat yangi nullable ustunlar; mavjud qatorlar o'zgarmaydi.
ALTER TABLE "contacts" ADD COLUMN "first_name" TEXT, ADD COLUMN "last_name" TEXT, ADD COLUMN "telegram_username" TEXT;
ALTER TABLE "leads" ADD COLUMN "note" TEXT;
