CREATE TABLE `commands` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`response_type` text NOT NULL,
	`permission` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `command_values` (
	`command_name` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`command_name`) REFERENCES `commands`(`name`) ON UPDATE no action ON DELETE no action
);
