CREATE TABLE `rolls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`roll` integer NOT NULL,
	`winning_number` integer NOT NULL,
	`distance` integer NOT NULL,
	`is_winner` integer NOT NULL,
	`rolled_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rolls_user_id` ON `rolls`(`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_rolls_user_distance` ON `rolls`(`user_id`, `distance`) WHERE `is_winner` = 0;
--> statement-breakpoint
CREATE VIEW `raffle_leaderboard` AS
WITH 
user_aggregates AS (
  SELECT 
    `user_id`,
    COUNT(*) as `total_rolls`,
    CAST(SUM(`is_winner`) AS INTEGER) as `total_wins`,
    MAX(`rolled_at`) as `last_rolled_at`
  FROM `rolls`
  GROUP BY `user_id`
),
closest AS (
  SELECT DISTINCT 
    `user_id`,
    FIRST_VALUE(`distance`) OVER w as `closest_distance`,
    FIRST_VALUE(`roll`) OVER w as `closest_roll`,
    FIRST_VALUE(`winning_number`) OVER w as `closest_winning_number`
  FROM `rolls`
  WHERE `is_winner` = 0
  WINDOW w AS (PARTITION BY `user_id` ORDER BY `distance` ASC)
),
latest AS (
  SELECT DISTINCT
    `user_id`,
    FIRST_VALUE(`display_name`) OVER (PARTITION BY `user_id` ORDER BY `rolled_at` DESC) as `display_name`
  FROM `rolls`
)
SELECT 
  a.`user_id`,
  l.`display_name`,
  a.`total_rolls`,
  a.`total_wins`,
  c.`closest_distance`,
  c.`closest_roll`,
  c.`closest_winning_number`,
  a.`last_rolled_at`
FROM user_aggregates a
LEFT JOIN latest l ON a.`user_id` = l.`user_id`
LEFT JOIN closest c ON a.`user_id` = c.`user_id`
ORDER BY a.`total_rolls` DESC;
