/**
 * AchievementsDO - Tracks per-user achievement progress and unlocks
 *
 * Achievements are triggered by events from workflows (song requests, raffles, etc.).
 * Progress is tracked and unlocks are recorded with timestamps for chat announcements.
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/achievements-do/migrations";
import { writeAchievementUnlockMetric } from "../lib/analytics";
import { rpc, withRpcSerialization } from "../lib/durable-objects";
import {
	AchievementDbError,
	AchievementEventValidationError,
	type AchievementError,
	type StreamLifecycleHandler,
} from "../lib/errors";
import { logger } from "../lib/logger";
import { TwitchService } from "../services/twitch-service";
import * as schema from "./schemas/achievements-do.schema";
import {
	type AchievementDefinition,
	achievementDefinitions,
	eventHistory,
	userAchievements,
	userStreaks,
} from "./schemas/achievements-do.schema";
import {
	EventSchema,
	EventType,
	type Event,
	type RaffleRollEvent,
	type SongRequestSuccessEvent,
	type StreamOfflineEvent,
	type StreamOnlineEvent,
} from "./schemas/event-bus-do.schema";

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

/** Debug counts for achievements tables */
export interface AchievementDebugTableCounts {
	definitions: number;
	userAchievements: number;
	unlockedAchievements: number;
	userStreaks: number;
	eventHistory: number;
}

/** Debug snapshot for a specific user */
export interface AchievementDebugUserSnapshot {
	requestedUser: string;
	normalizedUser: string;
	exactUserAchievementRows: number;
	caseInsensitiveUserAchievementRows: number;
	exactUnlockedRows: number;
	caseInsensitiveUnlockedRows: number;
	exactStreakRows: number;
	caseInsensitiveStreakRows: number;
	exactEventHistoryRows: number;
	caseInsensitiveEventHistoryRows: number;
	recentEvents: Array<{
		eventId: string;
		eventType: string;
		userId: string;
		userDisplayName: string;
		timestamp: string;
		metadata: string | null;
	}>;
	similarUsers: string[];
}

function normalizeUserDisplayName(value: string): string {
	return value.trim().replace(/^@+/, "").toLowerCase();
}

function normalizeUserDisplayNameLoose(value: string): string {
	return normalizeUserDisplayName(value).replaceAll("_", "");
}

// =============================================================================
// AchievementsDO Implementation
// =============================================================================

/**
 * AchievementsDO - Durable Object for tracking user achievements
 */
