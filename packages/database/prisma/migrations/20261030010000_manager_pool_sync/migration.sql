-- Faol menejerlar asosiy navbatga (default pool) qo'shiladi: ilgari `accounts:provision` orqali yaratilgan haqiqiy
-- menejer navbatga kirmagan, shu sabab round-robin hech kimni topmay barcha yangi lidlar dyejurniyga ketgan.
-- Mavjud lidlar, ularning mas'uli va tarixiy navbat qatorlari o'zgartirilmaydi.
INSERT INTO "manager_pools" ("id", "company_id", "name", "is_default", "updated_at")
SELECT gen_random_uuid(), c."id", 'Asosiy navbat', true, CURRENT_TIMESTAMP
FROM "companies" c
WHERE NOT EXISTS (SELECT 1 FROM "manager_pools" p WHERE p."company_id" = c."id" AND p."is_default")
  AND EXISTS (SELECT 1 FROM "users" u WHERE u."company_id" = c."id" AND u."role" = 'MANAGER' AND u."status" = 'active');

INSERT INTO "manager_pool_members" ("id", "company_id", "pool_id", "user_id", "position", "available", "updated_at")
SELECT gen_random_uuid(), u."company_id", p."id", u."id",
       (SELECT coalesce(max(m."position"), -1) FROM "manager_pool_members" m WHERE m."pool_id" = p."id")
         + row_number() OVER (PARTITION BY p."id" ORDER BY u."created_at", u."id"),
       true, CURRENT_TIMESTAMP
FROM "users" u
JOIN LATERAL (
    SELECT p."id" FROM "manager_pools" p WHERE p."company_id" = u."company_id" AND p."is_default" ORDER BY p."created_at" LIMIT 1
) p ON true
WHERE u."role" = 'MANAGER' AND u."status" = 'active'
  AND NOT EXISTS (SELECT 1 FROM "manager_pool_members" m WHERE m."pool_id" = p."id" AND m."user_id" = u."id");

-- Navbatda bor-u, lekin `available=false` bo'lib qolgan faol menejer qayta faollashtiriladi.
UPDATE "manager_pool_members" m SET "available" = true, "updated_at" = CURRENT_TIMESTAMP
FROM "users" u
WHERE u."id" = m."user_id" AND u."role" = 'MANAGER' AND u."status" = 'active' AND NOT m."available";
