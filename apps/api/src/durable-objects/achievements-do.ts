/**
 * AchievementsDO - Tracks per-user achievement progress and unlocks
 *
 * Achievements are triggered by events from workflows (song requests, raffles, etc.).
 * Progress is tracked and unlocks are recorded with timestamps for chat announcements.
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { and, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/achievements-do/migrations";
import { writeAchievementUnlockMetric } from "../lib/analytics";
import {
	AchievementDbError,
	type AchievementError,
	type StreamLifecycleHandler,
} from "../lib/errors";
import { logger } from "../lib/logger";
import * as schema from "./schemas/achievements-do.schema";
import {
	type AchievementDefinition,
	achievementDefinitions,
	userAchievements,
} from "./schemas/achievements-do.schema";

import type { Env } from "../index";

// =============================================================================
// Types
// =============================================================================

/** Achievement trigger event types */
export type TriggerEvent =
	| "song_request"
	| "stream_first_request"
	| "raffle_roll"
	| "raffle_win"
	| "raffle_close"
	| "raffle_closest_record"
	| "request_streak";

/** Achievement categories */
export type AchievementCategory = "song_request" | "raffle" | "engagement" | "special";

/** Zod schema for validating category from DB */
const AchievementCategorySchema = z.enum(["song_request", "raffle", "engagement", "special"]);

/** Achievement scope - determines reset behavior */
export type AchievementScope = "session" | "cumulative";