class _AchievementsDO
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
	@rpc
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

		return this.recordEventInternal(parseResult.data);
	}

	private async recordEventInternal(
		input: AchievementEventInput,
	): Promise<Result<UnlockedAchievement[], AchievementError>> {
		const { userDisplayName, event, eventId, increment, metadata } = input;

		logger.info("AchievementsDO: recordEvent started", {
			userDisplayName,
			event,
			eventId,
			increment,
		});

		return Result.tryPromise({
			try: async () => {
				// Find all achievement definitions that match this event
				const matchingDefinitions = await this.db.query.achievementDefinitions.findMany({
					where: eq(achievementDefinitions.triggerEvent, event),
				});

				logger.debug("AchievementsDO: Found matching definitions", {
					event,
					count: matchingDefinitions.length,
					definitions: matchingDefinitions.map((d) => d.id),
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
					if (
						userAchievement !== undefined &&
						userAchievement.unlockedAt !== null &&
						definition.threshold !== null
					) {
						continue;
					}

					// Calculate new progress
					// For streak achievements, set progress directly to streak count (not accumulate)
					// For other achievements, accumulate progress normally
					const effectiveIncrement = this.calculateIncrement(definition, increment, metadata);
					const isStreakAchievement = definition.triggerEvent === "request_streak";
					const currentProgress = userAchievement?.progress ?? 0;
					const newProgress = isStreakAchievement
						? effectiveIncrement // SET to streak count
						: currentProgress + effectiveIncrement; // Accumulate for non-streak

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

						// Best-effort chat announcement: fire immediately on unlock
						const announceResult = await Result.tryPromise({
							try: () => this.announceAchievement(userDisplayName, definition),
							catch: (error) => error,
						});

						if (announceResult.isErr()) {
							logger.warn("Failed to announce achievement (RPC error)", {
								userDisplayName,
								achievementId: definition.id,
								error:
									announceResult.error instanceof Error
										? announceResult.error.message
										: String(announceResult.error),
							});
						}
					}
				}

				logger.info("AchievementsDO: recordEvent completed", {
					userDisplayName,
					event,
					newlyUnlocked: newlyUnlocked.length,
					achievementIds: newlyUnlocked.map((a) => a.id),
				});

				return newlyUnlocked;
			},
			catch: (cause) => {
				logger.error("AchievementsDO: recordEvent failed", {
					userDisplayName,
					event,
					eventId,
					error: cause instanceof Error ? cause.message : String(cause),
					stack: cause instanceof Error ? cause.stack : undefined,
				});
				return new AchievementDbError({ operation: "recordEvent", cause });
			},
		});
	}

	/**
	 * Get all achievements with user's progress
	 */
	@rpc
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
	@rpc
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
	@rpc
	async getDefinitions(): Promise<Result<AchievementDefinition[], AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				return this.db.query.achievementDefinitions.findMany();
			},
			catch: (cause) => new AchievementDbError({ operation: "getDefinitions", cause }),
		});
	}

	/**
	 * Debug endpoint: table-level counts for achievements state.
	 */
	@rpc
	async getDebugTableCounts(): Promise<Result<AchievementDebugTableCounts, AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				const [definitionsRow, userAchievementsRow, unlockedRow, userStreaksRow, eventHistoryRow] =
					await Promise.all([
						this.db.select({ count: count() }).from(achievementDefinitions),
						this.db.select({ count: count() }).from(userAchievements),
						this.db
							.select({ count: count() })
							.from(userAchievements)
							.where(isNotNull(userAchievements.unlockedAt)),
						this.db.select({ count: count() }).from(userStreaks),
						this.db.select({ count: count() }).from(eventHistory),
					]);

				return {
					definitions: definitionsRow[0]?.count ?? 0,
					userAchievements: userAchievementsRow[0]?.count ?? 0,
					unlockedAchievements: unlockedRow[0]?.count ?? 0,
					userStreaks: userStreaksRow[0]?.count ?? 0,
					eventHistory: eventHistoryRow[0]?.count ?? 0,
				};
			},
			catch: (cause) => new AchievementDbError({ operation: "getDebugTableCounts", cause }),
		});
	}

	/**
	 * Debug endpoint: detailed per-user snapshot with normalization diagnostics.
	 */
	@rpc
	async getDebugUserSnapshot(
		userDisplayName: string,
	): Promise<Result<AchievementDebugUserSnapshot, AchievementDbError>> {
		const normalizedUser = normalizeUserDisplayName(userDisplayName);
		const normalizedLoose = normalizeUserDisplayNameLoose(userDisplayName);

		return Result.tryPromise({
			try: async () => {
				const [exactUserAchievementRowsResult, exactUnlockedRowsResult, exactStreakRowsResult] =
					await Promise.all([
						this.db
							.select({ count: count() })
							.from(userAchievements)
							.where(eq(userAchievements.userDisplayName, userDisplayName)),
						this.db
							.select({ count: count() })
							.from(userAchievements)
							.where(
								and(
									eq(userAchievements.userDisplayName, userDisplayName),
									isNotNull(userAchievements.unlockedAt),
								),
							),
						this.db
							.select({ count: count() })
							.from(userStreaks)
							.where(eq(userStreaks.userDisplayName, userDisplayName)),
					]);

				const [allAchievementRows, allStreakRows, allEventRows, recentEventRows] = await Promise.all([
					this.db
						.select({
							userDisplayName: userAchievements.userDisplayName,
							unlockedAt: userAchievements.unlockedAt,
						})
						.from(userAchievements),
					this.db.select({ userDisplayName: userStreaks.userDisplayName }).from(userStreaks),
					this.db
						.select({
							userDisplayName: eventHistory.userDisplayName,
							eventId: eventHistory.eventId,
							eventType: eventHistory.eventType,
							userId: eventHistory.userId,
							timestamp: eventHistory.timestamp,
							metadata: eventHistory.metadata,
						})
						.from(eventHistory),
					this.db
						.select({
							eventId: eventHistory.eventId,
							eventType: eventHistory.eventType,
							userId: eventHistory.userId,
							userDisplayName: eventHistory.userDisplayName,
							timestamp: eventHistory.timestamp,
							metadata: eventHistory.metadata,
						})
						.from(eventHistory)
						.orderBy(desc(eventHistory.timestamp))
						.limit(200),
				]);

				const caseInsensitiveUserAchievementRows = allAchievementRows.filter(
					(row) => normalizeUserDisplayName(row.userDisplayName) === normalizedUser,
				).length;

				const caseInsensitiveUnlockedRows = allAchievementRows.filter(
					(row) =>
						normalizeUserDisplayName(row.userDisplayName) === normalizedUser &&
						row.unlockedAt !== null,
				).length;

				const caseInsensitiveStreakRows = allStreakRows.filter(
					(row) => normalizeUserDisplayName(row.userDisplayName) === normalizedUser,
				).length;

				const caseInsensitiveEventHistoryRows = allEventRows.filter(
					(row) => normalizeUserDisplayName(row.userDisplayName) === normalizedUser,
				).length;

				const recentEvents = recentEventRows.filter(
					(row) => normalizeUserDisplayName(row.userDisplayName) === normalizedUser,
				);

				const allKnownUsers = new Set<string>();
				for (const row of allAchievementRows) {
					allKnownUsers.add(row.userDisplayName);
				}
				for (const row of allStreakRows) {
					allKnownUsers.add(row.userDisplayName);
				}
				for (const row of allEventRows) {
					allKnownUsers.add(row.userDisplayName);
				}

				const similarUsers = Array.from(allKnownUsers)
					.filter((name) => {
						const normalizedName = normalizeUserDisplayName(name);
						const normalizedNameLoose = normalizeUserDisplayNameLoose(name);
						return (
							normalizedName === normalizedUser ||
							normalizedNameLoose === normalizedLoose ||
							normalizedName.includes(normalizedUser) ||
							normalizedUser.includes(normalizedName) ||
							normalizedNameLoose.includes(normalizedLoose) ||
							normalizedLoose.includes(normalizedNameLoose)
						);
					})
					.sort((a, b) => a.localeCompare(b))
					.slice(0, 20);

				return {
					requestedUser: userDisplayName,
					normalizedUser,
					exactUserAchievementRows: exactUserAchievementRowsResult[0]?.count ?? 0,
					caseInsensitiveUserAchievementRows,
					exactUnlockedRows: exactUnlockedRowsResult[0]?.count ?? 0,
					caseInsensitiveUnlockedRows,
					exactStreakRows: exactStreakRowsResult[0]?.count ?? 0,
					caseInsensitiveStreakRows,
					exactEventHistoryRows: allEventRows.filter(
						(row) => row.userDisplayName === userDisplayName,
					).length,
					caseInsensitiveEventHistoryRows,
					recentEvents,
					similarUsers,
				};
			},
			catch: (cause) => new AchievementDbError({ operation: "getDebugUserSnapshot", cause }),
		});
	}

	/**
	 * Get unlocked but unannounced achievements (for chat bot)
	 */
	@rpc
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
	@rpc
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
	@rpc
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
	 * Reset one-time cumulative achievements (close_call, closest_ever)
	 *
	 * Deletes user_achievements rows for event-based (NULL threshold) cumulative
	 * achievements, allowing them to be earned again. Session-scoped achievements
	 * (stream_opener) are excluded as they reset automatically on stream start.
	 *
	 * @param userDisplayName - If provided, only reset for this user. Otherwise reset for all users.
	 * @returns Number of rows deleted
	 */
	@rpc
	async resetOneTimeAchievements(
		userDisplayName?: string,
	): Promise<Result<{ deleted: number; achievementIds: string[] }, AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				// Find event-based (NULL threshold) cumulative achievements
				const eventBasedCumulative = await this.db.query.achievementDefinitions.findMany({
					where: and(
						eq(achievementDefinitions.scope, "cumulative"),
						isNull(achievementDefinitions.threshold),
					),
					columns: { id: true },
				});

				const achievementIds = eventBasedCumulative.map((a) => a.id);

				if (achievementIds.length === 0) {
					return { deleted: 0, achievementIds: [] };
				}

				// Build delete query with optional user filter
				const conditions = [inArray(userAchievements.achievementId, achievementIds)];
				if (userDisplayName) {
					conditions.push(eq(userAchievements.userDisplayName, userDisplayName));
				}

				const deleted = await this.db
					.delete(userAchievements)
					.where(and(...conditions))
					.returning({ id: userAchievements.id });

				logger.info("AchievementsDO: Reset one-time achievements", {
					deleted: deleted.length,
					achievementIds,
					userDisplayName: userDisplayName ?? "all",
				});

				return { deleted: deleted.length, achievementIds };
			},
			catch: (cause) => new AchievementDbError({ operation: "resetOneTimeAchievements", cause }),
		});
	}

	/**
	 * Lifecycle: Called when stream goes online
	 *
	 * Resets session-scoped achievements (e.g., "Stream Opener", streaks)
	 * and resets all user session streaks to 0.
	 */
	@rpc
	async onStreamOnline(): Promise<Result<void, AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				const now = new Date().toISOString();

				// Get session-scoped achievement IDs
				const sessionAchievements = await this.db.query.achievementDefinitions.findMany({
					where: eq(achievementDefinitions.scope, "session"),
					columns: { id: true },
				});

				const sessionIds = sessionAchievements.map((a) => a.id);

				if (sessionIds.length > 0) {
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
				}

				// Reset all user session streaks to 0 and update sessionStartedAt
				await this.db.update(userStreaks).set({
					sessionStreak: 0,
					sessionStartedAt: now,
				});

				logger.info("AchievementsDO: Reset all user session streaks");
			},
			catch: (cause) => new AchievementDbError({ operation: "onStreamOnline", cause }),
		});
	}

	/**
	 * Lifecycle: Called when stream goes offline
	 */
	@rpc
	async onStreamOffline(): Promise<Result<void, AchievementDbError>> {
		logger.info("AchievementsDO: Stream offline");
		// No cleanup needed on stream end
		return Result.ok();
	}

	// =============================================================================
	// Event Bus Handler
	// =============================================================================

	/**
	 * Handle events from EventBusDO
	 *
	 * Dispatches events to specific handlers, records to event_history for
	 * "first request of stream" checks and audit trail.
	 */
	@rpc
	async handleEvent(event: unknown): Promise<Result<void, AchievementError>> {
		// Validate event with Zod
		const parseResult = EventSchema.safeParse(event);
		if (!parseResult.success) {
			logger.warn("AchievementsDO: Invalid event format", {
				error: parseResult.error.message,
			});
			return Result.err(
				new AchievementEventValidationError({
					parseError: parseResult.error.message,
				}),
			);
		}

		const validEvent = parseResult.data;

		logger.info("AchievementsDO: Handling event", {
			eventId: validEvent.id,
			eventType: validEvent.type,
			source: validEvent.source,
		});

		// Record to event_history for auditing and "first request" checks
		const recordResult = await this.recordToEventHistory(validEvent);

		if (recordResult.isErr()) {
			return recordResult;
		}

		// Dispatch to specific handler based on event type
		switch (validEvent.type) {
			case EventType.SongRequestSuccess:
				return this.handleSongRequest(validEvent);

			case EventType.RaffleRoll:
				return this.handleRaffleRoll(validEvent);

			case EventType.StreamOnline:
				return this.handleStreamOnline(validEvent);

			case EventType.StreamOffline:
				return this.handleStreamOffline(validEvent);
		}
	}

	/**
	 * Handle song_request_success event
	 *
	 * - Records song_request for cumulative achievements (first_request, request_10, etc.)
	 * - Checks if first request of stream → unlocks stream_opener
	 * - Updates user streak (session + longest high watermark)
	 * - Checks streak achievements (streak_3, streak_5)
	 */
	private async handleSongRequest(
		event: SongRequestSuccessEvent,
	): Promise<Result<void, AchievementError>> {
		logger.info("AchievementsDO: Handling song request", {
			eventId: event.id,
			userId: event.userId,
			userDisplayName: event.userDisplayName,
			trackId: event.trackId,
		});

		// Record song_request for cumulative achievements (first_request, request_10, request_50, request_100)
		const songRequestResult = await this.recordEventInternal({
			userDisplayName: event.userDisplayName,
			event: "song_request",
			eventId: event.id,
			increment: 1,
		});

		if (songRequestResult.isErr()) {
			logger.warn("AchievementsDO: Failed to record song request achievement", {
				error: songRequestResult.error,
				userId: event.userId,
			});
			// Continue - don't fail entire handler for achievement errors
		} else if (songRequestResult.value.length > 0) {
			logger.info("AchievementsDO: Song request achievement unlocked", {
				userId: event.userId,
				achievements: songRequestResult.value.map((a) => a.name),
			});
		}

		// Check if this is the first request of the current stream
		const firstRequestResult = await this.isFirstRequestOfStream(event.id);
		if (firstRequestResult.isErr()) {
			logger.warn("AchievementsDO: Failed to check first request", {
				error: firstRequestResult.error,
				eventId: event.id,
			});
			// Continue - don't fail entire handler for first request check
		} else if (firstRequestResult.value) {
			// This is the first request of the stream - trigger stream_first_request
			const firstAchievementResult = await this.recordEventInternal({
				userDisplayName: event.userDisplayName,
				event: "stream_first_request",
				eventId: `${event.id}-first-request`,
				increment: 1,
			});

			if (firstAchievementResult.isErr()) {
				logger.warn("AchievementsDO: Failed to record first request achievement", {
					error: firstAchievementResult.error,
					userId: event.userId,
				});
			} else if (firstAchievementResult.value.length > 0) {
				logger.info("AchievementsDO: First request achievement unlocked", {
					userId: event.userId,
					achievements: firstAchievementResult.value.map((a) => a.name),
				});
			}
		}

		// Update streak and check achievements
		const streakResult = await this.updateStreak(event.userId, event.userDisplayName);
		if (streakResult.isErr()) {
			return streakResult;
		}

		const newSessionStreak = streakResult.value;

		// Check streak achievements (streak_3, streak_5)
		// Only check if we've hit a threshold to avoid unnecessary DB queries
		if (newSessionStreak >= 3) {
			const achievementResult = await this.recordEventInternal({
				userDisplayName: event.userDisplayName,
				event: "request_streak",
				eventId: `${event.id}-streak-${newSessionStreak}`,
				increment: 1,
				metadata: { streakCount: newSessionStreak },
			});

			if (achievementResult.isErr()) {
				logger.warn("AchievementsDO: Failed to record streak achievement", {
					error: achievementResult.error,
					userId: event.userId,
					streak: newSessionStreak,
				});
				// Don't fail the whole handler for achievement errors
			} else if (achievementResult.value.length > 0) {
				logger.info("AchievementsDO: Streak achievement unlocked", {
					userId: event.userId,
					streak: newSessionStreak,
					achievements: achievementResult.value.map((a) => a.name),
				});
			}
		}

		return Result.ok();
	}

	/**
	 * Update user streak on song request success
	 *
	 * Returns the new session streak count.
	 */
	private async updateStreak(
		userId: string,
		userDisplayName: string,
	): Promise<Result<number, AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				const now = new Date().toISOString();

				// Get existing streak record
				const existing = await this.db.query.userStreaks.findFirst({
					where: eq(userStreaks.userId, userId),
				});

				if (existing) {
					// Increment session streak
					const newSessionStreak = existing.sessionStreak + 1;
					// Update longest if session exceeds it (high watermark)
					const newLongestStreak = Math.max(existing.longestStreak, newSessionStreak);

					await this.db
						.update(userStreaks)
						.set({
							sessionStreak: newSessionStreak,
							longestStreak: newLongestStreak,
							lastRequestAt: now,
						})
						.where(eq(userStreaks.userId, userId));

					logger.debug("AchievementsDO: Updated streak", {
						userId,
						sessionStreak: newSessionStreak,
						longestStreak: newLongestStreak,
					});

					return newSessionStreak;
				}

				// Create new streak record (first request ever)
				await this.db.insert(userStreaks).values({
					userId,
					userDisplayName,
					sessionStreak: 1,
					longestStreak: 1,
					lastRequestAt: now,
				});

				logger.debug("AchievementsDO: Created streak record", {
					userId,
					sessionStreak: 1,
				});

				return 1;
			},
			catch: (cause) => new AchievementDbError({ operation: "updateStreak", cause }),
		});
	}

	/**
	 * Handle raffle_roll event
	 *
	 * Triggers achievements:
	 * - raffle_roll: cumulative (first_roll, roll_25, roll_100)
	 * - raffle_win: when isWinner=true (first_win)
	 * - raffle_close: when distance <= 100 AND !isWinner (close_call)
	 * - raffle_closest_record: when this sets the global closest record (closest_ever)
	 */
	private async handleRaffleRoll(event: RaffleRollEvent): Promise<Result<void, AchievementError>> {
		logger.info("AchievementsDO: Handling raffle roll", {
			eventId: event.id,
			userId: event.userId,
			userDisplayName: event.userDisplayName,
			roll: event.roll,
			distance: event.distance,
			isWinner: event.isWinner,
		});

		// 1. Record raffle_roll for cumulative roll achievements (first_roll, roll_25, roll_100)
		const rollResult = await this.recordEventInternal({
			userDisplayName: event.userDisplayName,
			event: "raffle_roll",
			eventId: event.id,
			increment: 1,
		});

		if (rollResult.isErr()) {
			logger.warn("AchievementsDO: Failed to record raffle roll achievement", {
				error: rollResult.error,
				userId: event.userId,
			});
		} else if (rollResult.value.length > 0) {
			logger.info("AchievementsDO: Raffle roll achievement unlocked", {
				userId: event.userId,
				achievements: rollResult.value.map((a) => a.name),
			});
		}

		// 2. Record raffle_win if winner (first_win)
		if (event.isWinner) {
			const winResult = await this.recordEventInternal({
				userDisplayName: event.userDisplayName,
				event: "raffle_win",
				eventId: `${event.id}-win`,
				increment: 1,
			});

			if (winResult.isErr()) {
				logger.warn("AchievementsDO: Failed to record raffle win achievement", {
					error: winResult.error,
					userId: event.userId,
				});
			} else if (winResult.value.length > 0) {
				logger.info("AchievementsDO: Raffle win achievement unlocked", {
					userId: event.userId,
					achievements: winResult.value.map((a) => a.name),
				});
			}
		}

		// 3. Record raffle_close if within 100 distance (but not winner) (close_call)
		// close_call is event-based (NULL threshold) - unlocks once per user
		if (!event.isWinner && event.distance <= 100) {
			const closeResult = await this.recordEventInternal({
				userDisplayName: event.userDisplayName,
				event: "raffle_close",
				eventId: `${event.id}-close`,
				increment: 1,
			});

			if (closeResult.isErr()) {
				logger.warn("AchievementsDO: Failed to record close call achievement", {
					error: closeResult.error,
					userId: event.userId,
				});
			} else if (closeResult.value.length > 0) {
				logger.info("AchievementsDO: Close call achievement unlocked", {
					userId: event.userId,
					distance: event.distance,
					achievements: closeResult.value.map((a) => a.name),
				});
			}
		}

		// 4. Record closest_ever if this roll set a new closest record
		// Only check for non-winners - winners have distance 0 (different achievement)
		if (!event.isWinner && event.isNewRecord) {
			const recordAchievementResult = await this.recordEventInternal({
				userDisplayName: event.userDisplayName,
				event: "raffle_closest_record",
				eventId: `${event.id}-closest-record`,
				increment: 1,
			});

			if (recordAchievementResult.isErr()) {
				logger.warn("AchievementsDO: Failed to record closest record achievement", {
					error: recordAchievementResult.error,
					userId: event.userId,
				});
			} else if (recordAchievementResult.value.length > 0) {
				logger.info("AchievementsDO: Closest record achievement unlocked", {
					userId: event.userId,
					achievements: recordAchievementResult.value.map((a) => a.name),
				});
			}
		}

		logger.info("AchievementsDO: handleRaffleRoll completed", {
			eventId: event.id,
			userId: event.userId,
		});

		return Result.ok();
	}

	/**
	 * Handle stream_online event
	 *
	 * Resets session-scoped achievements and streaks.
	 */
	private async handleStreamOnline(
		event: StreamOnlineEvent,
	): Promise<Result<void, AchievementError>> {
		logger.info("AchievementsDO: Handling stream online", {
			eventId: event.id,
			streamId: event.streamId,
			startedAt: event.startedAt,
		});

		// Delegate to existing lifecycle method
		return this.onStreamOnline();
	}

	/**
	 * Handle stream_offline event
	 */
	private async handleStreamOffline(
		event: StreamOfflineEvent,
	): Promise<Result<void, AchievementError>> {
		logger.info("AchievementsDO: Handling stream offline", {
			eventId: event.id,
			streamId: event.streamId,
			endedAt: event.endedAt,
		});

		// Delegate to existing lifecycle method
		return this.onStreamOffline();
	}

	/**
	 * Check if this is the first song request of the current stream session
	 *
	 * Queries event_history for the most recent stream_online event to get session start,
	 * then counts song_request_success events after that time (excluding current event).
	 * Returns true if no prior requests exist in this session.
	 */
	private async isFirstRequestOfStream(
		eventId: string,
	): Promise<Result<boolean, AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				// Get most recent stream_online event to determine session start
				const latestStreamOnline = await this.db.query.eventHistory.findFirst({
					where: eq(eventHistory.eventType, "stream_online"),
					orderBy: [desc(eventHistory.timestamp)],
					columns: { timestamp: true },
				});

				// If no stream_online recorded, we can't determine "first of stream"
				// This shouldn't happen in normal flow but handle gracefully
				if (!latestStreamOnline) {
					logger.debug("AchievementsDO: No stream_online event found, cannot check first request");
					return false;
				}

				const streamStartedAt = latestStreamOnline.timestamp;

				// Count song_request_success events after stream start, excluding current
				const priorRequests = await this.db
					.select({ count: count() })
					.from(eventHistory)
					.where(
						and(
							eq(eventHistory.eventType, "song_request_success"),
							gt(eventHistory.timestamp, streamStartedAt),
							ne(eventHistory.eventId, eventId),
						),
					);

				const priorCount = priorRequests[0]?.count ?? 0;

				logger.debug("AchievementsDO: First request check", {
					eventId,
					streamStartedAt,
					priorRequestCount: priorCount,
					isFirst: priorCount === 0,
				});

				return priorCount === 0;
			},
			catch: (cause) => new AchievementDbError({ operation: "isFirstRequestOfStream", cause }),
		});
	}

	/**
	 * Record event to event_history table for auditing and "first request" checks
	 *
	 * Idempotent: uses ON CONFLICT DO NOTHING for the unique eventId index.
	 * Retried events (from EventBusDO retry or DLQ replay) are safely ignored.
	 */
	private async recordToEventHistory(event: Event): Promise<Result<void, AchievementDbError>> {
		return Result.tryPromise({
			try: async () => {
				// Extract user info based on event type
				const userInfo = this.extractUserInfo(event);

				await this.db
					.insert(eventHistory)
					.values({
						id: crypto.randomUUID(),
						eventType: event.type,
						userId: userInfo.userId,
						userDisplayName: userInfo.userDisplayName,
						eventId: event.id,
						timestamp: event.timestamp,
						metadata: JSON.stringify(this.extractMetadata(event)),
					})
					.onConflictDoNothing({ target: eventHistory.eventId });

				logger.debug("AchievementsDO: Recorded event to history", {
					eventId: event.id,
					eventType: event.type,
				});
			},
			catch: (cause) => new AchievementDbError({ operation: "recordToEventHistory", cause }),
		});
	}

	/**
	 * Extract user info from event based on type
	 */
	private extractUserInfo(event: Event): { userId: string; userDisplayName: string } {
		switch (event.type) {
			case EventType.SongRequestSuccess:
			case EventType.RaffleRoll:
				return { userId: event.userId, userDisplayName: event.userDisplayName };

			case EventType.StreamOnline:
			case EventType.StreamOffline:
				// Stream events don't have user info, use system placeholder
				return { userId: "system", userDisplayName: "System" };
		}
	}

	/**
	 * Extract relevant metadata from event for storage
	 */
	private extractMetadata(event: Event): Record<string, unknown> {
		switch (event.type) {
			case EventType.SongRequestSuccess:
				return { trackId: event.trackId, sagaId: event.sagaId };

			case EventType.RaffleRoll:
				return {
					roll: event.roll,
					winningNumber: event.winningNumber,
					distance: event.distance,
					isWinner: event.isWinner,
					sagaId: event.sagaId,
				};

			case EventType.StreamOnline:
				return { streamId: event.streamId, startedAt: event.startedAt };

			case EventType.StreamOffline:
				return { streamId: event.streamId, endedAt: event.endedAt };
		}
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

	/**
	 * Announce achievement unlock to chat (best-effort)
	 *
	 * Atomically claims announcement rights via markAnnounced() BEFORE sending
	 * to prevent duplicate chat messages from concurrent requests.
	 * Failures are logged but do not propagate - announcements are non-critical.
	 */
	private async announceAchievement(
		userDisplayName: string,
		definition: AchievementDefinition,
	): Promise<void> {
		// Atomically claim announcement rights FIRST to prevent duplicate messages
		const markResult = await this.markAnnounced(userDisplayName, definition.id);
		if (markResult.status !== "ok" || !markResult.value) {
			// Already announced by another request, or failed to claim
			logger.debug("Achievement already announced or claim failed", {
				userDisplayName,
				achievementId: definition.id,
			});
			return;
		}

		// Now safe to send - we own this announcement
		const twitchService = new TwitchService(this.env);
		const message = `🏆 @${userDisplayName} unlocked "${definition.name}"! ${definition.description}`;

		const sendResult = await twitchService.sendChatMessage(message);

		if (sendResult.status === "ok") {
			logger.info("Achievement announced", {
				userDisplayName,
				achievementId: definition.id,
				achievementName: definition.name,
			});
		} else {
			logger.warn("Failed to announce achievement to chat (already marked)", {
				userDisplayName,
				achievementId: definition.id,
				achievementName: definition.name,
				error: sendResult.error.message,
			});
			// Note: Achievement is already marked as announced, so no retry.
			// This is acceptable - chat is ephemeral, achievement is still recorded.
		}
	}
}

export const AchievementsDO = withRpcSerialization(_AchievementsDO);
