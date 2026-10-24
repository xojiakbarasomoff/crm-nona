-- SLA tracking, retention purge markers, attachment scanning and PII tombstones (expand-only).
ALTER TABLE "leads" ADD COLUMN "sla_breached_at" TIMESTAMPTZ(3), ADD COLUMN "pii_erased_at" TIMESTAMPTZ(3);
CREATE INDEX leads_sla_open_idx ON leads (company_id, first_response_due_at) WHERE first_human_action_at IS NULL AND sla_breached_at IS NULL AND deleted_at IS NULL;
ALTER TABLE "contacts" ADD COLUMN "pii_erased_at" TIMESTAMPTZ(3);
ALTER TABLE "messages" ADD COLUMN "content_purged_at" TIMESTAMPTZ(3);
ALTER TABLE "attachments" ADD COLUMN "scan_detail" TEXT, ADD COLUMN "scanned_at" TIMESTAMPTZ(3), ADD COLUMN "sha256" TEXT NOT NULL DEFAULT '', ADD COLUMN "deleted_at" TIMESTAMPTZ(3);
ALTER TABLE "attachments" ALTER COLUMN "sha256" DROP DEFAULT;
ALTER TABLE attachments ADD CONSTRAINT attachments_size_positive CHECK (size > 0);
ALTER TABLE attachments ADD CONSTRAINT attachments_scan_state_valid CHECK (scan_state IN ('pending', 'clean', 'infected', 'error'));
CREATE INDEX attachments_scan_pending_idx ON attachments (scan_state, created_at) WHERE scan_state = 'pending';
ALTER TABLE attachments ADD CONSTRAINT attachments_uploader_fk FOREIGN KEY (company_id, uploaded_by_id) REFERENCES users(company_id, id);

CREATE TABLE "pii_tombstones" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "amo_contact_id" TEXT,
  "identifier_hashes" TEXT[],
  "reason" TEXT NOT NULL,
  "erased_by_id" UUID NOT NULL,
  "provider_review_required" BOOLEAN NOT NULL DEFAULT true,
  "erased_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pii_tombstones_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pii_tombstones_company_id_contact_id_key" ON "pii_tombstones"("company_id", "contact_id");
ALTER TABLE pii_tombstones ADD CONSTRAINT pii_tombstones_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
