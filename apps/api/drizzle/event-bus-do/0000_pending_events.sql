CREATE TABLE `pending_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`attempts` integer NOT NULL DEFAULT 0,
	`next_retry_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pending_next_retry` ON `pending_events`(`next_retry_at`);
