CREATE TABLE `user_streaks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`user_display_name` text NOT NULL,
	`session_streak` integer DEFAULT 0 NOT NULL,
	`longest_streak` integer DEFAULT 0 NOT NULL,
	`last_request_at` text,
	`session_started_at` text
);
