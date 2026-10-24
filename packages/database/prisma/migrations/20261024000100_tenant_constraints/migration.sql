-- Constraints Prisma cannot express (TZ §16.2). Maintained by hand; never drop them in later diffs.

-- 1. Company boundary on every business table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'manager_pools','manager_pool_members','integration_connections','oauth_states','integration_mappings',
    'sync_checkpoints','contacts','contact_identifiers','duplicate_candidates','inquiries','leads','lead_events',
    'conversations','messages','offers','order_sequences','orders','order_services','passengers','flight_segments',
    'segment_passengers','segment_revisions','tickets','ticket_segments','flight_checks','customer_notifications',
    'payments','reminder_rules','reminder_occurrences','notifications','notification_deliveries','crm_tasks',
    'outbox_operations','idempotency_keys','audit_logs','attachments','user_invites'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT', t, t || '_company_fk');
  END LOOP;
END $$;

-- 2. Composite (company_id, x_id) references for relations not modelled in Prisma.
ALTER TABLE contacts ADD CONSTRAINT contacts_owner_fk FOREIGN KEY (company_id, owner_id) REFERENCES users(company_id, id);
ALTER TABLE leads ADD CONSTRAINT leads_contact_fk FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id);
ALTER TABLE leads ADD CONSTRAINT leads_owner_fk FOREIGN KEY (company_id, owner_id) REFERENCES users(company_id, id);
ALTER TABLE lead_events ADD CONSTRAINT lead_events_lead_fk FOREIGN KEY (company_id, lead_id) REFERENCES leads(company_id, id);
ALTER TABLE inquiries ADD CONSTRAINT inquiries_contact_fk FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id);
ALTER TABLE inquiries ADD CONSTRAINT inquiries_lead_fk FOREIGN KEY (company_id, lead_id) REFERENCES leads(company_id, id);
ALTER TABLE conversations ADD CONSTRAINT conversations_contact_fk FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id);
ALTER TABLE conversations ADD CONSTRAINT conversations_lead_fk FOREIGN KEY (company_id, lead_id) REFERENCES leads(company_id, id);
ALTER TABLE conversations ADD CONSTRAINT conversations_connection_fk FOREIGN KEY (company_id, connection_id) REFERENCES integration_connections(company_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_connection_fk FOREIGN KEY (company_id, connection_id) REFERENCES integration_connections(company_id, id);
ALTER TABLE offers ADD CONSTRAINT offers_lead_fk FOREIGN KEY (company_id, lead_id) REFERENCES leads(company_id, id);
ALTER TABLE orders ADD CONSTRAINT orders_contact_fk FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id);
ALTER TABLE orders ADD CONSTRAINT orders_owner_fk FOREIGN KEY (company_id, owner_id) REFERENCES users(company_id, id);
ALTER TABLE orders ADD CONSTRAINT orders_offer_fk FOREIGN KEY (company_id, offer_version_id) REFERENCES offers(company_id, id);
ALTER TABLE flight_segments ADD CONSTRAINT flight_segments_owner_fk FOREIGN KEY (company_id, owner_id) REFERENCES users(company_id, id);
ALTER TABLE segment_revisions ADD CONSTRAINT segment_revisions_segment_fk FOREIGN KEY (company_id, segment_id) REFERENCES flight_segments(company_id, id);
ALTER TABLE customer_notifications ADD CONSTRAINT customer_notifications_segment_fk FOREIGN KEY (company_id, segment_id) REFERENCES flight_segments(company_id, id);
ALTER TABLE reminder_occurrences ADD CONSTRAINT reminder_occurrences_segment_fk FOREIGN KEY (company_id, segment_id) REFERENCES flight_segments(company_id, id);
ALTER TABLE reminder_occurrences ADD CONSTRAINT reminder_occurrences_order_fk FOREIGN KEY (company_id, order_id) REFERENCES orders(company_id, id);
ALTER TABLE reminder_occurrences ADD CONSTRAINT reminder_occurrences_assignee_fk FOREIGN KEY (company_id, assignee_id) REFERENCES users(company_id, id);
ALTER TABLE notifications ADD CONSTRAINT notifications_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users(company_id, id);
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_occurrence_fk FOREIGN KEY (company_id, occurrence_id) REFERENCES reminder_occurrences(company_id, id);
ALTER TABLE manager_pool_members ADD CONSTRAINT manager_pool_members_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users(company_id, id);
ALTER TABLE crm_tasks ADD CONSTRAINT crm_tasks_responsible_fk FOREIGN KEY (company_id, responsible_user_id) REFERENCES users(company_id, id);
ALTER TABLE integration_mappings ADD CONSTRAINT integration_mappings_connection_fk FOREIGN KEY (company_id, connection_id) REFERENCES integration_connections(company_id, id);
ALTER TABLE sync_checkpoints ADD CONSTRAINT sync_checkpoints_connection_fk FOREIGN KEY (company_id, connection_id) REFERENCES integration_connections(company_id, id);
ALTER TABLE flight_checks ADD CONSTRAINT flight_checks_checker_fk FOREIGN KEY (company_id, checked_by_id) REFERENCES users(company_id, id);
ALTER TABLE payments ADD CONSTRAINT payments_recorder_fk FOREIGN KEY (company_id, recorded_by_id) REFERENCES users(company_id, id);
ALTER TABLE user_invites ADD CONSTRAINT user_invites_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users(company_id, id);
ALTER TABLE companies ADD CONSTRAINT companies_duty_user_fk FOREIGN KEY (id, duty_user_id) REFERENCES users(company_id, id) DEFERRABLE INITIALLY DEFERRED;

