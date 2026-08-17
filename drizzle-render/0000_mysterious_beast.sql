CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"policy_accepted_at" text,
	"policy_version" text,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"event_type" text NOT NULL,
	"safe_metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"bucket" text PRIMARY KEY NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" text NOT NULL,
	"locked_until" text
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"expires_at" text NOT NULL,
	CONSTRAINT "auth_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"scenario" text NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"worker_name" text DEFAULT '' NOT NULL,
	"employer_name" text DEFAULT '' NOT NULL,
	"review_start" text NOT NULL,
	"review_end" text NOT NULL,
	"payload_json" text NOT NULL,
	"retention_expires_at" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_tombstones" (
	"case_id_hash" text PRIMARY KEY NOT NULL,
	"requested_at" text NOT NULL,
	"completed_at" text NOT NULL,
	"policy_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"object_key" text NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "document_objects_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"owner_user_id" text NOT NULL,
	"operation_scope" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"response_json" text,
	"response_status" integer,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	CONSTRAINT "idempotency_keys_owner_user_id_operation_scope_idempotency_key_pk" PRIMARY KEY("owner_user_id","operation_scope","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"included_finding_ids_json" text NOT NULL,
	"manifest_json" text DEFAULT '{}' NOT NULL,
	"case_snapshot_version" integer DEFAULT 1 NOT NULL,
	"created_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "reports_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_objects" ADD CONSTRAINT "document_objects_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_accounts_email" ON "accounts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_audit_case_created" ON "audit_events" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_auth_rate_limits_window" ON "auth_rate_limits" USING btree ("window_started_at");--> statement-breakpoint
CREATE INDEX "idx_auth_sessions_account" ON "auth_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_auth_sessions_expiry" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_cases_owner_updated" ON "cases" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_cases_retention" ON "cases" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE INDEX "idx_documents_case" ON "document_objects" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_idempotency_expiry" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_password_resets_account" ON "password_resets" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_password_resets_expiry" ON "password_resets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_reports_case" ON "reports" USING btree ("case_id");