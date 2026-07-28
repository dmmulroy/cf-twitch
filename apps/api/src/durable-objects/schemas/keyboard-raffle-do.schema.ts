/** Keyboard Raffle Roll persistence schemas and Raffle Leaderboard view. */

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, sqliteView, text } from "drizzle-orm/sqlite-core";

/** Individual Rolls, including durable idempotency and domain invariant evidence. */
export const rolls = sqliteTable(
	"rolls",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		displayName: text("display_name").notNull(),
		roll: integer("roll").notNull(),
		winningNumber: integer("winning_number").notNull(),
		distance: integer("distance").notNull(),
		isWinner: integer("is_winner", { mode: "boolean" }).notNull(),
		isNewRecord: integer("is_new_record", { mode: "boolean" }).notNull(),
		rolledAt: text("rolled_at").notNull(),
	},
	(table) => [
		index("idx_rolls_user_id").on(table.userId),
		index("idx_rolls_user_distance").on(table.userId, table.distance),
		check("rolls_user_id_nonempty", sql`length(${table.userId}) > 0`),
		check("rolls_display_name_nonempty", sql`length(${table.displayName}) > 0`),
		check("rolls_roll_range", sql`${table.roll} between 1 and 10000`),
		check("rolls_winning_number_range", sql`${table.winningNumber} between 1 and 10000`),
		check(
			"rolls_distance_invariant",
			sql`${table.distance} = abs(${table.roll} - ${table.winningNumber})`,
		),
		check("rolls_winner_invariant", sql`${table.isWinner} = (${table.distance} = 0)`),
	],
);

/** Raffle Leaderboard computed over persisted Rolls. */
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