-- 3. Partial uniques.
-- One scoped Instagram ID maps to at most one active contact (TZ §7.2).
CREATE UNIQUE INDEX contact_identifiers_active_provider_key
  ON contact_identifiers (company_id, type, scope, value)
  WHERE active AND type = 'instagram_scoped';
-- One active order per lead; cancelled history is kept (TZ §12.3).
CREATE UNIQUE INDEX orders_one_active_per_lead
  ON orders (company_id, lead_id)
  WHERE fulfillment_state <> 'cancelled';
-- One current version per reminder rule.
CREATE UNIQUE INDEX reminder_rules_current
  ON reminder_rules (company_id, milestone)
  WHERE current;

-- 4. Money and enumeration checks.
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount_minor > 0);
ALTER TABLE payments ADD CONSTRAINT payments_kind_valid CHECK (kind IN ('payment', 'refund'));
ALTER TABLE payments ADD CONSTRAINT payments_status_valid CHECK (status IN ('confirmed', 'pending', 'voided'));
ALTER TABLE offers ADD CONSTRAINT offers_amount_non_negative CHECK (amount_minor >= 0);
ALTER TABLE orders ADD CONSTRAINT orders_amount_non_negative CHECK (agreed_amount_minor IS NULL OR agreed_amount_minor >= 0);
ALTER TABLE order_services ADD CONSTRAINT order_services_amount_non_negative CHECK (amount_minor IS NULL OR amount_minor >= 0);
ALTER TABLE flight_segments ADD CONSTRAINT flight_segments_segment_no_positive CHECK (segment_no > 0);
ALTER TABLE contact_identifiers ADD CONSTRAINT contact_identifiers_type_valid CHECK (type IN ('instagram_scoped', 'phone', 'email'));
ALTER TABLE flight_checks ADD CONSTRAINT flight_checks_result_valid CHECK (result IN ('confirmed', 'changed', 'cancelled'));

-- 5. Audit log is append-only for everyone, including the application role (TZ §6.1, §21).
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- 6. Financial rows are never deleted (refund or void instead).
CREATE OR REPLACE FUNCTION payments_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payments cannot be deleted; record a refund or void instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION payments_no_delete();
