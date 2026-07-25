/**
 * AchievementsDO - Tracks per-user achievement progress and unlocks
 *
 * Achievements are triggered by events from workflows (song requests, raffles, etc.).
 * Progress is tracked and unlocks are recorded with timestamps for chat announcements.
 */

import { Agent, type AgentContext } from "agents";
import { Result } from "better-result";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/achievements-do/migrations";
import { writeAchievementUnlockMetric } from "../lib/analytics";
import { getStub, rpc, withRpcSerialization } from "../lib/durable-objects";
import {
	AchievementDbError,
	AchievementEventValidationError,
	AchievementQueryValidationError,
	DurableObjectError,
	InvalidAchievementRecordError,
	TokenUnavailableWhileStreamOfflineError,
	TokenRefreshNetworkError,
	TwitchNetworkError,
	TwitchRateLimitError,
	type AchievementError,
	type StreamLifecycleHandler,
} from "../lib/errors";
import { logger } from "../lib/logger";
import { TwitchService } from "../services/twitch-service";
import {
	evaluateAchievementRules,
	type AchievementFacts,
	type AchievementRuleDefinition,
} from "./achievements/rules";
import * as schema from "./schemas/achievements-do.schema";
import {
	achievementDefinitions,
	achievementStreamSession,
	achievementUnlockOutbox,
	eventHistory,
	userAchievements,
	userStreaks,
} from "./schemas/achievements-do.schema";
import { EventSchema, EventType, type Event } from "./schemas/event-bus-do.schema";

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
const AchievementTriggerEventSchema = z.enum([
	"song_request",
	"stream_first_request",
	"raffle_roll",
	"raffle_win",
	"raffle_close",
	"raffle_closest_record",
	"request_streak",
]);
const AchievementScopeSchema = z.enum(["session", "cumulative"]);

/** Achievement scope - determines reset behavior */
export type AchievementScope = "session" | "cumulative";

/** Input schema for recordEvent - validated with Zod */
export const AchievementEventInputSchema = z.object({
	userId: z.string().min(1),
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

const ANNOUNCEMENT_RETRY_DELAYS_SECONDS = [3, 5, 10] as const;

const AchievementUnlockEffectPayloadSchema = z.object({
	effectId: z.string().min(1),
});

const AchievementDefinitionRecordSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	description: z.string().min(1),
	icon: z.string().min(1),
	category: AchievementCategorySchema,
	threshold: z.number().int().positive().nullable(),
	triggerEvent: AchievementTriggerEventSchema,
	scope: AchievementScopeSchema,
});

/** Parsed Achievement Definition returned by the public RPC interface. */
export type AchievementDefinition = z.infer<typeof AchievementDefinitionRecordSchema>;

const LeaderboardOptionsSchema = z.object({
	limit: z.number().int().min(1).max(100).optional().default(10),
});

const UnlockedAchievementRecordSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	description: z.string().min(1),
	icon: z.string().min(1),
	category: AchievementCategorySchema,
	unlockedAt: z.string().datetime(),
});

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

export interface AchievementsAgentState {
	isStreamLive: boolean;
	currentStreamStartedAt: string | null;
}

/**
 * AchievementsDO - Agent for tracking user achievements
 */
