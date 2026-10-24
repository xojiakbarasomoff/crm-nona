-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'HEAD', 'MANAGER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'active', 'blocked');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'PREPARING_OFFER', 'OFFER_SENT', 'AWAITING_PAYMENT', 'WON', 'LOST', 'FOLLOW_UP');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('instagram_lead_ads', 'meta_lead_ads', 'instagram_direct', 'amocrm', 'manual', 'other');

-- CreateEnum
CREATE TYPE "SyncState" AS ENUM ('synced', 'pending', 'pending_create', 'conflict', 'failed', 'unknown', 'local_only');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('AMOCRM_REST', 'AMOCRM_CHATS', 'META_LEADS', 'META_DIRECT');

-- CreateEnum
CREATE TYPE "ConnectionMode" AS ENUM ('demo', 'live');

-- CreateEnum
CREATE TYPE "ConnectionHealth" AS ENUM ('ok', 'degraded', 'paused', 'disconnected');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('unpaid', 'partial', 'paid', 'refund_pending', 'refunded');

-- CreateEnum
CREATE TYPE "TicketingState" AS ENUM ('not_required', 'pending', 'reserved', 'issued', 'voided');

-- CreateEnum
CREATE TYPE "FulfillmentState" AS ENUM ('draft', 'confirmed', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "MessageState" AS ENUM ('received', 'queued', 'sending', 'accepted', 'delivered', 'read', 'failed', 'unknown');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('customer', 'human', 'bot', 'system');

-- CreateEnum
CREATE TYPE "OperationalStatus" AS ENUM ('scheduled', 'schedule_changed', 'cancelled', 'departed');

-- CreateEnum
CREATE TYPE "CheckState" AS ENUM ('pending', 'due', 'in_progress', 'checked', 'recheck_required');

-- CreateEnum
CREATE TYPE "NotificationState" AS ENUM ('not_required', 'required', 'notified');

-- CreateEnum
CREATE TYPE "OccurrenceKind" AS ENUM ('milestone', 'manual');

-- CreateEnum
CREATE TYPE "OccurrenceState" AS ENUM ('scheduled', 'dispatching', 'due', 'completed', 'snoozed', 'cancelled', 'superseded', 'missed');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('pending', 'sent', 'failed', 'cancelled', 'completed');

-- CreateEnum
CREATE TYPE "InboxState" AS ENUM ('pending', 'processing', 'done', 'failed', 'dead', 'ignored');

-- CreateEnum
CREATE TYPE "OutboxState" AS ENUM ('pending', 'processing', 'done', 'failed', 'dead', 'unknown', 'paused', 'cancelled');

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tashkent',
    "work_schedule" JSONB NOT NULL,
    "sla_first_response_minutes" INTEGER NOT NULL DEFAULT 15,
    "sticky_owner" BOOLEAN NOT NULL DEFAULT true,
    "phone_rule" JSONB,
    "order_prefix" TEXT NOT NULL DEFAULT 'TR',
    "duty_user_id" UUID,
    "data_collection_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'invited',
    "amo_user_id" TEXT,
    "mfa_secret_enc" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMPTZ(3),
    "blocked_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invites" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_pools" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'rr-equal-v1',
    "pointer" INTEGER NOT NULL DEFAULT -1,
    "service_type" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "manager_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_pool_members" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "schedule" JSONB,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "service_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "manager_pool_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "mode" "ConnectionMode" NOT NULL,
    "account_id" TEXT NOT NULL,
    "account_domain" TEXT,
    "route_token" TEXT NOT NULL,
    "credentials_enc" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "health" "ConnectionHealth" NOT NULL DEFAULT 'ok',
    "health_reason" TEXT,
    "last_webhook_at" TIMESTAMPTZ(3),
    "last_sync_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "disconnected_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "state_hash" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_mappings" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "connection_id" UUID,
    "entity_type" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "sync_state" "SyncState" NOT NULL DEFAULT 'synced',
    "state_hash" TEXT,
    "source_updated_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_checkpoints" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "stream" TEXT NOT NULL,
    "cursor" JSONB NOT NULL,
    "last_run_at" TIMESTAMPTZ(3),
    "last_result" JSONB,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "amo_contact_id" TEXT,
    "full_name" TEXT,
    "primary_phone" TEXT,
    "primary_email" TEXT,
    "owner_id" UUID,
    "sync_state" "SyncState" NOT NULL DEFAULT 'pending_create',
    "source_updated_at" TIMESTAMPTZ(3),
    "state_hash" TEXT,
    "merged_into_id" UUID,
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_identifiers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "original_value" TEXT,
    "scope" TEXT NOT NULL DEFAULT '',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "display_username" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contact_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_candidates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "contact_ids" TEXT[],
    "reason" TEXT NOT NULL,
    "identifier" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "flagged_by_id" UUID,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "duplicate_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiries" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "provider_event_key" TEXT NOT NULL,
    "contact_id" UUID,
    "lead_id" UUID,
    "channel" "Channel" NOT NULL,
    "placement" TEXT NOT NULL DEFAULT 'unknown',
    "source_created_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "processed_at" TIMESTAMPTZ(3),
    "attribution" JSONB NOT NULL DEFAULT '{}',
    "form_data" JSONB,
    "null_reasons" JSONB NOT NULL DEFAULT '{}',
    "enrichment_state" TEXT NOT NULL DEFAULT 'not_needed',
    "enrichment_error" TEXT,
    "mapping_version" INTEGER,
    "correlation_id" TEXT NOT NULL,
    "processing_state" TEXT NOT NULL DEFAULT 'received',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "amo_lead_id" TEXT,
    "contact_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "stage" "Stage" NOT NULL DEFAULT 'NEW',
    "return_stage" "Stage",
    "owner_id" UUID,
    "assignment_reason" TEXT,
    "service_type" TEXT,
    "requirements" JSONB NOT NULL DEFAULT '{}',
    "first_source" "Channel" NOT NULL,
    "first_placement" TEXT NOT NULL DEFAULT 'unknown',
    "first_inquiry_id" UUID,
    "contact_outcome" TEXT,
    "offer_prep_due_at" TIMESTAMPTZ(3),
    "lost_reason_code" TEXT,
    "lost_note" TEXT,
    "next_contact_at" TIMESTAMPTZ(3),
    "follow_up_note" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "first_won_at" TIMESTAMPTZ(3),
    "first_response_due_at" TIMESTAMPTZ(3),
    "first_human_action_at" TIMESTAMPTZ(3),
    "anomaly" JSONB,
    "sync_state" "SyncState" NOT NULL DEFAULT 'pending_create',
    "source_updated_at" TIMESTAMPTZ(3),
    "state_hash" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_events" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "old_stage" "Stage",
    "new_stage" "Stage",
    "old_owner_id" UUID,
    "new_owner_id" UUID,
    "reason" TEXT,
    "origin" TEXT NOT NULL,
    "operation_id" TEXT,
    "algorithm_version" TEXT,
    "actor_id" UUID,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "business_account_id" TEXT NOT NULL,
    "scoped_peer_id" TEXT NOT NULL,
    "peer_username" TEXT,
    "contact_id" UUID NOT NULL,
    "lead_id" UUID,
    "amo_chat_id" TEXT,
    "last_inbound_at" TIMESTAMPTZ(3),
    "last_human_reply_at" TIMESTAMPTZ(3),
    "first_inbound_at" TIMESTAMPTZ(3),
    "first_human_reply_at" TIMESTAMPTZ(3),
    "history_available_from" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider_message_id" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "state" "MessageState" NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "is_echo" BOOLEAN NOT NULL DEFAULT false,
    "is_internal_note" BOOLEAN NOT NULL DEFAULT false,
    "operation_id" TEXT,
    "amo_message_id" TEXT,
    "error" TEXT,
    "provider_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "offer_no" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "included_services" JSONB NOT NULL DEFAULT '[]',
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "valid_until" TIMESTAMPTZ(3),
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "sent_channel" TEXT,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_sequences" (
    "company_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_sequences_pkey" PRIMARY KEY ("company_id","year")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "order_no" TEXT NOT NULL,
    "lead_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "owner_id" UUID,
    "agreed_amount_minor" BIGINT,
    "currency" CHAR(3),
    "offer_version_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "sale_evidence" TEXT,
    "payment_state" "PaymentState" NOT NULL DEFAULT 'unpaid',
    "ticketing_state" "TicketingState" NOT NULL DEFAULT 'pending',
    "fulfillment_state" "FulfillmentState" NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "amo_summary_state" "SyncState" NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_services" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "service_type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount_minor" BIGINT,
    "currency" CHAR(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passengers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'adult',
    "birth_date" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "passengers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flight_segments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "segment_no" INTEGER NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "origin_iata" CHAR(3) NOT NULL,
    "destination_iata" CHAR(3) NOT NULL,
    "origin_airport_name" TEXT,
    "destination_airport_name" TEXT,
    "marketing_carrier" TEXT NOT NULL,
    "operating_carrier" TEXT,
    "flight_number" TEXT NOT NULL,
    "departure_at_utc" TIMESTAMPTZ(3),
    "departure_timezone" TEXT NOT NULL,
    "departure_local_original" TEXT,
    "arrival_at_utc" TIMESTAMPTZ(3),
    "arrival_timezone" TEXT NOT NULL,
    "arrival_local_original" TEXT,
    "pnr" TEXT,
    "booking_provider" TEXT,
    "operational_status" "OperationalStatus" NOT NULL DEFAULT 'scheduled',
    "schedule_revision" INTEGER NOT NULL DEFAULT 1,
    "check_state" "CheckState" NOT NULL DEFAULT 'pending',
    "notification_state" "NotificationState" NOT NULL DEFAULT 'not_required',
    "last_checked_at" TIMESTAMPTZ(3),
    "checked_by_id" UUID,
    "next_reminder_at" TIMESTAMPTZ(3),
    "evidence_source" TEXT,
    "owner_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "flight_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segment_passengers" (
    "company_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,

    CONSTRAINT "segment_passengers_pkey" PRIMARY KEY ("segment_id","passenger_id")
);

-- CreateTable
CREATE TABLE "segment_revisions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "changed_by_id" UUID,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "segment_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "passenger_id" UUID NOT NULL,
    "ticket_number" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_segments" (
    "company_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,

    CONSTRAINT "ticket_segments_pkey" PRIMARY KEY ("ticket_id","segment_id")
);

