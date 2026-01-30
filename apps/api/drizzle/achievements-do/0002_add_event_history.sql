CREATE TABLE `event_history` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`user_id` text NOT NULL,
	`user_display_name` text NOT NULL,
	`event_id` text NOT NULL,
	`timestamp` text NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `idx_event_history_type_time` ON `event_history` (`event_type`, `timestamp`);
