ALTER TABLE `pending_requests` ADD `first_seen_in_spotify_at` text;--> statement-breakpoint
ALTER TABLE `pending_requests` ADD `last_seen_in_spotify_at` text;--> statement-breakpoint
ALTER TABLE `spotify_queue_snapshot` ADD `source` text DEFAULT 'autoplay' NOT NULL;--> statement-breakpoint
ALTER TABLE `spotify_queue_snapshot` ADD `event_id` text;--> statement-breakpoint
ALTER TABLE `spotify_queue_snapshot` ADD `requester_user_id` text;--> statement-breakpoint
ALTER TABLE `spotify_queue_snapshot` ADD `requester_display_name` text;--> statement-breakpoint
ALTER TABLE `spotify_queue_snapshot` ADD `requested_at` text;