/** Event Bus persistence tables for pending delivery, dead letters, and receipts. */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Events awaiting initial delivery or a retry attempt. */
export const pendingEvents = sqliteTable(
	"pending_events",
	{
		id: text("id").primaryKey(),
		event: text("event").notNull(),
		attempts: integer("attempts").notNull().default(0),
		nextRetryAt: text("next_retry_at").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [index("idx_pending_next_retry").on(table.nextRetryAt)],
);

/** Persisted row for an Event Bus delivery awaiting retry. */
export type PendingEvent = typeof pendingEvents.$inferSelect;
/** Insert representation for an Event Bus delivery awaiting retry. */
export type InsertPendingEvent = typeof pendingEvents.$inferInsert;

/** Events that exhausted retry policy and await administration or expiry. */
export const deadLetterQueue = sqliteTable(
	"dead_letter_queue",
	{
		id: text("id").primaryKey(),
		event: text("event").notNull(),
		error: text("error").notNull(),
		attempts: integer("attempts").notNull(),
		firstFailedAt: text("first_failed_at").notNull(),
		lastFailedAt: text("last_failed_at").notNull(),
		expiresAt: text("expires_at").notNull(),
	},
	(table) => [index("idx_dlq_expires_at").on(table.expiresAt)],
);

/** Persisted Event Bus dead-letter row. */
export type DeadLetterEvent = typeof deadLetterQueue.$inferSelect;
/** Insert representation for an Event Bus dead-letter row. */
export type InsertDeadLetterEvent = typeof deadLetterQueue.$inferInsert;

/** Durable Event Bus delivery receipts that suppress duplicate producer retries. */
export const deliveredEvents = sqliteTable("delivered_events", {
	id: text("id").primaryKey(),
	deliveredAt: text("delivered_at").notNull(),
});
