-- Pending web change awaiting amoCRM confirmation (ADR 0001).
ALTER TABLE "leads" ADD COLUMN "pending_change" JSONB;
