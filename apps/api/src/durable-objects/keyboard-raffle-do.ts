/**
 * KeyboardRaffleDO - Manages keyboard raffle rolls and leaderboard
 *
 * Tracks individual rolls with winning numbers. Leaderboard stats
 * are computed via a SQLite view over the rolls table.
 */

import { Agent, type AgentContext } from "agents";
import { Result, TaggedError } from "better-result";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/keyboard-raffle-do/migrations";
import { rpc, withRpcSerialization } from "../lib/durable-objects";
import { logger } from "../lib/logger";
import * as schema from "./schemas/keyboard-raffle-do.schema";
import {
	LeaderboardEntrySchema,
	RecordRaffleRollInputSchema,
	RollSchema,
	type LeaderboardEntry,
	type Roll,
	raffleLeaderboard,
	rolls,
} from "./schemas/keyboard-raffle-do.schema";

import type { Env } from "../index";

/**
 * Database error for keyboard raffle operations
 */
export class KeyboardRaffleDbError extends TaggedError("KeyboardRaffleDbError")<{
	operation: string;
	message: string;
	cause?: unknown;
}>() {
	constructor(args: { operation: string; cause?: unknown }) {
		super({
			operation: args.operation,
			message: `Keyboard raffle DB error during ${args.operation}`,
			cause: args.cause,
		});
	}
}

/** RPC or query input failed Keyboard Raffle boundary parsing. */
export class KeyboardRaffleInputParseError extends TaggedError("KeyboardRaffleInputParseError")<{
	operation: string;
	issues: string;
	message: string;
}>() {
	constructor(args: { operation: string; issues: string }) {
		super({
			...args,
			message: `Keyboard Raffle input invalid during ${args.operation}: ${args.issues}`,
		});
	}
}

/** A stable Roll id was replayed with different immutable Roll evidence. */
export class RollIdempotencyConflictError extends TaggedError("RollIdempotencyConflictError")<{
	rollId: string;
	message: string;
}>() {
	constructor(args: { rollId: string }) {
		super({ ...args, message: `Roll idempotency conflict for ${args.rollId}` });
	}
}

/** Serialized Keyboard Raffle data failed runtime parsing after a SQLite read. */
export class KeyboardRaffleDataParseError extends TaggedError("KeyboardRaffleDataParseError")<{
	operation: string;
	issues: string;
	message: string;
}>() {
	constructor(args: { operation: string; issues: string }) {
		super({
			...args,
			message: `Keyboard Raffle persisted data invalid during ${args.operation}: ${args.issues}`,
		});
	}
}

/**
 * User stats not found error
 */
export class UserStatsNotFoundError extends TaggedError("UserStatsNotFoundError")<{
	userId: string;
	message: string;
}>() {
	constructor(args: { userId: string }) {
		super({ ...args, message: `No stats found for user: ${args.userId}` });
	}
}

/**
 * Leaderboard query options
 */
export const LeaderboardOptionsSchema = z.strictObject({
	sortBy: z.enum(["rolls", "wins", "closest"]),
	limit: z.number().int().positive().max(100).optional(),
});

/** Parsed bounded query options for the Raffle Leaderboard. */
export type LeaderboardOptions = z.infer<typeof LeaderboardOptionsSchema>;

/**
 * KeyboardRaffleDO - Agent-based durable object for keyboard raffle management.
 *
 * SQLite remains the source of truth because this DO is query/history oriented.
 * Agent lifecycle is used for startup/bootstrap only.
 */
