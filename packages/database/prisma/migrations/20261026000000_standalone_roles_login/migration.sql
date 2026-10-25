-- Mustaqil CRM: uch rol (ADMIN, MANAGER, USER) va login bilan kirish.
-- HEAD roli olib tashlanadi; mavjud HEAD qatorlari MANAGER'ga o'tkaziladi (tarixiy yozuvlar saqlanadi, o'chirilmaydi).
ALTER TABLE "users" ADD COLUMN "login" TEXT;
CREATE UNIQUE INDEX "users_login_key" ON "users"("login");

-- Tiklash nusxasi: o'zgartirishdan oldingi rollar (bu jadvalga kod tegmaydi).
CREATE TABLE "_backup_users_role_20261026" AS SELECT "id", "email", "role"::text AS "role", "status"::text AS "status", now() AS "taken_at" FROM "users";

CREATE TYPE "Role_new" AS ENUM ('ADMIN', 'MANAGER', 'USER');
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role_new"
  USING (CASE "role"::text WHEN 'HEAD' THEN 'MANAGER' ELSE "role"::text END)::"Role_new";
DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";
