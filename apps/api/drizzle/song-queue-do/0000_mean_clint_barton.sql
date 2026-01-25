CREATE TABLE `pending_requests` (
	`event_id` text PRIMARY KEY NOT NULL,
	`track_id` text NOT NULL,
	`track_name` text NOT NULL,
	`artists` text NOT NULL,
	`album` text NOT NULL,
	`album_cover_url` text,
	`requester_user_id` text NOT NULL,
	`requester_display_name` text NOT NULL,
	`requested_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_history` (
	`event_id` text PRIMARY KEY NOT NULL,
	`track_id` text NOT NULL,
	`track_name` text NOT NULL,
	`artists` text NOT NULL,
	`album` text NOT NULL,
	`album_cover_url` text,
	`requester_user_id` text NOT NULL,
	`requester_display_name` text NOT NULL,
	`requested_at` text NOT NULL,
	`fulfilled_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spotify_queue_snapshot` (
	`position` integer PRIMARY KEY NOT NULL,
	`track_id` text NOT NULL,
	`track_name` text NOT NULL,
	`artists` text NOT NULL,
	`album` text NOT NULL,
	`album_cover_url` text,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_request_history_fulfilled_at` ON `request_history`(`fulfilled_at`);
--> statement-breakpoint
CREATE INDEX `idx_request_history_requester` ON `request_history`(`requester_user_id`);
--> statement-breakpoint
CREATE INDEX `idx_request_history_track` ON `request_history`(`track_id`);
