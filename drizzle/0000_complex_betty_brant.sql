CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`event_type` text NOT NULL,
	`safe_metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cases` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_session` text NOT NULL,
	`scenario` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`worker_name` text DEFAULT '' NOT NULL,
	`employer_name` text DEFAULT '' NOT NULL,
	`review_start` text NOT NULL,
	`review_end` text NOT NULL,
	`payload_json` text NOT NULL,
	`retention_expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deletion_tombstones` (
	`case_id_hash` text PRIMARY KEY NOT NULL,
	`requested_at` text NOT NULL,
	`completed_at` text NOT NULL,
	`policy_version` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`object_key` text NOT NULL,
	`original_name` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_objects_object_key_unique` ON `document_objects` (`object_key`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`included_finding_ids_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_object_key_unique` ON `reports` (`object_key`);