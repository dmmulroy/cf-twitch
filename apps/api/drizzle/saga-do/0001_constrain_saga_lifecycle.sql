PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_saga_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL CHECK (`status` IN ('RUNNING', 'COMPLETED', 'FAILED', 'COMPENSATING', 'COMPENSATION_FAILED', 'OUTCOME_UNKNOWN', 'POST_COMMIT_FAILED')),
	`params_json` text NOT NULL,
	`fulfilled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`error` text
);
--> statement-breakpoint
INSERT INTO `__new_saga_runs` SELECT `id`, `status`, `params_json`, `fulfilled_at`, `created_at`, `updated_at`, `error` FROM `saga_runs`;
--> statement-breakpoint
DROP TABLE `saga_runs`;
--> statement-breakpoint
ALTER TABLE `__new_saga_runs` RENAME TO `saga_runs`;
--> statement-breakpoint
CREATE INDEX `idx_saga_runs_status` ON `saga_runs` (`status`);
--> statement-breakpoint
CREATE TABLE `__new_saga_steps` (
	`saga_id` text NOT NULL,
	`step_name` text NOT NULL,
	`state` text NOT NULL CHECK (`state` IN ('PENDING', 'SUCCEEDED', 'FAILED', 'COMPENSATION_PENDING', 'COMPENSATED')),
	`attempt` integer DEFAULT 0 NOT NULL CHECK (`attempt` >= 0),
	`result_json` text,
	`undo_json` text,
	`next_retry_at` text,
	`last_error` text,
	PRIMARY KEY (`saga_id`, `step_name`)
);
--> statement-breakpoint
INSERT INTO `__new_saga_steps` SELECT `saga_id`, `step_name`, `state`, `attempt`, `result_json`, `undo_json`, `next_retry_at`, `last_error` FROM `saga_steps`;
--> statement-breakpoint
DROP TABLE `saga_steps`;
--> statement-breakpoint
ALTER TABLE `__new_saga_steps` RENAME TO `saga_steps`;
--> statement-breakpoint
CREATE INDEX `idx_saga_steps_state` ON `saga_steps` (`state`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
