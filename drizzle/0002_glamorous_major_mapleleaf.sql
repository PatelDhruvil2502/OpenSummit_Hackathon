ALTER TABLE `cases` RENAME COLUMN "owner_session" TO "owner_user_id";--> statement-breakpoint
DROP INDEX `idx_cases_owner_updated`;--> statement-breakpoint
CREATE INDEX `idx_cases_owner_updated` ON `cases` (`owner_user_id`,`updated_at`);