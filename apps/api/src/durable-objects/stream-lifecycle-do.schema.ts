/**
 * Drizzle schema for StreamLifecycleDO
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Stream state table (singleton pattern)
 */
export const streamState = sqliteTable("stream_state", {
	id: integer("id")
		.primaryKey()
		.$default(() => 1),
	isLive: integer("is_live", { mode: "boolean" }).notNull().default(false),
	startedAt: text("started_at"), // ISO8601 timestamp
	endedAt: text("ended_at"), // ISO8601 timestamp
	peakViewerCount: integer("peak_viewer_count").notNull().default(0),
});

/**
 * Viewer snapshots table - stores historical viewer counts
 */
export const viewerSnapshots = sqliteTable("viewer_snapshots", {
	timestamp: text("timestamp").primaryKey(), // ISO8601 timestamp
	viewerCount: integer("viewer_count").notNull(),
});

export type StreamState = typeof streamState.$inferSelect;
export type NewStreamState = typeof streamState.$inferInsert;
export type ViewerSnapshot = typeof viewerSnapshots.$inferSelect;
export type NewViewerSnapshot = typeof viewerSnapshots.$inferInsert;
