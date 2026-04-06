-- Add !browser chat command pointing to Helium Browser.
INSERT INTO `commands` (
	`name`,
	`description`,
	`category`,
	`response_type`,
	`permission`,
	`enabled`,
	`created_at`
) VALUES
	('browser', 'Shows browser recommendation link', 'info', 'static', 'everyone', true, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(`name`) DO UPDATE SET
	`description` = excluded.`description`,
	`category` = excluded.`category`,
	`response_type` = excluded.`response_type`,
	`permission` = excluded.`permission`,
	`enabled` = excluded.`enabled`;
--> statement-breakpoint

INSERT INTO `command_values` (
	`command_name`,
	`value`,
	`updated_at`,
	`updated_by`
) VALUES
	('browser', 'Helium Browser: https://helium.computer', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
ON CONFLICT(`command_name`) DO UPDATE SET
	`value` = excluded.`value`,
	`updated_at` = excluded.`updated_at`,
	`updated_by` = excluded.`updated_by`;