class _AchievementsDO
	extends Agent<Env, AchievementsAgentState>
	implements StreamLifecycleHandler<AchievementDbError>
{
	private db: ReturnType<typeof drizzle<typeof schema>>;

	initialState: AchievementsAgentState = {
		isStreamLive: false,
		currentStreamStartedAt: null,
	};

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });
	}

	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
			await this.db
				.update(achievementUnlockOutbox)
				.set({ announcementState: "uncertain", updatedAt: new Date().toISOString() })
				.where(eq(achievementUnlockOutbox.announcementState, "sending"));
			const session = await this.db.query.achievementStreamSession.findFirst({
				where: eq(achievementStreamSession.singletonId, 1),
			});
			if (session !== undefined) {
				this.setState({
					isStreamLive: session.status === "online",
					currentStreamStartedAt: session.startedAt,
				});
			}
			const effects = await this.db
				.select({ effectId: achievementUnlockOutbox.effectId })
				.from(achievementUnlockOutbox);
			for (const effect of effects) {
				await this.queue("processAchievementUnlockEffects", effect);
			}
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
		const { userId, userDisplayName, event, eventId, increment, metadata } = input;
		const transactionResult = await Result.tryPromise({
			try: async () =>
				this.db.transaction(async (tx) => {
					const inserted = await tx
						.insert(eventHistory)
						.values({
							id: crypto.randomUUID(),
							eventType: `achievement:${event}`,
							userId,
							userDisplayName,
							eventId,
							timestamp: new Date().toISOString(),
							metadata: JSON.stringify(metadata ?? {}),
						})
						.onConflictDoNothing({ target: eventHistory.eventId })
						.returning({ eventId: eventHistory.eventId });
					if (inserted.length === 0) {
						return { newlyUnlocked: [], effectIds: [] };
					}

					const definitionRows = await tx.query.achievementDefinitions.findMany({
						where: eq(achievementDefinitions.triggerEvent, event),
					});
					const definitions = definitionRows.map((row) =>
						this.parseAchievementDefinitionRecord(row),
					);
					const newlyUnlocked: UnlockedAchievement[] = [];
					const effectIds: string[] = [];
					const now = new Date().toISOString();
					for (const definition of definitions) {
						const existing = await tx.query.userAchievements.findFirst({
							where: and(
								eq(userAchievements.userId, userId),
								eq(userAchievements.achievementId, definition.id),
							),
						});
						if (existing?.unlockedAt !== null && existing !== undefined) {
							continue;
						}
						const effectiveIncrement = this.calculateIncrement(definition, increment, metadata);
						const progress =
							definition.triggerEvent === "request_streak"
								? effectiveIncrement
								: (existing?.progress ?? 0) + effectiveIncrement;
						const shouldUnlock = this.shouldUnlock(definition, progress);
						if (existing === undefined) {
							await tx.insert(userAchievements).values({
								id: crypto.randomUUID(),
								userId,
								userDisplayName,
								achievementId: definition.id,
								progress,
								unlockedAt: shouldUnlock ? now : null,
								announcementState: "pending",
								eventId: definition.threshold === null ? eventId : null,
							});
						} else {
							await tx
								.update(userAchievements)
								.set({
									userDisplayName,
									progress,
									unlockedAt: shouldUnlock ? now : null,
									eventId: definition.threshold === null ? eventId : existing.eventId,
								})
								.where(eq(userAchievements.id, existing.id));
						}
						if (!shouldUnlock) {
							continue;
						}
						newlyUnlocked.push({
							id: definition.id,
							name: definition.name,
							description: definition.description,
							icon: definition.icon,
							category: definition.category,
							unlockedAt: now,
						});
						const effectId = `${eventId}:${definition.id}`;
						await tx
							.insert(achievementUnlockOutbox)
							.values({
								effectId,
								eventId,
								userId,
								userDisplayName,
								achievementId: definition.id,
								achievementName: definition.name,
								achievementDescription: definition.description,
								category: definition.category,
								createdAt: now,
								updatedAt: now,
							})
							.onConflictDoNothing();
						effectIds.push(effectId);
					}
					return { newlyUnlocked, effectIds };
				}),
			catch: (cause) =>
				InvalidAchievementRecordError.is(cause)
					? cause
					: new AchievementDbError({ operation: "recordEventTransaction", cause }),
		});
		if (transactionResult.isErr()) {
			return Result.err(transactionResult.error);
		}
		for (const effectId of transactionResult.value.effectIds) {
			const queueResult = await Result.tryPromise(() =>
				this.queue("processAchievementUnlockEffects", { effectId }),
			);
			if (queueResult.isErr()) {
				return Result.err(
					new AchievementDbError({
						operation: "queueAchievementUnlockEffect",
						cause: queueResult.error,
					}),
				);
			}
		}
		return Result.ok(transactionResult.value.newlyUnlocked);
	}

	/**
	 * Get all achievements with user's progress
	 */
	@rpc
	async getUserAchievements(
		userDisplayName: string,
	): Promise<Result<UserAchievementProgress[], AchievementError>> {
		return Result.tryPromise({
			try: async () => {
				// Get all definitions
				const definitionRows = await this.db.query.achievementDefinitions.findMany();
				const definitions = definitionRows.map((row) => this.parseAchievementDefinitionRecord(row));

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
			catch: (cause) =>
				InvalidAchievementRecordError.is(cause)
					? cause
					: new AchievementDbError({ operation: "getUserAchievements", cause }),
		});
	}

	/**
	 * Get only unlocked achievements for a user
	 */
	@rpc
	async getUnlockedAchievements(
		userDisplayName: string,
	): Promise<Result<UnlockedAchievement[], AchievementError>> {
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

				return results.flatMap((row) => {
					if (row.unlockedAt === null) {
						return [];
					}
					const result = UnlockedAchievementRecordSchema.safeParse(row);
					if (!result.success) {
						throw new InvalidAchievementRecordError({
							recordType: "unlocked progress",
							parseError: result.error.message,
						});
					}
					return [result.data];
				});
			},
			catch: (cause) =>
				InvalidAchievementRecordError.is(cause)
					? cause
					: new AchievementDbError({ operation: "getUnlockedAchievements", cause }),
		});
	}

	/**
	 * Get all achievement definitions
	 */
	@rpc
	async getDefinitions(): Promise<Result<AchievementDefinition[], AchievementError>> {
		return Result.tryPromise({
			try: async () => {
				const rows = await this.db.query.achievementDefinitions.findMany();
				return rows.map((row) => this.parseAchievementDefinitionRecord(row));
			},
			catch: (cause) =>
				InvalidAchievementRecordError.is(cause)
					? cause
					: new AchievementDbError({ operation: "getDefinitions", cause }),
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

				const [allAchievementRows, allStreakRows, allEventRows, recentEventRows] =
					await Promise.all([
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
					.where(
						and(
							isNotNull(userAchievements.unlockedAt),
							eq(userAchievements.announcementState, "pending"),
						),
					)
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
	 * Get leaderboard of users by achievement unlock count
	 */
	@rpc
	async getLeaderboard(
		options?: LeaderboardOptions,
	): Promise<Result<LeaderboardEntry[], AchievementError>> {
		const optionsResult = LeaderboardOptionsSchema.safeParse(options ?? {});
		if (!optionsResult.success) {
			return Result.err(
				new AchievementQueryValidationError({ parseError: optionsResult.error.message }),
			);
		}
		return Result.tryPromise({
			try: async () => {
				const limit = optionsResult.data.limit;

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
				this.setState({
					isStreamLive: true,
					currentStreamStartedAt: now,
				});
				await this.db
					.insert(achievementStreamSession)
					.values({
						singletonId: 1,
						status: "online",
						streamId: `direct:${now}`,
						startedAt: now,
						transitionAt: now,
					})
					.onConflictDoUpdate({
						target: achievementStreamSession.singletonId,
						set: { status: "online", streamId: `direct:${now}`, startedAt: now, transitionAt: now },
					});

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
							announcementState: "pending",
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
		return Result.tryPromise({
			try: async () => {
				const now = new Date().toISOString();
				this.setState({ isStreamLive: false, currentStreamStartedAt: null });
				await this.db
					.insert(achievementStreamSession)
					.values({
						singletonId: 1,
						status: "offline",
						streamId: null,
						startedAt: null,
						transitionAt: now,
					})
					.onConflictDoUpdate({
						target: achievementStreamSession.singletonId,
						set: { status: "offline", streamId: null, startedAt: null, transitionAt: now },
					});
			},
			catch: (cause) => new AchievementDbError({ operation: "onStreamOffline", cause }),
		});
	}

	/** Dispatches one persisted Achievement unlock outbox effect with guarded side effects. */
	async processAchievementUnlockEffects(payload: unknown): Promise<void> {
		const parseResult = AchievementUnlockEffectPayloadSchema.safeParse(payload);
		if (!parseResult.success) {
			logger.warn("AchievementsDO: Invalid unlock effect payload", {
				error: parseResult.error.message,
			});
			return;
		}

		const effect = await this.db.query.achievementUnlockOutbox.findFirst({
			where: eq(achievementUnlockOutbox.effectId, parseResult.data.effectId),
		});
		if (effect === undefined) {
			return;
		}

		if (effect.metricState === "pending") {
			await this.db
				.update(achievementUnlockOutbox)
				.set({ metricState: "claimed", updatedAt: new Date().toISOString() })
				.where(
					and(
						eq(achievementUnlockOutbox.effectId, effect.effectId),
						eq(achievementUnlockOutbox.metricState, "pending"),
					),
				);
			writeAchievementUnlockMetric(this.env.ANALYTICS, {
				effectId: effect.effectId,
				user: effect.userDisplayName,
				achievementId: effect.achievementId,
				achievementName: effect.achievementName,
				category: AchievementCategorySchema.parse(effect.category),
			});
		}

		if (
			effect.announcementState === "sent" ||
			effect.announcementState === "abandoned" ||
			effect.announcementState === "uncertain" ||
			effect.announcementState === "sending"
		) {
			return;
		}

		const tokenResult = await getStub("TWITCH_TOKEN_DO").getValidToken();
		if (tokenResult.status === "error") {
			await this.retryOrAbandonAchievementAnnouncement(
				effect.effectId,
				effect.announcementAttempts,
				tokenResult.error,
			);
			return;
		}

		const claim = await this.db
			.update(achievementUnlockOutbox)
			.set({ announcementState: "sending", updatedAt: new Date().toISOString() })
			.where(
				and(
					eq(achievementUnlockOutbox.effectId, effect.effectId),
					eq(achievementUnlockOutbox.announcementState, "pending"),
				),
			)
			.returning({ effectId: achievementUnlockOutbox.effectId });
		if (claim.length === 0) {
			return;
		}

		const twitchService = new TwitchService(this.env);
		const message = `🏆 @${effect.userDisplayName} unlocked "${effect.achievementName}"! ${effect.achievementDescription}`;
		const sendResult = await twitchService.sendChatMessage(message);
		if (sendResult.status === "ok") {
			await this.db.transaction(async (tx) => {
				await tx
					.update(achievementUnlockOutbox)
					.set({ announcementState: "sent", updatedAt: new Date().toISOString() })
					.where(eq(achievementUnlockOutbox.effectId, effect.effectId));
				await tx
					.update(userAchievements)
					.set({ announcementState: "sent" })
					.where(
						and(
							eq(userAchievements.userId, effect.userId),
							eq(userAchievements.achievementId, effect.achievementId),
						),
					);
			});
			return;
		}

		await this.db
			.update(achievementUnlockOutbox)
			.set({ announcementState: "pending", updatedAt: new Date().toISOString() })
			.where(eq(achievementUnlockOutbox.effectId, effect.effectId));
		await this.retryOrAbandonAchievementAnnouncement(
			effect.effectId,
			effect.announcementAttempts,
			sendResult.error,
		);
	}

	private async retryOrAbandonAchievementAnnouncement(
		effectId: string,
		attempts: number,
		error: unknown,
	): Promise<void> {
		const delayInSeconds = ANNOUNCEMENT_RETRY_DELAYS_SECONDS[attempts] ?? null;
		const retryable =
			this.isRetryableAnnouncementPreflightError(error) ||
			TwitchNetworkError.is(error) ||
			TwitchRateLimitError.is(error);
		if (!retryable || delayInSeconds === null) {
			await this.db
				.update(achievementUnlockOutbox)
				.set({ announcementState: "abandoned", updatedAt: new Date().toISOString() })
				.where(eq(achievementUnlockOutbox.effectId, effectId));
			return;
		}

		await this.db
			.update(achievementUnlockOutbox)
			.set({
				announcementState: "pending",
				announcementAttempts: attempts + 1,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(achievementUnlockOutbox.effectId, effectId));
		await this.schedule(
			delayInSeconds,
			"processAchievementUnlockEffects",
			{ effectId },
			{
				idempotent: true,
				retry: { maxAttempts: 5 },
			},
		);
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
		const parseResult = EventSchema.safeParse(event);
		if (!parseResult.success) {
			return Result.err(
				new AchievementEventValidationError({ parseError: parseResult.error.message }),
			);
		}

		const validEvent = parseResult.data;
		const transactionResult = await Result.tryPromise({
			try: async () =>
				this.db.transaction(async (tx) => {
					const userInfo = this.extractUserInfo(validEvent);
					const insertedHistory = await tx
						.insert(eventHistory)
						.values({
							id: crypto.randomUUID(),
							eventType: validEvent.type,
							userId: userInfo.userId,
							userDisplayName: userInfo.userDisplayName,
							eventId: validEvent.id,
							timestamp: validEvent.timestamp,
							metadata: JSON.stringify(this.extractMetadata(validEvent)),
						})
						.onConflictDoNothing({ target: eventHistory.eventId })
						.returning({ eventId: eventHistory.eventId });

					if (insertedHistory.length === 0) {
						const outstanding = await tx
							.select({ effectId: achievementUnlockOutbox.effectId })
							.from(achievementUnlockOutbox);
						return { effectIds: outstanding.map((row) => row.effectId), streamState: null };
					}

					const definitionRows = await tx.query.achievementDefinitions.findMany();
					const definitions = definitionRows.map((row) =>
						AchievementDefinitionRecordSchema.parse(row),
					);
					const persistedSession = await tx.query.achievementStreamSession.findFirst({
						where: eq(achievementStreamSession.singletonId, 1),
					});

					let transitionAccepted = true;
					if (validEvent.type === EventType.StreamOnline) {
						transitionAccepted =
							(persistedSession === undefined ||
								validEvent.startedAt > persistedSession.transitionAt) &&
							!(
								persistedSession?.status === "online" &&
								persistedSession.streamId === validEvent.streamId
							);
					} else if (validEvent.type === EventType.StreamOffline) {
						transitionAccepted =
							persistedSession === undefined ||
							(persistedSession.status === "offline" &&
								validEvent.endedAt > persistedSession.transitionAt) ||
							(persistedSession.status === "online" &&
								persistedSession.streamId === validEvent.streamId &&
								validEvent.endedAt >= persistedSession.transitionAt);
					}

					if (!transitionAccepted) {
						return { effectIds: [], streamState: persistedSession ?? null };
					}

					let viewer: AchievementFacts["viewer"];
					let isStreamOpenerCandidate = false;
					if (
						validEvent.type === EventType.SongRequestSuccess ||
						validEvent.type === EventType.RaffleRoll
					) {
						await tx
							.update(userAchievements)
							.set({ userDisplayName: validEvent.userDisplayName })
							.where(eq(userAchievements.userId, validEvent.userId));
						const [progressRows, streak] = await Promise.all([
							tx.query.userAchievements.findMany({
								where: eq(userAchievements.userId, validEvent.userId),
							}),
							tx.query.userStreaks.findFirst({
								where: eq(userStreaks.userId, validEvent.userId),
							}),
						]);
						if (
							validEvent.type === EventType.SongRequestSuccess &&
							persistedSession?.status === "online" &&
							persistedSession.startedAt !== null
						) {
							const priorRequests = await tx
								.select({ count: count() })
								.from(eventHistory)
								.where(
									and(
										eq(eventHistory.eventType, EventType.SongRequestSuccess),
										gt(eventHistory.timestamp, persistedSession.startedAt),
										ne(eventHistory.eventId, validEvent.id),
									),
								);
							isStreamOpenerCandidate = (priorRequests[0]?.count ?? 0) === 0;
						}
						viewer = {
							userId: validEvent.userId,
							userDisplayName: validEvent.userDisplayName,
							progressByAchievementId: new Map(
								progressRows.map((progress) => [progress.achievementId, progress]),
							),
							requestStreak: streak,
						};
					}

					const ruleDefinitions = definitions.map((definition) =>
						this.toAchievementRuleDefinition(definition),
					);
					const now =
						validEvent.type === EventType.StreamOnline
							? validEvent.startedAt
							: validEvent.type === EventType.StreamOffline
								? validEvent.endedAt
								: new Date().toISOString();
					const decisions = evaluateAchievementRules({
						event: validEvent,
						now,
						facts: {
							definitions: ruleDefinitions,
							viewer,
							streamSession: {
								isLive: persistedSession?.status === "online",
								currentStreamStartedAt: persistedSession?.startedAt ?? null,
								isStreamOpenerCandidate,
							},
						},
					});

					const effectIds: string[] = [];
					for (const decision of decisions) {
						switch (decision.kind) {
							case "upsert-achievement-progress": {
								const existing = await tx.query.userAchievements.findFirst({
									where: and(
										eq(userAchievements.userId, decision.userId),
										eq(userAchievements.achievementId, decision.achievementId),
									),
								});
								if (existing === undefined) {
									await tx.insert(userAchievements).values({
										id: crypto.randomUUID(),
										userId: decision.userId,
										userDisplayName: decision.userDisplayName,
										achievementId: decision.achievementId,
										progress: decision.progress,
										unlockedAt: decision.unlockedAt,
										announcementState: "pending",
										eventId: decision.eventId,
									});
								} else {
									await tx
										.update(userAchievements)
										.set({
											userDisplayName: decision.userDisplayName,
											progress: decision.progress,
											unlockedAt: decision.unlockedAt,
											eventId: decision.eventId ?? existing.eventId,
										})
										.where(eq(userAchievements.id, existing.id));
								}
								break;
							}
							case "queue-achievement-unlock-effect": {
								const effectId = `${validEvent.id}:${decision.achievement.id}`;
								await tx
									.insert(achievementUnlockOutbox)
									.values({
										effectId,
										eventId: validEvent.id,
										userId: decision.userId,
										userDisplayName: decision.userDisplayName,
										achievementId: decision.achievement.id,
										achievementName: decision.achievement.name,
										achievementDescription: decision.achievement.description,
										category: decision.achievement.category,
										createdAt: now,
										updatedAt: now,
									})
									.onConflictDoNothing();
								effectIds.push(effectId);
								break;
							}
							case "update-request-streak":
								await tx
									.insert(userStreaks)
									.values(decision)
									.onConflictDoUpdate({
										target: userStreaks.userId,
										set: {
											userDisplayName: decision.userDisplayName,
											sessionStreak: decision.sessionStreak,
											longestStreak: decision.longestStreak,
											lastRequestAt: decision.lastRequestAt,
										},
									});
								break;
							case "reset-session-achievement-progress":
								if (decision.achievementIds.length > 0) {
									await tx
										.update(userAchievements)
										.set({
											progress: 0,
											unlockedAt: null,
											announcementState: "pending",
											eventId: null,
										})
										.where(inArray(userAchievements.achievementId, decision.achievementIds));
									await tx
										.update(achievementUnlockOutbox)
										.set({ announcementState: "abandoned", updatedAt: now })
										.where(
											and(
												inArray(achievementUnlockOutbox.achievementId, decision.achievementIds),
												ne(achievementUnlockOutbox.announcementState, "sent"),
											),
										);
								}
								break;
							case "reset-all-request-streaks":
								await tx.update(userStreaks).set({
									sessionStreak: 0,
									sessionStartedAt: decision.sessionStartedAt,
								});
								break;
							case "set-stream-session-state": {
								const streamId =
									validEvent.type === EventType.StreamOnline ||
									validEvent.type === EventType.StreamOffline
										? validEvent.streamId
										: null;
								await tx
									.insert(achievementStreamSession)
									.values({
										singletonId: 1,
										status: decision.isLive ? "online" : "offline",
										streamId,
										startedAt: decision.currentStreamStartedAt,
										transitionAt: now,
									})
									.onConflictDoUpdate({
										target: achievementStreamSession.singletonId,
										set: {
											status: decision.isLive ? "online" : "offline",
											streamId,
											startedAt: decision.currentStreamStartedAt,
											transitionAt: now,
										},
									});
								break;
							}
						}
					}
					const finalSession = await tx.query.achievementStreamSession.findFirst({
						where: eq(achievementStreamSession.singletonId, 1),
					});
					return { effectIds, streamState: finalSession ?? null };
				}),
			catch: (cause) => new AchievementDbError({ operation: "handleEventTransaction", cause }),
		});

		if (transactionResult.isErr()) {
			return Result.err(transactionResult.error);
		}

		const streamState = transactionResult.value.streamState;
		if (streamState !== null) {
			this.setState({
				isStreamLive: streamState.status === "online",
				currentStreamStartedAt: streamState.startedAt,
			});
		}

		for (const effectId of transactionResult.value.effectIds) {
			const queueResult = await Result.tryPromise(() =>
				this.queue("processAchievementUnlockEffects", { effectId }),
			);
			if (queueResult.isErr()) {
				return Result.err(
					new AchievementDbError({
						operation: "queueAchievementUnlockEffect",
						cause: queueResult.error,
					}),
				);
			}
		}

		return Result.ok();
	}

	private parseAchievementDefinitionRecord(input: unknown): AchievementDefinition {
		const result = AchievementDefinitionRecordSchema.safeParse(input);
		if (!result.success) {
			throw new InvalidAchievementRecordError({
				recordType: "definition",
				parseError: result.error.message,
			});
		}
		return result.data;
	}

	private toAchievementRuleDefinition(
		definition: AchievementDefinition,
	): AchievementRuleDefinition {
		return definition;
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

	private isRetryableAnnouncementPreflightError(error: unknown): boolean {
		return (
			TokenUnavailableWhileStreamOfflineError.is(error) ||
			TokenRefreshNetworkError.is(error) ||
			TwitchNetworkError.is(error) ||
			TwitchRateLimitError.is(error) ||
			DurableObjectError.is(error)
		);
	}
}

export const AchievementsDO = withRpcSerialization(_AchievementsDO);
