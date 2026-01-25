/**
 * KeyboardRaffleDO schema - manages keyboard raffle rolls and leaderboard
 */

import { integer, sqliteTable, sqliteView, text } from "drizzle-orm/sqlite-core";

/**
 * Individual raffle rolls
 * - Tracks each roll with winning number and distance
 * - Can be deleted for rollback (e.g., workflow failure)
 */
export const rolls = sqliteTable("rolls", {
	id: text("id").primaryKey(), // Workflow event ID for idempotency
	userId: text("user_id").notNull(),
	displayName: text("display_name").notNull(),
	roll: integer("roll").notNull(), // User's roll (1-10000)
	winningNumber: integer("winning_number").notNull(), // Winning number for this roll (1-10000)
	distance: integer("distance").notNull(), // abs(roll - winningNumber)
	isWinner: integer("is_winner", { mode: "boolean" }).notNull(), // distance === 0
	rolledAt: text("rolled_at").notNull(), // ISO8601
});

export type Roll = typeof rolls.$inferSelect;
export type InsertRoll = typeof rolls.$inferInsert;

/**
 * Raffle leaderboard - computed view over rolls table
 * Created via migration, referenced here with .existing()
 */
export const raffleLeaderboard = sqliteView("raffle_leaderboard", {
	userId: text("user_id").notNull(),
	displayName: text("display_name").notNull(),
	totalRolls: integer("total_rolls").notNull(),
	totalWins: integer("total_wins").notNull(),
	closestDistance: integer("closest_distance"),
	closestRoll: integer("closest_roll"),
	closestWinningNumber: integer("closest_winning_number"),
	lastRolledAt: text("last_rolled_at").notNull(),
}).existing();

export type LeaderboardEntry = typeof raffleLeaderboard.$inferSelect;
