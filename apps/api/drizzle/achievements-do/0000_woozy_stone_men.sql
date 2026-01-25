CREATE TABLE `achievement_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`icon` text NOT NULL,
	`category` text NOT NULL,
	`threshold` integer,
	`trigger_event` text NOT NULL,
	`scope` text DEFAULT 'cumulative' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_achievements` (
	`id` text PRIMARY KEY NOT NULL,
	`user_display_name` text NOT NULL,
	`achievement_id` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`unlocked_at` text,
	`announced` integer DEFAULT false NOT NULL,
	`event_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_user_achievements_user` ON `user_achievements` (`user_display_name`);--> statement-breakpoint
CREATE INDEX `idx_user_achievements_unlocked` ON `user_achievements` (`unlocked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_achievement_unique` ON `user_achievements` (`user_display_name`,`achievement_id`);
--> statement-breakpoint
-- Seed achievement definitions
INSERT INTO `achievement_definitions` (`id`, `name`, `description`, `icon`, `category`, `threshold`, `trigger_event`, `scope`) VALUES
  -- Song Request Achievements
  ('first_request', 'First Timer', 'Request your first song', '1f3b5', 'song_request', 1, 'song_request', 'cumulative'),
  ('request_10', 'Regular', 'Request 10 songs', '1f3b6', 'song_request', 10, 'song_request', 'cumulative'),
  ('request_50', 'DJ in Training', 'Request 50 songs', '1f3a7', 'song_request', 50, 'song_request', 'cumulative'),
  ('request_100', 'Certified DJ', 'Request 100 songs', '1f4bf', 'song_request', 100, 'song_request', 'cumulative'),
  ('stream_opener', 'Stream Opener', 'First song request of the stream', '1f305', 'special', NULL, 'stream_first_request', 'session'),
  -- Raffle Achievements
  ('first_roll', 'Feeling Lucky', 'Enter your first raffle', '1f3b2', 'raffle', 1, 'raffle_roll', 'cumulative'),
  ('roll_25', 'Persistent', 'Enter 25 raffles', '1f3b0', 'raffle', 25, 'raffle_roll', 'cumulative'),
  ('roll_100', 'Never Give Up', 'Enter 100 raffles', '1f4aa', 'raffle', 100, 'raffle_roll', 'cumulative'),
  ('first_win', 'Winner Winner', 'Win your first raffle', '1f3c6', 'raffle', 1, 'raffle_win', 'cumulative'),
  ('close_call', 'So Close', 'Roll within 100 of winning number', '1f62c', 'raffle', NULL, 'raffle_close', 'cumulative'),
  ('closest_ever', 'Heartbreaker', 'Hold the closest non-winning roll record', '1f494', 'special', NULL, 'raffle_closest_record', 'cumulative'),
  -- Engagement Achievements
  ('streak_3', 'On a Roll', '3 successful requests in a row', '1f525', 'engagement', 3, 'request_streak', 'session'),
  ('streak_5', 'Hot Streak', '5 successful requests in a row', '26a1', 'engagement', 5, 'request_streak', 'session');