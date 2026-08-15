CREATE INDEX `idx_audit_case_created` ON `audit_events` (`case_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_cases_owner_updated` ON `cases` (`owner_session`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_cases_retention` ON `cases` (`retention_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_documents_case` ON `document_objects` (`case_id`);--> statement-breakpoint
CREATE INDEX `idx_reports_case` ON `reports` (`case_id`);