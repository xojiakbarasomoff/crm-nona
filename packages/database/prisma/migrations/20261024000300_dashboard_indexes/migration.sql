-- Indexes for dashboard aggregates (TZ §22.1 performance targets).
CREATE INDEX IF NOT EXISTS leads_company_closed_at_idx ON leads (company_id, closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_company_first_won_at_idx ON leads (company_id, first_won_at) WHERE first_won_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_events_lead_stage_idx ON lead_events (lead_id, new_stage) WHERE new_stage IN ('WON', 'LOST');
CREATE INDEX IF NOT EXISTS conversations_company_first_inbound_idx ON conversations (company_id, first_inbound_at);
CREATE INDEX IF NOT EXISTS conversations_lead_idx ON conversations (lead_id);
CREATE INDEX IF NOT EXISTS payments_company_received_idx ON payments (company_id, received_at);
CREATE INDEX IF NOT EXISTS orders_lead_idx ON orders (lead_id);
CREATE INDEX IF NOT EXISTS orders_company_cancelled_idx ON orders (company_id, cancelled_at) WHERE cancelled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS inquiries_lead_idx ON inquiries (lead_id);
