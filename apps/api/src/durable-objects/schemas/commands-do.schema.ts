/**
 * CommandsDO schema - command registry and dynamic values
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Command definitions - registry of all chat commands
 *
 * Commands have types:
 * - static: Fixed response stored in command_values
 * - dynamic: Updateable response stored in command_values
 * - computed: Response generated at runtime (e.g., !achievements, !stats)
 */
export const commands = sqliteTable("commands", {
	name: text("name").primaryKey(),
	description: text("description").notNull(),
	category: text("category").notNull(), // "info" | "stats" | "meta" | "music"
	responseType: text("response_type").notNull(), // "static" | "dynamic" | "computed"
	permission: text("permission").notNull(), // "everyone" | "moderator" | "broadcaster"
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	createdAt: text("created_at").notNull(),
});

export type Command = typeof commands.$inferSelect;
export type InsertCommand = typeof commands.$inferInsert;

/**
 * Command values - stores responses for static/dynamic commands
 *
 * Only used for static and dynamic commands. Computed commands
 * generate their response at runtime.
 */
export const commandValues = sqliteTable("command_values", {
	commandName: text("command_name")
		.primaryKey()
		.references(() => commands.name),
	value: text("value").notNull(),
	updatedAt: text("updated_at").notNull(),
	updatedBy: text("updated_by"), // user who last updated (null for seed)
});

export type CommandValue = typeof commandValues.$inferSelect;
export type InsertCommandValue = typeof commandValues.$inferInsert;

/**
 * Permission level enum for type safety
 */
export type Permission = "everyone" | "moderator" | "broadcaster";

/**
 * Response type enum for type safety
 */
export type ResponseType = "static" | "dynamic" | "computed";

/**
 * Category enum for type safety
 */
export type Category = "info" | "stats" | "meta" | "music";
