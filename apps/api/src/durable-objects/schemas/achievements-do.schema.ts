/**
 * AchievementsDO schema - tracks user achievements and unlock progress
 */

import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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
 * - announced tracks whether chat notification was sent
 */
export const userAchievements = sqliteTable(
	"user_achievements",
	{
		id: text("id").primaryKey(),
		userDisplayName: text("user_display_name").notNull(),
		achievementId: text("achievement_id").notNull(), // references achievement_definitions.id
		progress: integer("progress").notNull().default(0),
		unlockedAt: text("unlocked_at"), // ISO8601, NULL if not unlocked
		announced: integer("announced", { mode: "boolean" }).notNull().default(false),
		eventId: text("event_id"), // for idempotency on event-based achievements
	},
	(table) => [
		unique("user_achievement_unique").on(table.userDisplayName, table.achievementId),
		index("idx_user_achievements_user").on(table.userDisplayName),
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
	(table) => [index("idx_event_history_type_time").on(table.eventType, table.timestamp)],
);

export type EventHistory = typeof eventHistory.$inferSelect;
export type InsertEventHistory = typeof eventHistory.$inferInsert;
