/**
 * Drizzle schema for WorkflowPoolDO
 * Manages pools of pre-warmed workflow instances
 */

import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Workflow types supported by the pool
 */
export const WORKFLOW_TYPES = ["song-request", "chat-command", "keyboard-raffle"] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

/**
 * Pool size per workflow type
 */
export const POOL_SIZE = 3;

/**
 * Warm workflow instances table
 * Stores instance IDs that are waiting at step.waitForEvent("activate")
 */
export const warmInstances = sqliteTable(
	"warm_instances",
	{
		instanceId: text("instance_id").primaryKey(),
		workflowType: text("workflow_type").notNull().$type<WorkflowType>(),
		createdAt: text("created_at").notNull(), // ISO8601 timestamp
	},
	(table) => [index("warm_instances_type_idx").on(table.workflowType)],
);

export type WarmInstance = typeof warmInstances.$inferSelect;
export type NewWarmInstance = typeof warmInstances.$inferInsert;
