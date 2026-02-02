/**
 * Event schema types and Zod validators for EventBusDO
 *
 * All domain events extend BaseEvent. Events are published by sagas/DOs
 * and routed to subscribers (primarily AchievementsDO).
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

// =============================================================================
// Event Sources
// =============================================================================

/**
 * Known event source identifiers - the DO that published the event
 */
export const EventSource = {
	SongRequestSaga: "SongRequestSagaDO",
	KeyboardRaffleSaga: "KeyboardRaffleSagaDO",
	StreamLifecycle: "StreamLifecycleDO",
} as const;

export type EventSource = (typeof EventSource)[keyof typeof EventSource];

// =============================================================================
// Event Types
// =============================================================================

/**
 * Discriminant for domain events - used for routing and type narrowing
 */
export const EventType = {
	SongRequestSuccess: "song_request_success",
	RaffleRoll: "raffle_roll",
	StreamOnline: "stream_online",
	StreamOffline: "stream_offline",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

// =============================================================================
// Base Event Schema
// =============================================================================

/**
 * Base event fields present on all domain events
 */
export const BaseEventSchema = z.object({
	/** UUID - idempotency key for deduplication */
	id: z.string().uuid(),
	/** Event type discriminant */
	type: z.string(),
	/** Schema version for evolution */
	v: z.number().int().positive(),
	/** ISO8601 timestamp when event occurred */
	timestamp: z.string().datetime(),
	/** Publisher DO name */
	source: z.string(),
});

export type BaseEvent = z.infer<typeof BaseEventSchema>;

// =============================================================================
// Song Request Success Event
// =============================================================================

/**
 * Published when a song request saga completes successfully
 */
export const SongRequestSuccessEventSchema = BaseEventSchema.extend({
	type: z.literal(EventType.SongRequestSuccess),
	v: z.literal(1),
	source: z.literal(EventSource.SongRequestSaga),
	/** Twitch user ID */
	userId: z.string(),
	/** Twitch display name */
	userDisplayName: z.string(),
	/** Saga instance ID (redemption ID) */
	sagaId: z.string(),
	/** Spotify track ID that was queued */
	trackId: z.string(),
});

export type SongRequestSuccessEvent = z.infer<typeof SongRequestSuccessEventSchema>;

// =============================================================================
// Raffle Roll Event
// =============================================================================

/**
 * Published when a keyboard raffle roll completes
 */
export const RaffleRollEventSchema = BaseEventSchema.extend({
	type: z.literal(EventType.RaffleRoll),
	v: z.literal(1),
	source: z.literal(EventSource.KeyboardRaffleSaga),
	/** Twitch user ID */
	userId: z.string(),
	/** Twitch display name */
	userDisplayName: z.string(),
	/** Saga instance ID (redemption ID) */
	sagaId: z.string(),
	/** Roll value (1-10000) */
	roll: z.number().int().min(1).max(10000),
	/** Target winning number (1-10000) */
	winningNumber: z.number().int().min(1).max(10000),
	/** Absolute distance from winning number */
	distance: z.number().int().min(0).max(9999),
	/** Whether this roll was a winner */
	isWinner: z.boolean(),
});

export type RaffleRollEvent = z.infer<typeof RaffleRollEventSchema>;

// =============================================================================
// Stream Online Event
// =============================================================================

/**
 * Published when stream goes online
 */
export const StreamOnlineEventSchema = BaseEventSchema.extend({
	type: z.literal(EventType.StreamOnline),
	v: z.literal(1),
	source: z.literal(EventSource.StreamLifecycle),
	/** Twitch stream ID */
	streamId: z.string(),
	/** ISO8601 timestamp when stream started */
	startedAt: z.string().datetime(),
});

export type StreamOnlineEvent = z.infer<typeof StreamOnlineEventSchema>;

// =============================================================================
// Stream Offline Event
// =============================================================================

/**
 * Published when stream goes offline
 */
export const StreamOfflineEventSchema = BaseEventSchema.extend({
	type: z.literal(EventType.StreamOffline),
	v: z.literal(1),
	source: z.literal(EventSource.StreamLifecycle),
	/** Twitch stream ID */
	streamId: z.string(),
	/** ISO8601 timestamp when stream ended */
	endedAt: z.string().datetime(),
});

export type StreamOfflineEvent = z.infer<typeof StreamOfflineEventSchema>;

// =============================================================================
// Event Union
// =============================================================================

/**
 * Discriminated union of all events
 */
export const EventSchema = z.discriminatedUnion("type", [
	SongRequestSuccessEventSchema,
	RaffleRollEventSchema,
	StreamOnlineEventSchema,
	StreamOfflineEventSchema,
]);

export type Event = z.infer<typeof EventSchema>;

// =============================================================================
// Type Guards
// =============================================================================

export function isSongRequestSuccessEvent(event: Event): event is SongRequestSuccessEvent {
	return event.type === EventType.SongRequestSuccess;
}

export function isRaffleRollEvent(event: Event): event is RaffleRollEvent {
	return event.type === EventType.RaffleRoll;
}

export function isStreamOnlineEvent(event: Event): event is StreamOnlineEvent {
	return event.type === EventType.StreamOnline;
}

export function isStreamOfflineEvent(event: Event): event is StreamOfflineEvent {
	return event.type === EventType.StreamOffline;
}

// =============================================================================
// Pending Events Table (Drizzle Schema)
// =============================================================================

/**
 * Pending events table - stores events awaiting delivery or retry
 *
 * Events are inserted when initial delivery fails. Alarms process
 * retries with exponential backoff. After max attempts, events move to DLQ.
 */
export const pendingEvents = sqliteTable(
	"pending_events",
	{
		id: text("id").primaryKey(), // Event ID (UUID)
		event: text("event").notNull(), // JSON-serialized Event
		attempts: integer("attempts").notNull().default(0), // Delivery attempts so far
		nextRetryAt: text("next_retry_at").notNull(), // ISO8601 timestamp for next retry
		createdAt: text("created_at").notNull(), // ISO8601 when event was first queued
	},
	(table) => [index("idx_pending_next_retry").on(table.nextRetryAt)],
);

export type PendingEvent = typeof pendingEvents.$inferSelect;
export type InsertPendingEvent = typeof pendingEvents.$inferInsert;

// =============================================================================
// Dead Letter Queue Table (Drizzle Schema)
// =============================================================================

/**
 * Dead letter queue table - stores events that exhausted all retry attempts
 *
 * Events move here after MAX_ATTEMPTS failures. Can be inspected, replayed,
 * or deleted via admin API. Auto-purged after 30 days.
 */
export const deadLetterQueue = sqliteTable(
	"dead_letter_queue",
	{
		id: text("id").primaryKey(), // Event ID (UUID)
		event: text("event").notNull(), // JSON-serialized Event
		error: text("error").notNull(), // Last error message
		attempts: integer("attempts").notNull(), // Total delivery attempts
		firstFailedAt: text("first_failed_at").notNull(), // ISO8601 when first queued
		lastFailedAt: text("last_failed_at").notNull(), // ISO8601 of last attempt
		expiresAt: text("expires_at").notNull(), // ISO8601 - 30 days from first failure
	},
	(table) => [index("idx_dlq_expires_at").on(table.expiresAt)],
);

export type DeadLetterEvent = typeof deadLetterQueue.$inferSelect;
export type InsertDeadLetterEvent = typeof deadLetterQueue.$inferInsert;

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a new SongRequestSuccessEvent
 */
export function createSongRequestSuccessEvent(params: {
	id: string;
	userId: string;
	userDisplayName: string;
	sagaId: string;
	trackId: string;
}): SongRequestSuccessEvent {
	return {
		id: params.id,
		type: EventType.SongRequestSuccess,
		v: 1,
		timestamp: new Date().toISOString(),
		source: EventSource.SongRequestSaga,
		userId: params.userId,
		userDisplayName: params.userDisplayName,
		sagaId: params.sagaId,
		trackId: params.trackId,
	};
}

/**
 * Create a new RaffleRollEvent
 */
export function createRaffleRollEvent(params: {
	id: string;
	userId: string;
	userDisplayName: string;
	sagaId: string;
	roll: number;
	winningNumber: number;
	distance: number;
	isWinner: boolean;
}): RaffleRollEvent {
	return {
		id: params.id,
		type: EventType.RaffleRoll,
		v: 1,
		timestamp: new Date().toISOString(),
		source: EventSource.KeyboardRaffleSaga,
		userId: params.userId,
		userDisplayName: params.userDisplayName,
		sagaId: params.sagaId,
		roll: params.roll,
		winningNumber: params.winningNumber,
		distance: params.distance,
		isWinner: params.isWinner,
	};
}

/**
 * Create a new StreamOnlineEvent
 */
export function createStreamOnlineEvent(params: {
	id: string;
	streamId: string;
	startedAt: string;
}): StreamOnlineEvent {
	return {
		id: params.id,
		type: EventType.StreamOnline,
		v: 1,
		timestamp: new Date().toISOString(),
		source: EventSource.StreamLifecycle,
		streamId: params.streamId,
		startedAt: params.startedAt,
	};
}

/**
 * Create a new StreamOfflineEvent
 */
export function createStreamOfflineEvent(params: {
	id: string;
	streamId: string;
	endedAt: string;
}): StreamOfflineEvent {
	return {
		id: params.id,
		type: EventType.StreamOffline,
		v: 1,
		timestamp: new Date().toISOString(),
		source: EventSource.StreamLifecycle,
		streamId: params.streamId,
		endedAt: params.endedAt,
	};
}
