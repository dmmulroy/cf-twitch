/**
 * KeyboardRaffleDO - Manages keyboard raffle rolls and leaderboard
 *
 * Tracks individual rolls with winning numbers. Leaderboard stats
 * are computed via a SQLite view over the rolls table.
 */

import { Result, TaggedError } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../../drizzle/keyboard-raffle-do/migrations";
import { rpc, withRpcSerialization } from "../lib/durable-objects";
import { logger } from "../lib/logger";
import * as schema from "./schemas/keyboard-raffle-do.schema";
import {
	type InsertRoll,
	type LeaderboardEntry,
	type Roll,
	raffleLeaderboard,
	rolls,
} from "./schemas/keyboard-raffle-do.schema";

import type { Env } from "../index";
import type { StreamLifecycleHandler } from "../lib/errors";

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

/**
 * Roll not found error (for rollback operations)
 */
export class RollNotFoundError extends TaggedError("RollNotFoundError")<{
	rollId: string;
	message: string;
}>() {
	constructor(args: { rollId: string }) {
		super({ ...args, message: `Roll not found: ${args.rollId}` });
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
export interface LeaderboardOptions {
	sortBy: "rolls" | "wins" | "closest";
	limit?: number;
}

/**
 * KeyboardRaffleDO - Durable Object for keyboard raffle management
 */
class _KeyboardRaffleDO
	extends DurableObject<Env>
	implements StreamLifecycleHandler<KeyboardRaffleDbError>
{
	private db: ReturnType<typeof drizzle<typeof schema>>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });

		void this.ctx.blockConcurrencyWhile(async () => {
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
		rollData: InsertRoll,
	): Promise<Result<{ roll: Roll; isNewRecord: boolean }, KeyboardRaffleDbError>> {
		const result = await Result.tryPromise({
			try: async () => {
				const isWinner = rollData.distance === 0;

				// Get current closest record before inserting (for non-winners)
				let previousBestDistance: number | null = null;
				if (!isWinner) {
					const [currentBest] = await this.db
						.select({ closestDistance: raffleLeaderboard.closestDistance })
						.from(raffleLeaderboard)
						.where(sql`${raffleLeaderboard.closestDistance} > 0`)
						.orderBy(sql`${raffleLeaderboard.closestDistance} asc`)
						.limit(1);
					previousBestDistance = currentBest?.closestDistance ?? null;
				}

				const [recordedRoll] = await this.db
					.insert(rolls)
					.values({
						...rollData,
						isWinner,
					})
					.returning();

				if (!recordedRoll) {
					throw new Error("Insert did not return a row");
				}

				// Determine if this is a new closest record (for non-winners)
				// A roll is a new record if:
				// - It's not a winner (winners have distance 0, which is a different achievement)
				// - Either there was no previous record, OR this distance is smaller
				const isNewRecord =
					!isWinner &&
					(previousBestDistance === null || rollData.distance < previousBestDistance);

				logger.info("Recorded raffle roll", {
					rollId: recordedRoll.id,
					userId: rollData.userId,
					isWinner,
					isNewRecord,
					previousBestDistance,
					distance: rollData.distance,
				});

				return { roll: recordedRoll, isNewRecord };
			},
			catch: (cause) => new KeyboardRaffleDbError({ operation: "recordRoll", cause }),
		});

		if (result.status === "error") {
			logger.error("Failed to record raffle roll", {
				userId: rollData.userId,
				error: result.error.message,
			});
		}

		return result;
	}

	/**
	 * Delete a roll by ID (for rollback support)
	 *
	 * Leaderboard stats update automatically via the view.
	 */
	@rpc
	async deleteRollById(
		rollId: string,
	): Promise<Result<void, KeyboardRaffleDbError | RollNotFoundError>> {
		const result = await Result.tryPromise({
			try: async () => {
				const roll = await this.db.query.rolls.findFirst({
					where: eq(rolls.id, rollId),
				});

				if (!roll) {
					throw new RollNotFoundError({ rollId });
				}

				await this.db.delete(rolls).where(eq(rolls.id, rollId));
				logger.info("Deleted raffle roll", { rollId });
			},
			catch: (cause) => {
				if (RollNotFoundError.is(cause)) {
					return cause;
				}
				return new KeyboardRaffleDbError({ operation: "deleteRollById", cause });
			},
		});

		if (result.status === "error" && !RollNotFoundError.is(result.error)) {
			logger.error("Failed to delete raffle roll", { rollId, error: result.error.message });
		}

		return result;
	}

	/**
	 * Get leaderboard entries sorted by specified criteria
	 */
	@rpc
	async getLeaderboard(
		options: LeaderboardOptions,
	): Promise<Result<LeaderboardEntry[], KeyboardRaffleDbError>> {
		const result = await Result.tryPromise({
			try: async () => {
				const orderByClause = (() => {
					switch (options.sortBy) {
						case "rolls":
							return desc(raffleLeaderboard.totalRolls);
						case "wins":
							return desc(raffleLeaderboard.totalWins);
						case "closest":
							// Sort by closest distance (nulls last for winners)
							return sql`${raffleLeaderboard.closestDistance} asc nulls last`;
					}
				})();

				return this.db
					.select()
					.from(raffleLeaderboard)
					.orderBy(orderByClause)
					.limit(options.limit ?? 10);
			},
			catch: (cause) => new KeyboardRaffleDbError({ operation: "getLeaderboard", cause }),
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
	): Promise<Result<LeaderboardEntry, KeyboardRaffleDbError | UserStatsNotFoundError>> {
		const result = await Result.tryPromise({
			try: async () => {
				const [entry] = await this.db
					.select()
					.from(raffleLeaderboard)
					.where(eq(raffleLeaderboard.userId, userId))
					.limit(1);

				if (!entry) {
					throw new UserStatsNotFoundError({ userId });
				}

				return entry;
			},
			catch: (cause) => {
				if (UserStatsNotFoundError.is(cause)) {
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
	): Promise<Result<LeaderboardEntry, KeyboardRaffleDbError | UserStatsNotFoundError>> {
		const result = await Result.tryPromise({
			try: async () => {
				const [entry] = await this.db
					.select()
					.from(raffleLeaderboard)
					.where(eq(raffleLeaderboard.displayName, displayName))
					.limit(1);

				if (!entry) {
					throw new UserStatsNotFoundError({ userId: displayName });
				}

				return entry;
			},
			catch: (cause) => {
				if (UserStatsNotFoundError.is(cause)) {
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
		Result<{ userId: string; displayName: string; distance: number } | null, KeyboardRaffleDbError>
	> {
		return Result.tryPromise({
			try: async () => {
				// Get the top entry sorted by closest distance (excluding winners)
				const [entry] = await this.db
					.select()
					.from(raffleLeaderboard)
					.where(sql`${raffleLeaderboard.closestDistance} > 0`)
					.orderBy(sql`${raffleLeaderboard.closestDistance} asc`)
					.limit(1);

				if (!entry || entry.closestDistance === null) {
					return null;
				}

				return {
					userId: entry.userId,
					displayName: entry.displayName,
					distance: entry.closestDistance,
				};
			},
			catch: (cause) => new KeyboardRaffleDbError({ operation: "getClosestRecord", cause }),
		});
	}

	/**
	 * Lifecycle: Called when stream goes online
	 */
	@rpc
	async onStreamOnline(): Promise<Result<void, KeyboardRaffleDbError>> {
		logger.info("KeyboardRaffleDO: Stream online");
		// No-op for now - raffle runs regardless of stream state
		return Result.ok();
	}

	/**
	 * Lifecycle: Called when stream goes offline
	 */
	@rpc
	async onStreamOffline(): Promise<Result<void, KeyboardRaffleDbError>> {
		logger.info("KeyboardRaffleDO: Stream offline");
		// No-op for now - raffle runs regardless of stream state
		return Result.ok();
	}
}

export const KeyboardRaffleDO = withRpcSerialization(_KeyboardRaffleDO);
