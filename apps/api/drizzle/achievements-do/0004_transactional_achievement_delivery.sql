PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_user_achievements` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `user_display_name` text NOT NULL,
  `achievement_id` text NOT NULL,
  `progress` integer DEFAULT 0 NOT NULL,
  `unlocked_at` text,
  `announcement_state` text DEFAULT 'pending' NOT NULL,
  `event_id` text
);
--> statement-breakpoint
WITH mapped_achievements AS (
  SELECT ua.*,
    COALESCE(
      (SELECT eh.`user_id` FROM `event_history` eh WHERE lower(eh.`user_display_name`) = lower(ua.`user_display_name`) AND eh.`user_id` <> 'system' ORDER BY eh.`timestamp` DESC LIMIT 1),
      'legacy-display:' || lower(ua.`user_display_name`)
    ) AS mapped_user_id
  FROM `user_achievements` ua
)
INSERT INTO `__new_user_achievements` (`id`, `user_id`, `user_display_name`, `achievement_id`, `progress`, `unlocked_at`, `announcement_state`, `event_id`)
SELECT min(`id`), mapped_user_id, max(`user_display_name`), `achievement_id`, max(`progress`), max(`unlocked_at`),
  CASE WHEN max(`announced`) = 1 THEN 'sent' ELSE 'pending' END,
  max(`event_id`)
FROM mapped_achievements
GROUP BY mapped_user_id, `achievement_id`;
--> statement-breakpoint
DROP TABLE `user_achievements`;
--> statement-breakpoint
ALTER TABLE `__new_user_achievements` RENAME TO `user_achievements`;
--> statement-breakpoint
CREATE UNIQUE INDEX `user_achievement_viewer_unique` ON `user_achievements` (`user_id`, `achievement_id`);
--> statement-breakpoint
CREATE INDEX `idx_user_achievements_viewer` ON `user_achievements` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_user_achievements_display_name` ON `user_achievements` (`user_display_name`);
--> statement-breakpoint
CREATE INDEX `idx_user_achievements_unlocked` ON `user_achievements` (`unlocked_at`);
--> statement-breakpoint
CREATE TABLE `achievement_stream_session` (
  `singleton_id` integer PRIMARY KEY DEFAULT 1 NOT NULL CHECK (`singleton_id` = 1),
  `status` text NOT NULL CHECK (`status` IN ('online', 'offline')),
  `stream_id` text,
  `started_at` text,
  `transition_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `achievement_unlock_outbox` (
  `effect_id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL,
  `user_id` text NOT NULL,
  `user_display_name` text NOT NULL,
  `achievement_id` text NOT NULL,
  `achievement_name` text NOT NULL,
  `achievement_description` text NOT NULL,
  `category` text NOT NULL,
  `metric_state` text DEFAULT 'pending' NOT NULL CHECK (`metric_state` IN ('pending', 'claimed')),
  `announcement_state` text DEFAULT 'pending' NOT NULL CHECK (`announcement_state` IN ('pending', 'sending', 'sent', 'abandoned', 'uncertain')),
  `announcement_attempts` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_achievement_unlock_outbox_pending` ON `achievement_unlock_outbox` (`announcement_state`, `metric_state`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
