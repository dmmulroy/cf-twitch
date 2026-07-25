DROP VIEW `raffle_leaderboard`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rolls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`roll` integer NOT NULL,
	`winning_number` integer NOT NULL,
	`distance` integer NOT NULL,
	`is_winner` integer NOT NULL,
	`is_new_record` integer NOT NULL,
	`rolled_at` text NOT NULL,
	CONSTRAINT "rolls_user_id_nonempty" CHECK(length(`user_id`) > 0),
	CONSTRAINT "rolls_display_name_nonempty" CHECK(length(`display_name`) > 0),
	CONSTRAINT "rolls_roll_range" CHECK(`roll` between 1 and 10000),
	CONSTRAINT "rolls_winning_number_range" CHECK(`winning_number` between 1 and 10000),
	CONSTRAINT "rolls_distance_invariant" CHECK(`distance` = abs(`roll` - `winning_number`)),
	CONSTRAINT "rolls_winner_invariant" CHECK(`is_winner` = (`distance` = 0))
);--> statement-breakpoint
INSERT INTO `__new_rolls` (
	`id`, `user_id`, `display_name`, `roll`, `winning_number`, `distance`, `is_winner`, `is_new_record`, `rolled_at`
)
SELECT
	current.`id`, current.`user_id`, current.`display_name`, current.`roll`, current.`winning_number`,
	current.`distance`, current.`is_winner`,
	CASE WHEN current.`distance` > 0 AND NOT EXISTS (
		SELECT 1 FROM `rolls` prior
		WHERE prior.rowid < current.rowid
			AND prior.`distance` > 0
			AND prior.`distance` <= current.`distance`
	) THEN 1 ELSE 0 END,
	current.`rolled_at`
FROM `rolls` current;--> statement-breakpoint
DROP TABLE `rolls`;--> statement-breakpoint
ALTER TABLE `__new_rolls` RENAME TO `rolls`;--> statement-breakpoint
CREATE INDEX `idx_rolls_user_id` ON `rolls`(`user_id`);--> statement-breakpoint
CREATE INDEX `idx_rolls_user_distance` ON `rolls`(`user_id`, `distance`);--> statement-breakpoint
CREATE VIEW `raffle_leaderboard` AS
WITH
user_aggregates AS (
  SELECT `user_id`, COUNT(*) as `total_rolls`, CAST(SUM(`is_winner`) AS INTEGER) as `total_wins`, MAX(`rolled_at`) as `last_rolled_at`
  FROM `rolls` GROUP BY `user_id`
),
closest AS (
  SELECT DISTINCT `user_id`, FIRST_VALUE(`distance`) OVER w as `closest_distance`, FIRST_VALUE(`roll`) OVER w as `closest_roll`, FIRST_VALUE(`winning_number`) OVER w as `closest_winning_number`
  FROM `rolls` WHERE `is_winner` = 0 WINDOW w AS (PARTITION BY `user_id` ORDER BY `distance` ASC)
),
latest AS (
  SELECT DISTINCT `user_id`, FIRST_VALUE(`display_name`) OVER (PARTITION BY `user_id` ORDER BY `rolled_at` DESC) as `display_name`
  FROM `rolls`
)
SELECT a.`user_id`, l.`display_name`, a.`total_rolls`, a.`total_wins`, c.`closest_distance`, c.`closest_roll`, c.`closest_winning_number`, a.`last_rolled_at`
FROM user_aggregates a
LEFT JOIN latest l ON a.`user_id` = l.`user_id`
LEFT JOIN closest c ON a.`user_id` = c.`user_id`
ORDER BY a.`total_rolls` DESC;--> statement-breakpoint
PRAGMA foreign_keys=ON;
