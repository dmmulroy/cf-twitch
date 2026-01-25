/**
 * Saga schema - Drizzle schema for saga persistence in Saga DOs
 *
 * Used by SongRequestSagaDO, KeyboardRaffleSagaDO, and other saga-based DOs.
 */

import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Saga run status
 */
export type SagaStatus = "RUNNING" | "COMPLETED" | "FAILED" | "COMPENSATING";

/**
 * Saga step state
 */
export type SagaStepState = "PENDING" | "SUCCEEDED" | "FAILED" | "COMPENSATED";

/**
 * Saga runs table - tracks overall saga state
 *
 * One row per saga instance (keyed by redemption/event ID).
 */
export const sagaRuns = sqliteTable("saga_runs", {
	id: text("id").primaryKey(),
	status: text("status").$type<SagaStatus>().notNull(),
	paramsJson: text("params_json").notNull(),
	fulfilledAt: text("fulfilled_at"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
	error: text("error"),
});

export type SagaRun = typeof sagaRuns.$inferSelect;
export type InsertSagaRun = typeof sagaRuns.$inferInsert;

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
	(table) => [primaryKey({ columns: [table.sagaId, table.stepName] })],
);

export type SagaStep = typeof sagaSteps.$inferSelect;
export type InsertSagaStep = typeof sagaSteps.$inferInsert;
