-- Allow !leak to be updated via !update by switching it to a dynamic command.
INSERT INTO `commands` (
	`name`,
	`description`,
	`category`,
	`response_type`,
	`permission`,
	`enabled`,
	`created_at`
) VALUES
	('leak', 'Security leak meme command', 'meta', 'dynamic', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(`name`) DO UPDATE SET
	`description` = excluded.`description`,
	`category` = excluded.`category`,
	`response_type` = excluded.`response_type`,
	`permission` = excluded.`permission`,
	`enabled` = excluded.`enabled`;
--> statement-breakpoint

-- Allow VIP+ users to invoke !update.
INSERT INTO `commands` (
	`name`,
	`description`,
	`category`,
	`response_type`,
	`permission`,
	`enabled`,
	`created_at`
) VALUES
	('update', 'Updates dynamic command values', 'meta', 'computed', 'vip', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(`name`) DO UPDATE SET
	`description` = excluded.`description`,
	`category` = excluded.`category`,
	`response_type` = excluded.`response_type`,
	`permission` = excluded.`permission`,
	`enabled` = excluded.`enabled`;
--> statement-breakpoint

-- Ensure !leak has an initial value if missing.
INSERT OR IGNORE INTO `command_values` (
	`command_name`,
	`value`,
	`updated_at`,
	`updated_by`
) VALUES
	(
		'leak',
		'Dillon last leaked his keys on 23 Jan 2026 (before on 09 Dec 2025 ), admin secret on 16 Feb 2026',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		NULL
	);
