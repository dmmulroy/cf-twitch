/**
 * Event schema unit tests
 *
 * Tests Zod validators and type guards for domain events.
 */

import { describe, expect, it } from "vitest";

import {
	EventSchema,
	EventSource,
	EventType,
	RaffleRollEventSchema,
	SongRequestSuccessEventSchema,
	StreamOfflineEventSchema,
	StreamOnlineEventSchema,
	createRaffleRollEvent,
	createSongRequestSuccessEvent,
	createStreamOfflineEvent,
	createStreamOnlineEvent,
	isRaffleRollEvent,
	isSongRequestSuccessEvent,
	isStreamOfflineEvent,
	isStreamOnlineEvent,
} from "../../../durable-objects/event-bus-do/schema";

describe("Event Schema", () => {
	describe("SongRequestSuccessEvent", () => {
		const validEvent = {
			id: "550e8400-e29b-41d4-a716-446655440000",
			type: EventType.SongRequestSuccess,
			v: 1,
			timestamp: "2026-01-30T12:00:00.000Z",
			source: EventSource.SongRequestSaga,
			userId: "user-123",
			userDisplayName: "TestUser",
			sagaId: "saga-456",
			trackId: "spotify:track:abc123",
		};

		it("should validate valid event", () => {
			const result = SongRequestSuccessEventSchema.safeParse(validEvent);
			expect(result.success).toBe(true);
		});

		it("should reject invalid type", () => {
			const result = SongRequestSuccessEventSchema.safeParse({
				...validEvent,
				type: "wrong_type",
			});
			expect(result.success).toBe(false);
		});

		it("should reject wrong version", () => {
			const result = SongRequestSuccessEventSchema.safeParse({
				...validEvent,
				v: 2,
			});
			expect(result.success).toBe(false);
		});

		it("should reject invalid UUID", () => {
			const result = SongRequestSuccessEventSchema.safeParse({
				...validEvent,
				id: "not-a-uuid",
			});
			expect(result.success).toBe(false);
		});

		it("should reject invalid timestamp", () => {
			const result = SongRequestSuccessEventSchema.safeParse({
				...validEvent,
				timestamp: "not-a-timestamp",
			});
			expect(result.success).toBe(false);
		});

		it("should reject missing required fields", () => {
			const { trackId: _, ...withoutTrackId } = validEvent;
			const result = SongRequestSuccessEventSchema.safeParse(withoutTrackId);
			expect(result.success).toBe(false);
		});
	});

	describe("RaffleRollEvent", () => {
		const validEvent = {
			id: "550e8400-e29b-41d4-a716-446655440001",
			type: EventType.RaffleRoll,
			v: 1,
			timestamp: "2026-01-30T12:00:00.000Z",
			source: EventSource.KeyboardRaffleSaga,
			userId: "user-123",
			userDisplayName: "TestUser",
			sagaId: "saga-789",
			roll: 4200,
			winningNumber: 7777,
			distance: 3577,
			isWinner: false,
		};

		it("should validate valid event", () => {
			const result = RaffleRollEventSchema.safeParse(validEvent);
			expect(result.success).toBe(true);
		});

		it("should validate winning roll", () => {
			const result = RaffleRollEventSchema.safeParse({
				...validEvent,
				roll: 7777,
				winningNumber: 7777,
				distance: 0,
				isWinner: true,
			});
			expect(result.success).toBe(true);
		});

		it("should reject roll out of range (< 1)", () => {
			const result = RaffleRollEventSchema.safeParse({
				...validEvent,
				roll: 0,
			});
			expect(result.success).toBe(false);
		});

		it("should reject roll out of range (> 10000)", () => {
			const result = RaffleRollEventSchema.safeParse({
				...validEvent,
				roll: 10001,
			});
			expect(result.success).toBe(false);
		});

		it("should reject negative distance", () => {
			const result = RaffleRollEventSchema.safeParse({
				...validEvent,
				distance: -1,
			});
			expect(result.success).toBe(false);
		});
	});

	describe("StreamOnlineEvent", () => {
		const validEvent = {
			id: "550e8400-e29b-41d4-a716-446655440002",
			type: EventType.StreamOnline,
			v: 1,
			timestamp: "2026-01-30T12:00:00.000Z",
			source: EventSource.StreamLifecycle,
			streamId: "stream-123",
			startedAt: "2026-01-30T11:55:00.000Z",
		};

		it("should validate valid event", () => {
			const result = StreamOnlineEventSchema.safeParse(validEvent);
			expect(result.success).toBe(true);
		});

		it("should reject invalid startedAt timestamp", () => {
			const result = StreamOnlineEventSchema.safeParse({
				...validEvent,
				startedAt: "invalid",
			});
			expect(result.success).toBe(false);
		});
	});

	describe("StreamOfflineEvent", () => {
		const validEvent = {
			id: "550e8400-e29b-41d4-a716-446655440003",
			type: EventType.StreamOffline,
			v: 1,
			timestamp: "2026-01-30T14:00:00.000Z",
			source: EventSource.StreamLifecycle,
			streamId: "stream-123",
			endedAt: "2026-01-30T14:00:00.000Z",
		};

		it("should validate valid event", () => {
			const result = StreamOfflineEventSchema.safeParse(validEvent);
			expect(result.success).toBe(true);
		});

		it("should reject invalid endedAt timestamp", () => {
			const result = StreamOfflineEventSchema.safeParse({
				...validEvent,
				endedAt: "invalid",
			});
			expect(result.success).toBe(false);
		});
	});

	describe("EventSchema discriminated union", () => {
		it("should parse SongRequestSuccessEvent", () => {
			const event = {
				id: "550e8400-e29b-41d4-a716-446655440000",
				type: EventType.SongRequestSuccess,
				v: 1,
				timestamp: "2026-01-30T12:00:00.000Z",
				source: EventSource.SongRequestSaga,
				userId: "user-123",
				userDisplayName: "TestUser",
				sagaId: "saga-456",
				trackId: "spotify:track:abc123",
			};
			const result = EventSchema.safeParse(event);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.type).toBe(EventType.SongRequestSuccess);
			}
		});

		it("should parse RaffleRollEvent", () => {
			const event = {
				id: "550e8400-e29b-41d4-a716-446655440001",
				type: EventType.RaffleRoll,
				v: 1,
				timestamp: "2026-01-30T12:00:00.000Z",
				source: EventSource.KeyboardRaffleSaga,
				userId: "user-123",
				userDisplayName: "TestUser",
				sagaId: "saga-789",
				roll: 4200,
				winningNumber: 7777,
				distance: 3577,
				isWinner: false,
			};
			const result = EventSchema.safeParse(event);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.type).toBe(EventType.RaffleRoll);
			}
		});

		it("should reject unknown event type", () => {
			const event = {
				id: "550e8400-e29b-41d4-a716-446655440000",
				type: "unknown_event",
				v: 1,
				timestamp: "2026-01-30T12:00:00.000Z",
				source: "UnknownDO",
			};
			const result = EventSchema.safeParse(event);
			expect(result.success).toBe(false);
		});
	});

	describe("Type guards", () => {
		const songRequestEvent = {
			id: "550e8400-e29b-41d4-a716-446655440000",
			type: "song_request_success",
			v: 1,
			timestamp: "2026-01-30T12:00:00.000Z",
			source: "SongRequestSagaDO",
			userId: "user-123",
			userDisplayName: "TestUser",
			sagaId: "saga-456",
			trackId: "spotify:track:abc123",
		} as const;

		const raffleRollEvent = {
			id: "550e8400-e29b-41d4-a716-446655440001",
			type: "raffle_roll",
			v: 1,
			timestamp: "2026-01-30T12:00:00.000Z",
			source: "KeyboardRaffleSagaDO",
			userId: "user-123",
			userDisplayName: "TestUser",
			sagaId: "saga-789",
			roll: 4200,
			winningNumber: 7777,
			distance: 3577,
			isWinner: false,
		} as const;

		const streamOnlineEvent = {
			id: "550e8400-e29b-41d4-a716-446655440002",
			type: "stream_online",
			v: 1,
			timestamp: "2026-01-30T12:00:00.000Z",
			source: "StreamLifecycleDO",
			streamId: "stream-123",
			startedAt: "2026-01-30T11:55:00.000Z",
		} as const;

		const streamOfflineEvent = {
			id: "550e8400-e29b-41d4-a716-446655440003",
			type: "stream_offline",
			v: 1,
			timestamp: "2026-01-30T14:00:00.000Z",
			source: "StreamLifecycleDO",
			streamId: "stream-123",
			endedAt: "2026-01-30T14:00:00.000Z",
		} as const;

		it("isSongRequestSuccessEvent should narrow correctly", () => {
			expect(isSongRequestSuccessEvent(songRequestEvent)).toBe(true);
			expect(isSongRequestSuccessEvent(raffleRollEvent)).toBe(false);
			expect(isSongRequestSuccessEvent(streamOnlineEvent)).toBe(false);
			expect(isSongRequestSuccessEvent(streamOfflineEvent)).toBe(false);
		});

		it("isRaffleRollEvent should narrow correctly", () => {
			expect(isRaffleRollEvent(raffleRollEvent)).toBe(true);
			expect(isRaffleRollEvent(songRequestEvent)).toBe(false);
			expect(isRaffleRollEvent(streamOnlineEvent)).toBe(false);
			expect(isRaffleRollEvent(streamOfflineEvent)).toBe(false);
		});

		it("isStreamOnlineEvent should narrow correctly", () => {
			expect(isStreamOnlineEvent(streamOnlineEvent)).toBe(true);
			expect(isStreamOnlineEvent(songRequestEvent)).toBe(false);
			expect(isStreamOnlineEvent(raffleRollEvent)).toBe(false);
			expect(isStreamOnlineEvent(streamOfflineEvent)).toBe(false);
		});

		it("isStreamOfflineEvent should narrow correctly", () => {
			expect(isStreamOfflineEvent(streamOfflineEvent)).toBe(true);
			expect(isStreamOfflineEvent(songRequestEvent)).toBe(false);
			expect(isStreamOfflineEvent(raffleRollEvent)).toBe(false);
			expect(isStreamOfflineEvent(streamOnlineEvent)).toBe(false);
		});
	});

	describe("Factory functions", () => {
		it("createSongRequestSuccessEvent should create valid event", () => {
			const event = createSongRequestSuccessEvent({
				id: "550e8400-e29b-41d4-a716-446655440000",
				userId: "user-123",
				userDisplayName: "TestUser",
				sagaId: "saga-456",
				trackId: "spotify:track:abc123",
			});

			expect(event.type).toBe(EventType.SongRequestSuccess);
			expect(event.v).toBe(1);
			expect(event.source).toBe(EventSource.SongRequestSaga);
			expect(event.userId).toBe("user-123");
			expect(event.trackId).toBe("spotify:track:abc123");

			// Validate with schema
			const result = SongRequestSuccessEventSchema.safeParse(event);
			expect(result.success).toBe(true);
		});

		it("createRaffleRollEvent should create valid event", () => {
			const event = createRaffleRollEvent({
				id: "550e8400-e29b-41d4-a716-446655440001",
				userId: "user-123",
				userDisplayName: "TestUser",
				sagaId: "saga-789",
				roll: 42,
				winningNumber: 77,
				distance: 35,
				isWinner: false,
			});

			expect(event.type).toBe(EventType.RaffleRoll);
			expect(event.v).toBe(1);
			expect(event.source).toBe(EventSource.KeyboardRaffleSaga);
			expect(event.roll).toBe(42);
			expect(event.isWinner).toBe(false);

			const result = RaffleRollEventSchema.safeParse(event);
			expect(result.success).toBe(true);
		});

		it("createStreamOnlineEvent should create valid event", () => {
			const event = createStreamOnlineEvent({
				id: "550e8400-e29b-41d4-a716-446655440002",
				streamId: "stream-123",
				startedAt: "2026-01-30T11:55:00.000Z",
			});

			expect(event.type).toBe(EventType.StreamOnline);
			expect(event.v).toBe(1);
			expect(event.source).toBe(EventSource.StreamLifecycle);
			expect(event.streamId).toBe("stream-123");

			const result = StreamOnlineEventSchema.safeParse(event);
			expect(result.success).toBe(true);
		});

		it("createStreamOfflineEvent should create valid event", () => {
			const event = createStreamOfflineEvent({
				id: "550e8400-e29b-41d4-a716-446655440003",
				streamId: "stream-123",
				endedAt: "2026-01-30T14:00:00.000Z",
			});

			expect(event.type).toBe(EventType.StreamOffline);
			expect(event.v).toBe(1);
			expect(event.source).toBe(EventSource.StreamLifecycle);
			expect(event.streamId).toBe("stream-123");

			const result = StreamOfflineEventSchema.safeParse(event);
			expect(result.success).toBe(true);
		});
	});
});
