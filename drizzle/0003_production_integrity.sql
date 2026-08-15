ALTER TABLE `cases` ADD COLUMN `state_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE `cases`
SET `state_version` = COALESCE(CAST(json_extract(`payload_json`, '$.stateVersion') AS INTEGER), 1);
--> statement-breakpoint
ALTER TABLE `reports` ADD COLUMN `manifest_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `reports` ADD COLUMN `case_snapshot_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`owner_user_id` text NOT NULL,
	`operation_scope` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`response_json` text,
	`response_status` integer,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`owner_user_id`, `operation_scope`, `idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_idempotency_expiry` ON `idempotency_keys` (`expires_at`);
