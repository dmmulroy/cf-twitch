CREATE TABLE `warm_instances` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`workflow_type` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `warm_instances_type_idx` ON `warm_instances` (`workflow_type`);
