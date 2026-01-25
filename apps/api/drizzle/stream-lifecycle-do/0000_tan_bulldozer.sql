CREATE TABLE `stream_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`is_live` integer DEFAULT false NOT NULL,
	`started_at` text,
	`ended_at` text,
	`peak_viewer_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `viewer_snapshots` (
	`timestamp` text PRIMARY KEY NOT NULL,
	`viewer_count` integer NOT NULL
);
