CREATE TABLE `dead_letter_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`error` text NOT NULL,
	`attempts` integer NOT NULL,
	`first_failed_at` text NOT NULL,
	`last_failed_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dlq_expires_at` ON `dead_letter_queue`(`expires_at`);