/** Input schema for recordEvent - validated with Zod */
export const AchievementEventInputSchema = z.object({
	userDisplayName: z.string().min(1),
	event: z.enum([
		"song_request",
		"stream_first_request",
		"raffle_roll",
		"raffle_win",
		"raffle_close",
		"raffle_closest_record",
		"request_streak",
	]),
	eventId: z.string().min(1), // idempotency key
	increment: z.number().int().positive().optional().default(1),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AchievementEventInput = z.infer<typeof AchievementEventInputSchema>;

/** Unlocked achievement returned from recordEvent */
export interface UnlockedAchievement {
	id: string;
	name: string;
	description: string;
	icon: string;
	category: AchievementCategory;
	unlockedAt: string;
}

/** Achievement progress for a user */
export interface UserAchievementProgress {
	achievementId: string;
	name: string;
	description: string;
	icon: string;
	category: AchievementCategory;
	threshold: number | null;
	progress: number;
	unlocked: boolean;
	unlockedAt: string | null;
}

/** Unannounced achievement with user info */
export interface UnannouncedAchievement {
	userDisplayName: string;
	achievement: UnlockedAchievement;
}

/** Leaderboard entry */
export interface LeaderboardEntry {
	userDisplayName: string;
	count: number;
}

/** Leaderboard query options */
export interface LeaderboardOptions {
	limit?: number;
}

// =============================================================================
// AchievementsDO Implementation
// =============================================================================

/**
 * AchievementsDO - Durable Object for tracking user achievements
 */
export class AchievementsDO
	extends DurableObject<Env>
	implements StreamLifecycleHandler<AchievementDbError>
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
	 * Record an achievement event for a user
	 *
	 * Increments progress for all matching achievements and returns any newly unlocked.
	 * Uses eventId for idempotency on event-based achievements.
	 */
	async recordEvent(
		input: AchievementEventInput,
	): Promise<Result<UnlockedAchievement[], AchievementError>> {
		// Validate input with Zod
		const parseResult = AchievementEventInputSchema.safeParse(input);
		if (!parseResult.success) {
			return Result.err(
				new AchievementDbError({
					operation: "recordEvent",
					cause: parseResult.error,
				}),
			);
		}

		const { userDisplayName, event, eventId, increment, metadata } = parseResult.data;

		return Result.tryPromise({
			try: async () => {
				// Find all achievement definitions that match this event
				const matchingDefinitions = await this.db.query.achievementDefinitions.findMany({
					where: eq(achievementDefinitions.triggerEvent, event),
				});

				if (matchingDefinitions.length === 0) {
					logger.debug("No achievements match event", { event });
					return [];
				}

				const newlyUnlocked: UnlockedAchievement[] = [];
				const now = new Date().toISOString();

				for (const definition of matchingDefinitions) {
					// Check if this user+achievement combo exists
					let userAchievement = await this.db.query.userAchievements.findFirst({
						where: and(
							eq(userAchievements.userDisplayName, userDisplayName),
							eq(userAchievements.achievementId, definition.id),
						),
					});

					// For event-based achievements (null threshold), check idempotency
					if (definition.threshold === null && userAchievement?.eventId === eventId) {
						logger.debug("Skipping duplicate event-based achievement", {
							achievementId: definition.id,
							eventId,
						});
						continue;
					}

					// For threshold-based already unlocked, skip
					if (userAchievement?.unlockedAt !== null && definition.threshold !== null) {
						continue;
					}

					// Calculate new progress
					const effectiveIncrement = this.calculateIncrement(definition, increment, metadata);
					const currentProgress = userAchievement?.progress ?? 0;
					const newProgress = currentProgress + effectiveIncrement;

					// Determine if this unlocks the achievement
					const shouldUnlock = this.shouldUnlock(definition, newProgress);

					if (!userAchievement) {
						// Create new user achievement record
						const id = crypto.randomUUID();
						await this.db.insert(userAchievements).values({
							id,
							userDisplayName,
							achievementId: definition.id,
							progress: newProgress,
							unlockedAt: shouldUnlock ? now : null,
							announced: false,
							eventId: definition.threshold === null ? eventId : null,
						});
					} else {
						// Update existing record
						await this.db
							.update(userAchievements)
							.set({
								progress: newProgress,
								unlockedAt:
									shouldUnlock && !userAchievement.unlockedAt ? now : userAchievement.unlockedAt,
								eventId: definition.threshold === null ? eventId : userAchievement.eventId,
							})
							.where(eq(userAchievements.id, userAchievement.id));
					}

					// Track newly unlocked
					if (shouldUnlock && (!userAchievement || !userAchievement.unlockedAt)) {
						newlyUnlocked.push({
							id: definition.id,
							name: definition.name,
							description: definition.description,
							icon: definition.icon,
							category: AchievementCategorySchema.parse(definition.category),
							unlockedAt: now,
						});

						logger.info("Achievement unlocked", {
							userDisplayName,
							achievementId: definition.id,
							achievementName: definition.name,
						});

						writeAchievementUnlockMetric(this.env.ANALYTICS, {
							user: userDisplayName,
							achievementId: definition.id,
							achievementName: definition.name,
							category: definition.category,
						});
					}
				}

				return newlyUnlocked;
			},
			catch: (cause) => new AchievementDbError({ operation: "recordEvent", cause }),
		});
	}

	/**
	 * Get all achievements with user's progress
	 */
	async getUserAchievements(
		userDisplayName: string,
	): Promise<Result<UserAchievementProgress[], AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				// Get all definitions
				const definitions = await this.db.query.achievementDefinitions.findMany();

				// Get user's progress for all achievements
				const userProgress = await this.db.query.userAchievements.findMany({
					where: eq(userAchievements.userDisplayName, userDisplayName),
				});

				// Map user progress by achievement ID
				const progressMap = new Map(userProgress.map((p) => [p.achievementId, p]));

				return definitions.map((def) => {
					const progress = progressMap.get(def.id);
					return {
						achievementId: def.id,
						name: def.name,
						description: def.description,
						icon: def.icon,
						category: AchievementCategorySchema.parse(def.category),
						threshold: def.threshold,
						progress: progress?.progress ?? 0,
						unlocked: progress?.unlockedAt !== null && progress?.unlockedAt !== undefined,
						unlockedAt: progress?.unlockedAt ?? null,
					};
				});
			},
			catch: (cause) => new AchievementDbError({ operation: "getUserAchievements", cause }),
		});
	}

	/**
	 * Get only unlocked achievements for a user
	 */
	async getUnlockedAchievements(
		userDisplayName: string,
	): Promise<Result<UnlockedAchievement[], AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				const results = await this.db
					.select({
						id: achievementDefinitions.id,
						name: achievementDefinitions.name,
						description: achievementDefinitions.description,
						icon: achievementDefinitions.icon,
						category: achievementDefinitions.category,
						unlockedAt: userAchievements.unlockedAt,
					})
					.from(userAchievements)
					.innerJoin(
						achievementDefinitions,
						eq(userAchievements.achievementId, achievementDefinitions.id),
					)
					.where(
						and(
							eq(userAchievements.userDisplayName, userDisplayName),
							isNotNull(userAchievements.unlockedAt),
						),
					)
					.orderBy(desc(userAchievements.unlockedAt));

				return results.flatMap((r) =>
					r.unlockedAt === null
						? []
						: [
								{
									id: r.id,
									name: r.name,
									description: r.description,
									icon: r.icon,
									category: AchievementCategorySchema.parse(r.category),
									unlockedAt: r.unlockedAt,
								},
							],
				);
			},
			catch: (cause) => new AchievementDbError({ operation: "getUnlockedAchievements", cause }),
		});
	}

	/**
	 * Get all achievement definitions
	 */
	async getDefinitions(): Promise<Result<AchievementDefinition[], AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				return this.db.query.achievementDefinitions.findMany();
			},
			catch: (cause) => new AchievementDbError({ operation: "getDefinitions", cause }),
		});
	}

	/**
	 * Get unlocked but unannounced achievements (for chat bot)
	 */
	async getUnannounced(): Promise<Result<UnannouncedAchievement[], AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				const results = await this.db
					.select({
						userDisplayName: userAchievements.userDisplayName,
						id: achievementDefinitions.id,
						name: achievementDefinitions.name,
						description: achievementDefinitions.description,
						icon: achievementDefinitions.icon,
						category: achievementDefinitions.category,
						unlockedAt: userAchievements.unlockedAt,
					})
					.from(userAchievements)
					.innerJoin(
						achievementDefinitions,
						eq(userAchievements.achievementId, achievementDefinitions.id),
					)
					.where(and(isNotNull(userAchievements.unlockedAt), eq(userAchievements.announced, false)))
					.orderBy(userAchievements.unlockedAt);

				return results.flatMap((r) =>
					r.unlockedAt === null
						? []
						: [
								{
									userDisplayName: r.userDisplayName,
									achievement: {
										id: r.id,
										name: r.name,
										description: r.description,
										icon: r.icon,
										category: AchievementCategorySchema.parse(r.category),
										unlockedAt: r.unlockedAt,
									},
								},
							],
				);
			},
			catch: (cause) => new AchievementDbError({ operation: "getUnannounced", cause }),
		});
	}

	/**
	 * Mark an achievement as announced
	 *
	 * Returns true if this call did the update, false if already announced.
	 * Atomic check prevents duplicate announcements.
	 */
	async markAnnounced(
		userDisplayName: string,
		achievementId: string,
	): Promise<Result<boolean, AchievementError>> {
		return Result.tryPromise({
			try: async () => {
				// Atomic update with condition
				const result = await this.db
					.update(userAchievements)
					.set({ announced: true })
					.where(
						and(
							eq(userAchievements.userDisplayName, userDisplayName),
							eq(userAchievements.achievementId, achievementId),
							eq(userAchievements.announced, false),
							isNotNull(userAchievements.unlockedAt),
						),
					)
					.returning({ id: userAchievements.id });

				return result.length > 0;
			},
			catch: (cause) => new AchievementDbError({ operation: "markAnnounced", cause }),
		});
	}

	/**
	 * Get leaderboard of users by achievement unlock count
	 */
	async getLeaderboard(
		options?: LeaderboardOptions,
	): Promise<Result<LeaderboardEntry[], AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				const limit = options?.limit ?? 10;

				const results = await this.db
					.select({
						userDisplayName: userAchievements.userDisplayName,
						count: count(userAchievements.id),
					})
					.from(userAchievements)
					.where(isNotNull(userAchievements.unlockedAt))
					.groupBy(userAchievements.userDisplayName)
					.orderBy(desc(count(userAchievements.id)))
					.limit(limit);

				return results;
			},
			catch: (cause) => new AchievementDbError({ operation: "getLeaderboard", cause }),
		});
	}

	/**
	 * Lifecycle: Called when stream goes online
	 *
	 * Resets session-scoped achievements (e.g., "Stream Opener", streaks)
	 */
	async onStreamOnline(): Promise<Result<void, AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				// Get session-scoped achievement IDs
				const sessionAchievements = await this.db.query.achievementDefinitions.findMany({
					where: eq(achievementDefinitions.scope, "session"),
					columns: { id: true },
				});

				const sessionIds = sessionAchievements.map((a) => a.id);

				if (sessionIds.length === 0) {
					logger.info("AchievementsDO: No session achievements to reset");
					return;
				}

				// Reset progress and unlock status for session achievements in single query
				await this.db
					.update(userAchievements)
					.set({
						progress: 0,
						unlockedAt: null,
						announced: false,
						eventId: null,
					})
					.where(inArray(userAchievements.achievementId, sessionIds));

				logger.info("AchievementsDO: Reset session achievements", {
					count: sessionIds.length,
					achievementIds: sessionIds,
				});
			},
			catch: (cause) => new AchievementDbError({ operation: "onStreamOnline", cause }),
		});
	}

	/**
	 * Lifecycle: Called when stream goes offline
	 */
	async onStreamOffline(): Promise<Result<void, AchievementDbError>> {
		logger.info("AchievementsDO: Stream offline");
		// No cleanup needed on stream end
		return Result.ok();
	}

	// =============================================================================
	// Private Helpers
	// =============================================================================

	/**
	 * Calculate effective increment based on achievement type and metadata
	 */
	private calculateIncrement(
		definition: AchievementDefinition,
		baseIncrement: number,
		metadata?: Record<string, unknown>,
	): number {
		// For streak achievements, use the streak count from metadata
		if (definition.triggerEvent === "request_streak" && metadata?.streakCount) {
			const streakCount = metadata.streakCount;
			if (typeof streakCount === "number") {
				return streakCount;
			}
		}

		return baseIncrement;
	}

	/**
	 * Determine if achievement should unlock based on progress
	 */
	private shouldUnlock(definition: AchievementDefinition, progress: number): boolean {
		// Event-based achievements (null threshold) unlock on first event
		if (definition.threshold === null) {
			return progress >= 1;
		}

		// Threshold-based achievements unlock when progress reaches threshold
		return progress >= definition.threshold;
	}
}