class _KeyboardRaffleDO extends Agent<Env> {
	private db: ReturnType<typeof drizzle<typeof schema>>;

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });
	}

	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	/**
	 * Record a new raffle roll
	 *
	 * Leaderboard stats are computed automatically via the view.
	 * Returns the roll and whether it set a new closest record (for non-winners only).
	 */
	@rpc
	async recordRoll(
		rawInput: unknown,
	): Promise<
		Result<
			{ roll: Roll; isNewRecord: boolean },
			| KeyboardRaffleInputParseError
			| KeyboardRaffleDataParseError
			| RollIdempotencyConflictError
			| KeyboardRaffleDbError
		>
	> {
		const inputResult = RecordRaffleRollInputSchema.safeParse(rawInput);
		if (!inputResult.success) {
			return Result.err(
				new KeyboardRaffleInputParseError({
					operation: "recordRoll",
					issues: inputResult.error.message,
				}),
			);
		}
		const input = inputResult.data;
		return Result.tryPromise({
			try: () =>
				this.db.transaction(async (tx) => {
					const existingRow = await tx.query.rolls.findFirst({
						where: eq(rolls.id, input.id),
					});
					if (existingRow !== undefined) {
						const existing = RollSchema.safeParse(existingRow);
						if (!existing.success) {
							throw new KeyboardRaffleDataParseError({
								operation: "recordRollReplay",
								issues: existing.error.message,
							});
						}
						if (
							existing.data.userId !== input.userId ||
							existing.data.displayName !== input.displayName ||
							existing.data.roll !== input.roll ||
							existing.data.winningNumber !== input.winningNumber ||
							existing.data.rolledAt !== input.rolledAt
						) {
							throw new RollIdempotencyConflictError({ rollId: input.id });
						}
						return { roll: existing.data, isNewRecord: existing.data.isNewRecord };
					}

					const distance = Math.abs(input.roll - input.winningNumber);
					const isWinner = distance === 0;
					let previousBestDistance: number | null = null;
					if (!isWinner) {
						const [currentBest] = await tx
							.select({ closestDistance: raffleLeaderboard.closestDistance })
							.from(raffleLeaderboard)
							.where(sql`${raffleLeaderboard.closestDistance} > 0`)
							.orderBy(sql`${raffleLeaderboard.closestDistance} asc`)
							.limit(1);
						previousBestDistance = currentBest?.closestDistance ?? null;
					}
					const isNewRecord =
						!isWinner && (previousBestDistance === null || distance < previousBestDistance);
					const [recordedRow] = await tx
						.insert(rolls)
						.values({ ...input, distance, isWinner, isNewRecord })
						.returning();
					const recorded = RollSchema.safeParse(recordedRow);
					if (!recorded.success) {
						throw new KeyboardRaffleDataParseError({
							operation: "recordRoll",
							issues: recorded.error.message,
						});
					}
					logger.info("Recorded raffle roll", {
						rollId: recorded.data.id,
						userId: input.userId,
						isWinner,
						isNewRecord,
						previousBestDistance,
						distance,
					});
					return { roll: recorded.data, isNewRecord };
				}),
			catch: (cause) => {
				if (KeyboardRaffleDataParseError.is(cause) || RollIdempotencyConflictError.is(cause)) {
					return cause;
				}
				return new KeyboardRaffleDbError({ operation: "recordRoll", cause });
			},
		});
	}

	/**
	 * Delete a roll by ID (for rollback support)
	 *
	 * Leaderboard stats update automatically via the view.
	 */
	@rpc
	async deleteRollById(
		rollId: string,
	): Promise<Result<void, KeyboardRaffleDbError | KeyboardRaffleDataParseError>> {
		const result = await Result.tryPromise({
			try: async () => {
				const roll = await this.db.query.rolls.findFirst({
					where: eq(rolls.id, rollId),
				});

				if (!roll) {
					logger.info("Raffle Roll deletion replay found no persisted Roll", { rollId });
					return;
				}
				const parsedRoll = RollSchema.safeParse(roll);
				if (!parsedRoll.success) {
					throw new KeyboardRaffleDataParseError({
						operation: "deleteRollById",
						issues: parsedRoll.error.message,
					});
				}

				await this.db.delete(rolls).where(eq(rolls.id, rollId));
				logger.info("Deleted raffle roll", { rollId });
			},
			catch: (cause) => {
				if (KeyboardRaffleDataParseError.is(cause)) return cause;
				return new KeyboardRaffleDbError({ operation: "deleteRollById", cause });
			},
		});

		if (result.status === "error") {
			logger.error("Failed to delete raffle roll", { rollId, error: result.error.message });
		}

		return result;
	}

	/**
	 * Get leaderboard entries sorted by specified criteria
	 */
	@rpc
	async getLeaderboard(
		rawOptions: unknown,
	): Promise<
		Result<
			LeaderboardEntry[],
			KeyboardRaffleInputParseError | KeyboardRaffleDataParseError | KeyboardRaffleDbError
		>
	> {
		const optionsResult = LeaderboardOptionsSchema.safeParse(rawOptions);
		if (!optionsResult.success) {
			return Result.err(
				new KeyboardRaffleInputParseError({
					operation: "getLeaderboard",
					issues: optionsResult.error.message,
				}),
			);
		}
		const options = optionsResult.data;
		const result = await Result.tryPromise({
			try: async () => {
				const orderByClause = (() => {
					switch (options.sortBy) {
						case "rolls":
							return desc(raffleLeaderboard.totalRolls);
						case "wins":
							return desc(raffleLeaderboard.totalWins);
						case "closest":
							return sql`${raffleLeaderboard.closestDistance} asc nulls last`;
					}
				})();

				const rows = await this.db
					.select()
					.from(raffleLeaderboard)
					.orderBy(orderByClause)
					.limit(options.limit ?? 10);
				const parsed = z.array(LeaderboardEntrySchema).safeParse(rows);
				if (!parsed.success) {
					throw new KeyboardRaffleDataParseError({
						operation: "getLeaderboard",
						issues: parsed.error.message,
					});
				}
				return parsed.data;
			},
			catch: (cause) =>
				KeyboardRaffleDataParseError.is(cause)
					? cause
					: new KeyboardRaffleDbError({ operation: "getLeaderboard", cause }),
		});

		if (result.status === "error") {
			logger.error("Failed to get raffle leaderboard", {
				sortBy: options.sortBy,
				error: result.error.message,
			});
		}

		return result;
	}

	/**
	 * Get stats for a user by their Twitch user ID
	 *
	 * Returns aggregated stats from the leaderboard view.
	 */
	@rpc
	async getUserStats(
		userId: string,
	): Promise<
		Result<
			LeaderboardEntry,
			KeyboardRaffleDbError | KeyboardRaffleDataParseError | UserStatsNotFoundError
		>
	> {
		const result = await Result.tryPromise({
			try: async () => {
				const [entry] = await this.db
					.select()
					.from(raffleLeaderboard)
					.where(eq(raffleLeaderboard.userId, userId))
					.limit(1);

				if (!entry) throw new UserStatsNotFoundError({ userId });
				const parsed = LeaderboardEntrySchema.safeParse(entry);
				if (!parsed.success) {
					throw new KeyboardRaffleDataParseError({
						operation: "getUserStats",
						issues: parsed.error.message,
					});
				}
				return parsed.data;
			},
			catch: (cause) => {
				if (UserStatsNotFoundError.is(cause) || KeyboardRaffleDataParseError.is(cause)) {
					return cause;
				}
				return new KeyboardRaffleDbError({ operation: "getUserStats", cause });
			},
		});

		if (result.status === "error" && !UserStatsNotFoundError.is(result.error)) {
			logger.error("Failed to get user raffle stats", { userId, error: result.error.message });
		}

		return result;
	}

	/**
	 * Get stats for a user by display name
	 *
	 * Used for !stats <user> command where we only have the display name.
	 */
	@rpc
	async getUserStatsByDisplayName(
		displayName: string,
	): Promise<
		Result<
			LeaderboardEntry,
			KeyboardRaffleDbError | KeyboardRaffleDataParseError | UserStatsNotFoundError
		>
	> {
		const result = await Result.tryPromise({
			try: async () => {
				const [entry] = await this.db
					.select()
					.from(raffleLeaderboard)
					.where(eq(raffleLeaderboard.displayName, displayName))
					.limit(1);

				if (!entry) throw new UserStatsNotFoundError({ userId: displayName });
				const parsed = LeaderboardEntrySchema.safeParse(entry);
				if (!parsed.success) {
					throw new KeyboardRaffleDataParseError({
						operation: "getUserStatsByDisplayName",
						issues: parsed.error.message,
					});
				}
				return parsed.data;
			},
			catch: (cause) => {
				if (UserStatsNotFoundError.is(cause) || KeyboardRaffleDataParseError.is(cause)) {
					return cause;
				}
				return new KeyboardRaffleDbError({ operation: "getUserStatsByDisplayName", cause });
			},
		});

		if (result.status === "error" && !UserStatsNotFoundError.is(result.error)) {
			logger.error("Failed to get user raffle stats by display name", {
				displayName,
				error: result.error.message,
			});
		}

		return result;
	}

	/**
	 * Get the global closest non-winning roll record
	 *
	 * Returns the user with the smallest non-zero distance (closest without winning).
	 */
	@rpc
	async getClosestRecord(): Promise<
		Result<
			{ userId: string; displayName: string; distance: number } | null,
			KeyboardRaffleDataParseError | KeyboardRaffleDbError
		>
	> {
		return Result.tryPromise({
			try: async () => {
				const [entry] = await this.db
					.select()
					.from(raffleLeaderboard)
					.where(sql`${raffleLeaderboard.closestDistance} > 0`)
					.orderBy(sql`${raffleLeaderboard.closestDistance} asc`)
					.limit(1);

				if (!entry) return null;
				const parsed = LeaderboardEntrySchema.safeParse(entry);
				if (!parsed.success) {
					throw new KeyboardRaffleDataParseError({
						operation: "getClosestRecord",
						issues: parsed.error.message,
					});
				}
				if (parsed.data.closestDistance === null) return null;
				return {
					userId: parsed.data.userId,
					displayName: parsed.data.displayName,
					distance: parsed.data.closestDistance,
				};
			},
			catch: (cause) =>
				KeyboardRaffleDataParseError.is(cause)
					? cause
					: new KeyboardRaffleDbError({ operation: "getClosestRecord", cause }),
		});
	}
}

export const KeyboardRaffleDO = withRpcSerialization(_KeyboardRaffleDO);
