CREATE TABLE `password_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `password_resets_token_hash_unique` ON `password_resets` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_password_resets_account` ON `password_resets` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_password_resets_expiry` ON `password_resets` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_rate_limits_window` ON `auth_rate_limits` (`window_started_at`);
