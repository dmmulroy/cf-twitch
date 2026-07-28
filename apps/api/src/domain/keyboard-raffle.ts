import { z } from "zod";

/** Runtime parser for stable Keyboard Raffle and Viewer identifiers. */
export const KeyboardRaffleIdentifierSchema = z.string().trim().min(1).max(200);
/** Runtime parser for one Keyboard Raffle number. */
export const KeyboardRaffleNumberSchema = z.number().int().min(1).max(10_000);
/** Runtime parser for the Distance between a Roll and its Winning Number. */
export const KeyboardRaffleDistanceSchema = z.number().int().min(0).max(9_999);

/** Runtime parser for recording one Keyboard Raffle Roll. */
export const RecordKeyboardRaffleRollSchema = z.strictObject({
	id: KeyboardRaffleIdentifierSchema,
	userId: KeyboardRaffleIdentifierSchema,
	displayName: z.string().trim().min(1).max(100),
	roll: KeyboardRaffleNumberSchema,
	winningNumber: KeyboardRaffleNumberSchema,
	rolledAt: z.iso.datetime({ offset: true }),
});

/** Parsed input for recording exactly one Keyboard Raffle Roll. */
export type RecordKeyboardRaffleRoll = z.infer<typeof RecordKeyboardRaffleRollSchema>;

/** Runtime parser for one persisted Keyboard Raffle Roll. */
export const KeyboardRaffleRollSchema = RecordKeyboardRaffleRollSchema.extend({
	distance: KeyboardRaffleDistanceSchema,
	isWinner: z.boolean(),
	isNewRecord: z.boolean(),
});

/** Parsed Keyboard Raffle Roll with derived Distance and win evidence. */
export type KeyboardRaffleRoll = z.infer<typeof KeyboardRaffleRollSchema>;

/** Runtime parser for one Raffle Leaderboard entry. */
export const RaffleLeaderboardEntrySchema = z.strictObject({
	userId: KeyboardRaffleIdentifierSchema,
	displayName: z.string().trim().min(1).max(100),
	totalRolls: z.number().int().positive(),
	totalWins: z.number().int().nonnegative(),
	closestDistance: KeyboardRaffleDistanceSchema.nullable(),
	closestRoll: KeyboardRaffleNumberSchema.nullable(),
	closestWinningNumber: KeyboardRaffleNumberSchema.nullable(),
	lastRolledAt: z.iso.datetime({ offset: true }),
});

/** Aggregated Keyboard Raffle statistics for one Viewer. */
export type RaffleLeaderboardEntry = z.infer<typeof RaffleLeaderboardEntrySchema>;

/** Runtime parser for a bounded Raffle Leaderboard. */
export const RaffleLeaderboardSchema = z.array(RaffleLeaderboardEntrySchema).max(100);

/** Sort order supported by the Raffle Leaderboard. */
export type RaffleLeaderboardSort = "rolls" | "wins" | "closest";

/** Bounded query for Raffle Leaderboard statistics. */
export type RaffleLeaderboardQuery = Readonly<{
	sortBy: RaffleLeaderboardSort;
	limit: number;
}>;
