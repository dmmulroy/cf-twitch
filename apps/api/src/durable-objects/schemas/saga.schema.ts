/**
 * Saga schema - Drizzle schema for saga persistence in Saga DOs
 *
 * Used by SongRequestSagaDO, KeyboardRaffleSagaDO, and other saga-based DOs.
 */

import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

/**
 * Saga run status
 */
export type SagaStatus =
	| "RUNNING"
	| "COMPLETED"
	| "FAILED"
	| "COMPENSATING"
	| "COMPENSATION_FAILED"
	| "OUTCOME_UNKNOWN"
	| "POST_COMMIT_FAILED";

/**
 * Saga step state
 */
const SagaStatusSchema = z.enum([
	"RUNNING",
	"COMPLETED",
	"FAILED",
	"COMPENSATING",
	"COMPENSATION_FAILED",
	"OUTCOME_UNKNOWN",
	"POST_COMMIT_FAILED",
]);

export type SagaStepState =
	| "PENDING"
	| "SUCCEEDED"
	| "FAILED"
	| "COMPENSATION_PENDING"
	| "COMPENSATED";

/**
 * Saga runs table - tracks overall saga state
 *
 * One row per saga instance (keyed by redemption/event ID).
 */
const SagaStepStateSchema = z.enum([
	"PENDING",
	"SUCCEEDED",
	"FAILED",
	"COMPENSATION_PENDING",
	"COMPENSATED",
]);

export const sagaRuns = sqliteTable(
	"saga_runs",
	{
		id: text("id").primaryKey(),
		status: text("status").$type<SagaStatus>().notNull(),
		paramsJson: text("params_json").notNull(),
		fulfilledAt: text("fulfilled_at"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		error: text("error"),
	},
	(table) => [
		check(
			"saga_runs_status_check",
			sql`${table.status} in ('RUNNING', 'COMPLETED', 'FAILED', 'COMPENSATING', 'COMPENSATION_FAILED', 'OUTCOME_UNKNOWN', 'POST_COMMIT_FAILED')`,
		),
	],
);

export type SagaRun = typeof sagaRuns.$inferSelect;
export type InsertSagaRun = typeof sagaRuns.$inferInsert;

/** Runtime parser for a saga run row re-entering from SQLite. */
export const SagaRunRowSchema = z.object({
	id: z.string().min(1),
	status: SagaStatusSchema,
	paramsJson: z.string(),
	fulfilledAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	error: z.string().nullable(),
});

/**
 * Saga steps table - tracks individual step execution
 *
 * Composite primary key on (saga_id, step_name) ensures one row per step.
 * Stores result for idempotent replay and undo payload for compensation.
 */
export const sagaSteps = sqliteTable(
	"saga_steps",
	{
		sagaId: text("saga_id").notNull(),
		stepName: text("step_name").notNull(),
		state: text("state").$type<SagaStepState>().notNull(),
		attempt: integer("attempt").notNull().default(0),
		resultJson: text("result_json"),
		undoJson: text("undo_json"),
		nextRetryAt: text("next_retry_at"),
		lastError: text("last_error"),
	},
	(table) => [
		primaryKey({ columns: [table.sagaId, table.stepName] }),
		check(
			"saga_steps_state_check",
			sql`${table.state} in ('PENDING', 'SUCCEEDED', 'FAILED', 'COMPENSATION_PENDING', 'COMPENSATED')`,
		),
		check("saga_steps_attempt_check", sql`${table.attempt} >= 0`),
	],
);

export type SagaStep = typeof sagaSteps.$inferSelect;
export type InsertSagaStep = typeof sagaSteps.$inferInsert;

/** Runtime parser for a saga step row re-entering from SQLite. */
export const SagaStepRowSchema = z
	.object({
		sagaId: z.string().min(1),
		stepName: z.string().min(1),
		state: SagaStepStateSchema,
		attempt: z.number().int().nonnegative(),
		resultJson: z.string().nullable(),
		undoJson: z.string().nullable(),
		nextRetryAt: z.iso.datetime().nullable(),
		lastError: z.string().nullable(),
	})
	.superRefine((row, context) => {
		if (row.state === "SUCCEEDED" && row.resultJson === null) {
			context.addIssue({ code: "custom", message: "Successful saga steps require result JSON" });
		}
		if (row.state === "COMPENSATION_PENDING" && row.nextRetryAt === null) {
			context.addIssue({ code: "custom", message: "Pending compensation requires a retry time" });
		}
	});
