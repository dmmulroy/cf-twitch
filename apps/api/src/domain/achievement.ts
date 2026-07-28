import { z } from "zod";

/** Runtime parser for Achievement categories. */
export const AchievementCategorySchema = z.enum([
	"song_request",
	"raffle",
	"engagement",
	"special",
]);
/** Category used to group Achievement Definitions and unlocks. */
export type AchievementCategory = z.infer<typeof AchievementCategorySchema>;

/** Runtime parser for events that can advance Achievement Progress. */
export const AchievementTriggerEventSchema = z.enum([
	"song_request",
	"stream_first_request",
	"raffle_roll",
	"raffle_win",
	"raffle_close",
	"raffle_closest_record",
	"request_streak",
]);
/** Event that can advance Achievement Progress. */
export type AchievementTriggerEvent = z.infer<typeof AchievementTriggerEventSchema>;

/** Runtime parser for cumulative or Stream Session Achievement scope. */
export const AchievementScopeSchema = z.enum(["session", "cumulative"]);
/** Lifetime over which Achievement Progress accumulates. */
export type AchievementScope = z.infer<typeof AchievementScopeSchema>;

/** Runtime parser for one Achievement Definition. */
export const AchievementDefinitionSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	description: z.string().min(1),
	icon: z.string().min(1),
	category: AchievementCategorySchema,
	threshold: z.number().int().positive().nullable(),
	triggerEvent: AchievementTriggerEventSchema,
	scope: AchievementScopeSchema,
});
/** Persisted metadata that defines one Achievement. */
export type AchievementDefinition = z.infer<typeof AchievementDefinitionSchema>;

/** Runtime parser for one unlocked Achievement projection. */
export const UnlockedAchievementSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	description: z.string().min(1),
	icon: z.string().min(1),
	category: AchievementCategorySchema,
	unlockedAt: z.iso.datetime({ offset: true }),
});
/** Achievement unlocked by a Viewer. */
export type UnlockedAchievement = z.infer<typeof UnlockedAchievementSchema>;

/** Runtime parser for one Viewer's Achievement Progress projection. */
export const ViewerAchievementProgressSchema = z.object({
	achievementId: z.string().min(1),
	name: z.string().min(1),
	description: z.string().min(1),
	icon: z.string().min(1),
	category: AchievementCategorySchema,
	threshold: z.number().int().positive().nullable(),
	progress: z.number().int().nonnegative(),
	unlocked: z.boolean(),
	unlockedAt: z.iso.datetime({ offset: true }).nullable(),
});
/** One Viewer's progress toward an Achievement. */
export type ViewerAchievementProgress = z.infer<typeof ViewerAchievementProgressSchema>;

/** Runtime parser for a Viewer ranking by unlocked Achievement count. */
export const AchievementLeaderboardEntrySchema = z.object({
	userDisplayName: z.string().min(1),
	count: z.number().int().nonnegative(),
});
/** Viewer ranking by unlocked Achievement count. */
export type AchievementLeaderboardEntry = z.infer<typeof AchievementLeaderboardEntrySchema>;

/** Runtime parser for Achievement persistence table counts exposed to administrators. */
export const AchievementDebugTableCountsSchema = z.object({
	definitions: z.number().int().nonnegative(),
	userAchievements: z.number().int().nonnegative(),
	unlockedAchievements: z.number().int().nonnegative(),
	userStreaks: z.number().int().nonnegative(),
	eventHistory: z.number().int().nonnegative(),
});
/** Achievement persistence table counts exposed to administrators. */
export type AchievementDebugTableCounts = z.infer<typeof AchievementDebugTableCountsSchema>;

/** Runtime parser for one Viewer's Achievement persistence diagnostics. */
export const AchievementDebugUserSnapshotSchema = z.object({
	requestedUser: z.string(),
	normalizedUser: z.string(),
	exactUserAchievementRows: z.number().int().nonnegative(),
	caseInsensitiveUserAchievementRows: z.number().int().nonnegative(),
	exactUnlockedRows: z.number().int().nonnegative(),
	caseInsensitiveUnlockedRows: z.number().int().nonnegative(),
	exactStreakRows: z.number().int().nonnegative(),
	caseInsensitiveStreakRows: z.number().int().nonnegative(),
	exactEventHistoryRows: z.number().int().nonnegative(),
	caseInsensitiveEventHistoryRows: z.number().int().nonnegative(),
	recentEvents: z.array(
		z.object({
			eventId: z.string(),
			eventType: z.string(),
			userId: z.string(),
			userDisplayName: z.string(),
			timestamp: z.string(),
			metadata: z.string().nullable(),
		}),
	),
	similarUsers: z.array(z.string()),
});
/** One Viewer's Achievement persistence diagnostics. */
export type AchievementDebugUserSnapshot = z.infer<typeof AchievementDebugUserSnapshotSchema>;

/** Runtime parser for a one-time Achievement reset result. */
export const AchievementResetResultSchema = z.object({
	deleted: z.number().int().nonnegative(),
	achievementIds: z.array(z.string()),
});
/** Result of resetting one-time cumulative Achievements. */
export type AchievementResetResult = z.infer<typeof AchievementResetResultSchema>;

/** Runtime parser for all public Achievement Definitions. */
export const AchievementDefinitionsSchema = z.array(AchievementDefinitionSchema);
/** Runtime parser for one Viewer's complete Achievement Progress. */
export const ViewerAchievementProgressListSchema = z.array(ViewerAchievementProgressSchema);
/** Runtime parser for one Viewer's unlocked Achievements. */
export const UnlockedAchievementsSchema = z.array(UnlockedAchievementSchema);
/** Runtime parser for a bounded Achievement leaderboard. */
export const AchievementLeaderboardSchema = z.array(AchievementLeaderboardEntrySchema).max(100);
