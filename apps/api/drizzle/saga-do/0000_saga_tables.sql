CREATE TABLE `saga_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`params_json` text NOT NULL,
	`fulfilled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `saga_steps` (
	`saga_id` text NOT NULL,
	`step_name` text NOT NULL,
	`state` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`result_json` text,
	`undo_json` text,
	`next_retry_at` text,
	`last_error` text,
	PRIMARY KEY(`saga_id`, `step_name`)
);
--> statement-breakpoint
CREATE INDEX `idx_saga_runs_status` ON `saga_runs`(`status`);
--> statement-breakpoint
CREATE INDEX `idx_saga_steps_state` ON `saga_steps`(`state`);
