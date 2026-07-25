/** Keyboard Raffle Roll persistence schemas and Raffle Leaderboard view. */

import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, sqliteView, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

const RaffleIdentifierSchema = z.string().trim().min(1).max(200);
const RaffleNumberSchema = z.number().int().min(1).max(10_000);
const RaffleDistanceSchema = z.number().int().min(0).max(9_999);

/** RPC input for recording a Roll; Distance and win status are derived by KeyboardRaffleDO. */
export const RecordRaffleRollInputSchema = z.strictObject({
	id: RaffleIdentifierSchema,
	userId: RaffleIdentifierSchema,
	displayName: z.string().trim().min(1).max(100),
	roll: RaffleNumberSchema,
	winningNumber: RaffleNumberSchema,
	rolledAt: z.iso.datetime({ offset: true }),
});

/** Parsed input for recording exactly one Keyboard Raffle Roll. */
export type RecordRaffleRollInput = z.infer<typeof RecordRaffleRollInputSchema>;

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
		check("rolls_distance_invariant", sql`${table.distance} = abs(${table.roll} - ${table.winningNumber})`),
		check("rolls_winner_invariant", sql`${table.isWinner} = (${table.distance} = 0)`),
	],
);

/** Runtime parser for serialized Roll rows read from SQLite. */
export const RollSchema = z.strictObject({
	id: RaffleIdentifierSchema,
	userId: RaffleIdentifierSchema,
	displayName: z.string().trim().min(1).max(100),
	roll: RaffleNumberSchema,
	winningNumber: RaffleNumberSchema,
	distance: RaffleDistanceSchema,
	isWinner: z.boolean(),
	isNewRecord: z.boolean(),
	rolledAt: z.iso.datetime({ offset: true }),
});

/** Parsed persisted Keyboard Raffle Roll. */
export type Roll = z.infer<typeof RollSchema>;

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

/** Runtime parser for serialized Raffle Leaderboard projections read from SQLite. */
export const LeaderboardEntrySchema = z.strictObject({
	userId: RaffleIdentifierSchema,
	displayName: z.string().trim().min(1).max(100),
	totalRolls: z.number().int().positive(),
	totalWins: z.number().int().nonnegative(),
	closestDistance: RaffleDistanceSchema.nullable(),
	closestRoll: RaffleNumberSchema.nullable(),
	closestWinningNumber: RaffleNumberSchema.nullable(),
	lastRolledAt: z.iso.datetime({ offset: true }),
});

/** Parsed Raffle Leaderboard entry. */
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;
