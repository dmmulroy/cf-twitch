/**
 * AchievementsDO schema - tracks user achievements and unlock progress
 */

import { index, integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Achievement definitions - static achievement metadata
 * Seeded on DO initialization, updated via migrations
 */
export const achievementDefinitions = sqliteTable("achievement_definitions", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	description: text("description").notNull(),
	icon: text("icon").notNull(),
	category: text("category").notNull(), // 'song_request' | 'raffle' | 'engagement' | 'special'
	threshold: integer("threshold"), // NULL for event-based achievements
	triggerEvent: text("trigger_event").notNull(), // event type that increments progress
	scope: text("scope").notNull().default("cumulative"), // 'session' | 'cumulative'
});

export type AchievementDefinition = typeof achievementDefinitions.$inferSelect;
export type InsertAchievementDefinition = typeof achievementDefinitions.$inferInsert;

/**
 * User achievement progress and unlock status
 * - Progress incremented on matching events
 * - unlockedAt populated when threshold reached (or first event for event-based)
 * - announcement_state records the honest pending/sent chat lifecycle projection
 */
export const userAchievements = sqliteTable(
	"user_achievements",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		userDisplayName: text("user_display_name").notNull(),
		achievementId: text("achievement_id").notNull(),
		progress: integer("progress").notNull().default(0),
		unlockedAt: text("unlocked_at"),
		announcementState: text("announcement_state").notNull().default("pending"),
		eventId: text("event_id"),
	},
	(table) => [
		unique("user_achievement_viewer_unique").on(table.userId, table.achievementId),
		index("idx_user_achievements_viewer").on(table.userId),
		index("idx_user_achievements_display_name").on(table.userDisplayName),
		index("idx_user_achievements_unlocked").on(table.unlockedAt),
	],
);

export type UserAchievement = typeof userAchievements.$inferSelect;
export type InsertUserAchievement = typeof userAchievements.$inferInsert;

/**
 * User streaks - tracks song request streaks per user
 * - session_streak: resets on stream_online event
 * - longest_streak: high watermark, never resets
 * - session_started_at: tracks which stream session the current streak belongs to
 */
export const userStreaks = sqliteTable("user_streaks", {
	userId: text("user_id").primaryKey(),
	userDisplayName: text("user_display_name").notNull(),
	sessionStreak: integer("session_streak").notNull().default(0),
	longestStreak: integer("longest_streak").notNull().default(0),
	lastRequestAt: text("last_request_at"), // ISO8601
	sessionStartedAt: text("session_started_at"), // ISO8601, set on stream_online
});

export type UserStreak = typeof userStreaks.$inferSelect;
export type InsertUserStreak = typeof userStreaks.$inferInsert;

/**
 * Event history - tracks events for "first request of stream" checks
 * Used to determine if a user has already triggered a specific event type
 */
export const eventHistory = sqliteTable(
	"event_history",
	{
		id: text("id").primaryKey(),
		eventType: text("event_type").notNull(),
		userId: text("user_id").notNull(),
		userDisplayName: text("user_display_name").notNull(),
		eventId: text("event_id").notNull(), // idempotency key from saga
		timestamp: text("timestamp").notNull(), // ISO8601
		metadata: text("metadata"), // JSON for event-specific data
	},
	(table) => [
		index("idx_event_history_type_time").on(table.eventType, table.timestamp),
		uniqueIndex("idx_event_history_event_id").on(table.eventId),
	],
);

export type EventHistory = typeof eventHistory.$inferSelect;
export type InsertEventHistory = typeof eventHistory.$inferInsert;

/** Persisted ordering watermark for Achievement Stream Session transitions. */
export const achievementStreamSession = sqliteTable("achievement_stream_session", {
	singletonId: integer("singleton_id").primaryKey().default(1),
	status: text("status").notNull(),
	streamId: text("stream_id"),
	startedAt: text("started_at"),
	transitionAt: text("transition_at").notNull(),
});

/** Transactional outbox for analytics and chat effects created by an Achievement unlock. */
export const achievementUnlockOutbox = sqliteTable(
	"achievement_unlock_outbox",
	{
		effectId: text("effect_id").primaryKey(),
		eventId: text("event_id").notNull(),
		userId: text("user_id").notNull(),
		userDisplayName: text("user_display_name").notNull(),
		achievementId: text("achievement_id").notNull(),
		achievementName: text("achievement_name").notNull(),
		achievementDescription: text("achievement_description").notNull(),
		category: text("category").notNull(),
		metricState: text("metric_state").notNull().default("pending"),
		announcementState: text("announcement_state").notNull().default("pending"),
		announcementAttempts: integer("announcement_attempts").notNull().default(0),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("idx_achievement_unlock_outbox_pending").on(table.announcementState, table.metricState),
	],
);
