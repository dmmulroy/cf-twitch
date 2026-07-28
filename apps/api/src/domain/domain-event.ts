/**
 * Event schema types and Zod validators for EventBusDO
 *
 * All domain events extend BaseEvent. Events are published by sagas/DOs
 * and routed to subscribers (primarily AchievementsDO).
 */

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
	/** Cross-system correlation root */
	correlationId: z.string().optional(),
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
	userId: z.string().min(1),
	/** Twitch display name */
	userDisplayName: z.string().min(1),
	/** Saga instance ID (redemption ID) */
	sagaId: z.string().min(1),
	/** Roll value (1-10000) */
	roll: z.number().int().min(1).max(10000),
	/** Target winning number (1-10000) */
	winningNumber: z.number().int().min(1).max(10000),
	/** Absolute distance from winning number */
	distance: z.number().int().min(0).max(9999),
	/** Whether this roll was a winner */
	isWinner: z.boolean(),
	/** Whether this roll set a new closest non-winning record */
	isNewRecord: z.boolean(),
}).superRefine((event, context) => {
	const derivedDistance = Math.abs(event.roll - event.winningNumber);
	if (event.distance !== derivedDistance) {
		context.addIssue({
			code: "custom",
			path: ["distance"],
			message:
				"Raffle Roll distance must equal the absolute difference between roll and winning number",
		});
	}
	if (event.isWinner !== (derivedDistance === 0)) {
		context.addIssue({
			code: "custom",
			path: ["isWinner"],
			message: "Raffle Roll winner status must equal whether distance is zero",
		});
	}
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
	correlationId?: string;
}): SongRequestSuccessEvent {
	return {
		id: params.id,
		type: EventType.SongRequestSuccess,
		v: 1,
		timestamp: new Date().toISOString(),
		source: EventSource.SongRequestSaga,
		correlationId: params.correlationId,
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
	isNewRecord: boolean;
	correlationId?: string;
}): RaffleRollEvent {
	return {
		id: params.id,
		type: EventType.RaffleRoll,
		v: 1,
		timestamp: new Date().toISOString(),
		source: EventSource.KeyboardRaffleSaga,
		correlationId: params.correlationId,
		userId: params.userId,
		userDisplayName: params.userDisplayName,
		sagaId: params.sagaId,
		roll: params.roll,
		winningNumber: params.winningNumber,
		distance: params.distance,
		isWinner: params.isWinner,
		isNewRecord: params.isNewRecord,
	};
}

/**
 * Create a new StreamOnlineEvent
 */
export function createStreamOnlineEvent(params: {
	id: string;
	streamId: string;
	startedAt: string;
	correlationId?: string;
}): StreamOnlineEvent {
	return {
		id: params.id,
		type: EventType.StreamOnline,
		v: 1,
		timestamp: new Date().toISOString(),
		source: EventSource.StreamLifecycle,
		correlationId: params.correlationId,
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
	correlationId?: string;
}): StreamOfflineEvent {
	return {
		id: params.id,
		type: EventType.StreamOffline,
		v: 1,
		timestamp: new Date().toISOString(),
		source: EventSource.StreamLifecycle,
		correlationId: params.correlationId,
		streamId: params.streamId,
		endedAt: params.endedAt,
	};
}
