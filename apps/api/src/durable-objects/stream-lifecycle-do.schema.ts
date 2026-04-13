/**
 * Drizzle schema for StreamLifecycleDO
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Viewer snapshots table - stores historical viewer counts
 */
export const viewerSnapshots = sqliteTable("viewer_snapshots", {
	timestamp: text("timestamp").primaryKey(), // ISO8601 timestamp
	viewerCount: integer("viewer_count").notNull(),
});

export type ViewerSnapshot = typeof viewerSnapshots.$inferSelect;
export type NewViewerSnapshot = typeof viewerSnapshots.$inferInsert;