-- CreateTable
CREATE TABLE "flight_checks" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "schedule_revision" INTEGER NOT NULL,
    "milestone" TEXT,
    "occurrence_id" UUID,
    "result" TEXT NOT NULL,
    "observed_departure_at_utc" TIMESTAMPTZ(3),
    "terminal" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "change" JSONB,
    "note" TEXT,
    "customer_notification_needed" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(3),
    "checked_at" TIMESTAMPTZ(3) NOT NULL,
    "checked_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flight_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_notifications" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "note" TEXT,
    "author_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "method" TEXT NOT NULL,
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "reference" TEXT,
    "business_key" TEXT NOT NULL,
    "recorded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_rules" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "milestone" TEXT NOT NULL,
    "offset_seconds" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL,
    "current" BOOLEAN NOT NULL DEFAULT true,
    "escalate_after_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_occurrences" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" "OccurrenceKind" NOT NULL,
    "order_id" UUID,
    "segment_id" UUID,
    "schedule_revision" INTEGER,
    "rule_version" INTEGER,
    "milestone" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "state" "OccurrenceState" NOT NULL DEFAULT 'scheduled',
    "assignee_id" UUID,
    "created_by_id" UUID,
    "lease_until" TIMESTAMPTZ(3),
    "lease_owner" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "escalate_after_minutes" INTEGER,
    "escalated_at" TIMESTAMPTZ(3),
    "dispatched_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "flight_check_id" UUID,
    "result_note" TEXT,
    "missed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "series_id" UUID,
    "series_index" INTEGER,
    "recurrence" JSONB,
    "local_start" TEXT,
    "timezone" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reminder_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "occurrence_id" UUID,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "occurrence_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "state" "DeliveryState" NOT NULL DEFAULT 'pending',
    "external_task_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_tasks" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "automation_key" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "responsible_user_id" UUID,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "amo_task_id" TEXT,
    "closed_by_crm_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crm_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_inbox" (
    "id" UUID NOT NULL,
    "company_id" UUID,
    "provider" TEXT NOT NULL,
    "connection_key" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_enc" TEXT NOT NULL,
    "state" "InboxState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "correlation_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "lease_until" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_operations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "operation_key" TEXT NOT NULL,
    "connection_id" UUID,
    "target" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" "OutboxState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(3),
    "first_attempt_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "error_class" TEXT,
    "result" JSONB,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "correlation_id" TEXT NOT NULL,
    "request_id" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "scan_state" TEXT NOT NULL DEFAULT 'pending',
    "retention_until" TIMESTAMPTZ(3),
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "name" TEXT NOT NULL,
    "last_beat_at" TIMESTAMPTZ(3) NOT NULL,
    "info" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_company_id_id_key" ON "users"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "users_company_id_amo_user_id_key" ON "users"("company_id", "amo_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_invites_token_hash_key" ON "user_invites"("token_hash");

-- CreateIndex
CREATE INDEX "user_invites_company_id_user_id_idx" ON "user_invites"("company_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "manager_pools_company_id_id_key" ON "manager_pools"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "manager_pool_members_pool_id_user_id_key" ON "manager_pool_members"("pool_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "manager_pool_members_pool_id_position_key" ON "manager_pool_members"("pool_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_route_token_key" ON "integration_connections"("route_token");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_company_id_id_key" ON "integration_connections"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_company_id_provider_account_id_key" ON "integration_connections"("company_id", "provider", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_hash_key" ON "oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "integration_mappings_company_id_entity_type_local_id_idx" ON "integration_mappings"("company_id", "entity_type", "local_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_mappings_company_id_entity_type_external_id_key" ON "integration_mappings"("company_id", "entity_type", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_checkpoints_connection_id_stream_key" ON "sync_checkpoints"("connection_id", "stream");

-- CreateIndex
CREATE INDEX "contacts_company_id_owner_id_idx" ON "contacts"("company_id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_company_id_id_key" ON "contacts"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_company_id_amo_contact_id_key" ON "contacts"("company_id", "amo_contact_id");

-- CreateIndex
CREATE INDEX "contact_identifiers_company_id_type_scope_value_idx" ON "contact_identifiers"("company_id", "type", "scope", "value");

-- CreateIndex
CREATE INDEX "duplicate_candidates_company_id_state_idx" ON "duplicate_candidates"("company_id", "state");

-- CreateIndex
CREATE INDEX "inquiries_company_id_received_at_idx" ON "inquiries"("company_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "inquiries_company_id_provider_event_key_key" ON "inquiries"("company_id", "provider_event_key");

-- CreateIndex
CREATE INDEX "leads_company_id_owner_id_stage_idx" ON "leads"("company_id", "owner_id", "stage");

-- CreateIndex
CREATE INDEX "leads_company_id_contact_id_idx" ON "leads"("company_id", "contact_id");

-- CreateIndex
CREATE INDEX "leads_company_id_created_at_idx" ON "leads"("company_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "leads_company_id_id_key" ON "leads"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_company_id_amo_lead_id_key" ON "leads"("company_id", "amo_lead_id");

-- CreateIndex
CREATE INDEX "lead_events_company_id_lead_id_effective_at_idx" ON "lead_events"("company_id", "lead_id", "effective_at");

-- CreateIndex
CREATE INDEX "lead_events_company_id_kind_effective_at_idx" ON "lead_events"("company_id", "kind", "effective_at");

-- CreateIndex
CREATE INDEX "conversations_company_id_lead_id_idx" ON "conversations"("company_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_company_id_id_key" ON "conversations"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_connection_id_scoped_peer_id_key" ON "conversations"("connection_id", "scoped_peer_id");

-- CreateIndex
CREATE INDEX "messages_company_id_conversation_id_created_at_idx" ON "messages"("company_id", "conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_connection_id_provider_message_id_key" ON "messages"("connection_id", "provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "offers_company_id_id_key" ON "offers"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "offers_company_id_lead_id_version_key" ON "offers"("company_id", "lead_id", "version");

-- CreateIndex
CREATE INDEX "orders_company_id_owner_id_idx" ON "orders"("company_id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_company_id_id_key" ON "orders"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_company_id_order_no_key" ON "orders"("company_id", "order_no");

-- CreateIndex
CREATE UNIQUE INDEX "passengers_company_id_id_key" ON "passengers"("company_id", "id");

-- CreateIndex
CREATE INDEX "flight_segments_company_id_departure_at_utc_idx" ON "flight_segments"("company_id", "departure_at_utc");

-- CreateIndex
CREATE INDEX "flight_segments_company_id_owner_id_check_state_departure_a_idx" ON "flight_segments"("company_id", "owner_id", "check_state", "departure_at_utc");

-- CreateIndex
CREATE UNIQUE INDEX "flight_segments_company_id_id_key" ON "flight_segments"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "flight_segments_company_id_order_id_segment_no_key" ON "flight_segments"("company_id", "order_id", "segment_no");

-- CreateIndex
CREATE UNIQUE INDEX "segment_revisions_segment_id_revision_key" ON "segment_revisions"("segment_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_company_id_id_key" ON "tickets"("company_id", "id");

-- CreateIndex
CREATE INDEX "flight_checks_company_id_segment_id_checked_at_idx" ON "flight_checks"("company_id", "segment_id", "checked_at");

-- CreateIndex
CREATE INDEX "customer_notifications_company_id_segment_id_idx" ON "customer_notifications"("company_id", "segment_id");

-- CreateIndex
CREATE INDEX "payments_company_id_order_id_idx" ON "payments"("company_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_company_id_business_key_key" ON "payments"("company_id", "business_key");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_rules_company_id_milestone_version_key" ON "reminder_rules"("company_id", "milestone", "version");

-- CreateIndex
CREATE INDEX "reminder_occurrences_state_due_at_idx" ON "reminder_occurrences"("state", "due_at");

-- CreateIndex
CREATE INDEX "reminder_occurrences_company_id_assignee_id_state_idx" ON "reminder_occurrences"("company_id", "assignee_id", "state");

-- CreateIndex
CREATE INDEX "reminder_occurrences_company_id_segment_id_idx" ON "reminder_occurrences"("company_id", "segment_id");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_occurrences_company_id_id_key" ON "reminder_occurrences"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_occurrences_company_id_dedupe_key_key" ON "reminder_occurrences"("company_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_occurrences_company_id_segment_id_schedule_revisio_key" ON "reminder_occurrences"("company_id", "segment_id", "schedule_revision", "rule_version", "milestone");

-- CreateIndex
CREATE INDEX "notifications_company_id_user_id_read_at_idx" ON "notifications"("company_id", "user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_company_id_dedupe_key_key" ON "notifications"("company_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_occurrence_id_channel_key" ON "notification_deliveries"("occurrence_id", "channel");

-- CreateIndex
CREATE INDEX "crm_tasks_company_id_entity_type_entity_id_idx" ON "crm_tasks"("company_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_tasks_company_id_automation_key_key" ON "crm_tasks"("company_id", "automation_key");

-- CreateIndex
CREATE INDEX "webhook_inbox_state_next_attempt_at_idx" ON "webhook_inbox"("state", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_inbox_provider_connection_key_external_event_id_key" ON "webhook_inbox"("provider", "connection_key", "external_event_id");

-- CreateIndex
CREATE INDEX "outbox_operations_state_next_attempt_at_idx" ON "outbox_operations"("state", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_operations_company_id_operation_key_key" ON "outbox_operations"("company_id", "operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_company_id_user_id_key_key" ON "idempotency_keys"("company_id", "user_id", "key");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_entity_type_entity_id_created_at_idx" ON "audit_logs"("company_id", "entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_created_at_idx" ON "audit_logs"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_company_id_owner_type_owner_id_idx" ON "attachments"("company_id", "owner_type", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_company_id_object_key_key" ON "attachments"("company_id", "object_key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_pool_members" ADD CONSTRAINT "manager_pool_members_company_id_pool_id_fkey" FOREIGN KEY ("company_id", "pool_id") REFERENCES "manager_pools"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_identifiers" ADD CONSTRAINT "contact_identifiers_company_id_contact_id_fkey" FOREIGN KEY ("company_id", "contact_id") REFERENCES "contacts"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_id_conversation_id_fkey" FOREIGN KEY ("company_id", "conversation_id") REFERENCES "conversations"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_company_id_lead_id_fkey" FOREIGN KEY ("company_id", "lead_id") REFERENCES "leads"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_services" ADD CONSTRAINT "order_services_company_id_order_id_fkey" FOREIGN KEY ("company_id", "order_id") REFERENCES "orders"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passengers" ADD CONSTRAINT "passengers_company_id_order_id_fkey" FOREIGN KEY ("company_id", "order_id") REFERENCES "orders"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flight_segments" ADD CONSTRAINT "flight_segments_company_id_order_id_fkey" FOREIGN KEY ("company_id", "order_id") REFERENCES "orders"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segment_passengers" ADD CONSTRAINT "segment_passengers_company_id_segment_id_fkey" FOREIGN KEY ("company_id", "segment_id") REFERENCES "flight_segments"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segment_passengers" ADD CONSTRAINT "segment_passengers_company_id_passenger_id_fkey" FOREIGN KEY ("company_id", "passenger_id") REFERENCES "passengers"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_company_id_passenger_id_fkey" FOREIGN KEY ("company_id", "passenger_id") REFERENCES "passengers"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_segments" ADD CONSTRAINT "ticket_segments_company_id_ticket_id_fkey" FOREIGN KEY ("company_id", "ticket_id") REFERENCES "tickets"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_segments" ADD CONSTRAINT "ticket_segments_company_id_segment_id_fkey" FOREIGN KEY ("company_id", "segment_id") REFERENCES "flight_segments"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flight_checks" ADD CONSTRAINT "flight_checks_company_id_segment_id_fkey" FOREIGN KEY ("company_id", "segment_id") REFERENCES "flight_segments"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_order_id_fkey" FOREIGN KEY ("company_id", "order_id") REFERENCES "orders"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

