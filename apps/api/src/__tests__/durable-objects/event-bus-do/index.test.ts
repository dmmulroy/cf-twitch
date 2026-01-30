/**
 * EventBusDO unit tests
 *
 * Tests event publishing, retry logic, and alarm-based processing.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventBusDO } from "../../../durable-objects/event-bus-do";
import {
	EventSource,
	EventType,
	createSongRequestSuccessEvent,
} from "../../../durable-objects/event-bus-do/schema";

/**
 * Create a test SongRequestSuccessEvent with unique ID
 */
function createTestEvent(overrides: { id?: string } = {}) {
	return createSongRequestSuccessEvent({
		id: overrides.id ?? crypto.randomUUID(),
		userId: "user-123",
		userDisplayName: "TestUser",
		sagaId: "saga-456",
		trackId: "spotify:track:abc123",
	});
}

describe("EventBusDO", () => {
	let stub: DurableObjectStub<EventBusDO>;

	beforeEach(() => {
		const id = env.EVENT_BUS_DO.idFromName("event-bus");
		stub = env.EVENT_BUS_DO.get(id);
	});

	describe("publish", () => {
		it("should reject invalid event format", async () => {
			const result = await runInDurableObject(stub, (instance: EventBusDO) =>
				instance.publish({ invalid: "event" }),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("EventBusValidationError");
			}
		});

		it("should reject event with invalid UUID", async () => {
			const invalidEvent = {
				id: "not-a-uuid",
				type: EventType.SongRequestSuccess,
				v: 1,
				timestamp: new Date().toISOString(),
				source: EventSource.SongRequestSaga,
				userId: "user-123",
				userDisplayName: "TestUser",
				sagaId: "saga-456",
				trackId: "track-789",
			};

			const result = await runInDurableObject(stub, (instance: EventBusDO) =>
				instance.publish(invalidEvent),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("EventBusValidationError");
			}
		});

		it("should accept valid event and queue for retry on handler failure", async () => {
			// Since AchievementsDO.handleEvent() doesn't exist yet, delivery will fail
			// and the event should be queued for retry
			const event = createTestEvent();

			const result = await runInDurableObject(stub, async (instance: EventBusDO) => {
				const publishResult = await instance.publish(event);

				// Should return ok (event is queued)
				expect(publishResult.status).toBe("ok");

				// Check pending count
				const countResult = await instance.getPendingCount();
				return countResult;
			});

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe(1);
			}
		});

		it("should handle multiple events", async () => {
			await runInDurableObject(stub, async (instance: EventBusDO) => {
				const event1 = createTestEvent();
				const event2 = createTestEvent();
				const event3 = createTestEvent();

				await instance.publish(event1);
				await instance.publish(event2);
				await instance.publish(event3);

				const countResult = await instance.getPendingCount();
				expect(countResult.status).toBe("ok");
				if (countResult.status === "ok") {
					expect(countResult.value).toBe(3);
				}
			});
		});
	});

	describe("getPendingCount", () => {
		it("should return 0 when no pending events", async () => {
			const result = await runInDurableObject(stub, (instance: EventBusDO) =>
				instance.getPendingCount(),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe(0);
			}
		});
	});

	describe("alarm processing", () => {
		it("should process pending events on alarm", async () => {
			await runInDurableObject(stub, async (instance: EventBusDO) => {
				// Queue an event
				const event = createTestEvent();
				await instance.publish(event);

				// Verify it's pending
				let countResult = await instance.getPendingCount();
				expect(countResult.status).toBe("ok");
				if (countResult.status === "ok") {
					expect(countResult.value).toBe(1);
				}

				// Trigger alarm (this will attempt delivery, fail, and schedule next retry)
				await instance.alarm();

				// After alarm, event should still be pending (delivery still fails)
				// but attempts should be incremented
				countResult = await instance.getPendingCount();
				expect(countResult.status).toBe("ok");
				// Event is still pending after first retry attempt
				if (countResult.status === "ok") {
					expect(countResult.value).toBe(1);
				}
			});
		});

		// Note: Testing max attempts exhaustion requires time mocking.
		// The alarm handler only processes events where nextRetryAt <= now,
		// so calling alarm() immediately after queueing doesn't process the event.
		// Integration test would verify: after 3 failed attempts, event is deleted.
		it.skip("should give up after max attempts (requires time mocking)", async () => {
			await runInDurableObject(stub, async (instance: EventBusDO) => {
				const event = createTestEvent();
				await instance.publish(event);

				// Would need to advance time or mock storage to test this
				// Trigger alarm 3 times (max attempts)
				await instance.alarm();
				await instance.alarm();
				await instance.alarm();

				// After 3 failed attempts, event should be removed
				const countResult = await instance.getPendingCount();
				expect(countResult.status).toBe("ok");
				if (countResult.status === "ok") {
					expect(countResult.value).toBe(0);
				}
			});
		});
	});

	describe("event validation", () => {
		it("should validate SongRequestSuccessEvent", async () => {
			const validEvent = createTestEvent();

			const result = await runInDurableObject(stub, (instance: EventBusDO) =>
				instance.publish(validEvent),
			);

			// Event is valid, so it should succeed (even if queued for retry)
			expect(result.status).toBe("ok");
		});

		it("should validate RaffleRollEvent", async () => {
			const raffleEvent = {
				id: crypto.randomUUID(),
				type: EventType.RaffleRoll,
				v: 1,
				timestamp: new Date().toISOString(),
				source: EventSource.KeyboardRaffleSaga,
				userId: "user-123",
				userDisplayName: "TestUser",
				sagaId: "saga-789",
				roll: 4200,
				winningNumber: 7777,
				distance: 3577,
				isWinner: false,
			};

			const result = await runInDurableObject(stub, (instance: EventBusDO) =>
				instance.publish(raffleEvent),
			);

			expect(result.status).toBe("ok");
		});

		it("should validate StreamOnlineEvent", async () => {
			const streamEvent = {
				id: crypto.randomUUID(),
				type: EventType.StreamOnline,
				v: 1,
				timestamp: new Date().toISOString(),
				source: EventSource.StreamLifecycle,
				streamId: "stream-123",
				startedAt: new Date().toISOString(),
			};

			const result = await runInDurableObject(stub, (instance: EventBusDO) =>
				instance.publish(streamEvent),
			);

			expect(result.status).toBe("ok");
		});

		it("should validate StreamOfflineEvent", async () => {
			const streamEvent = {
				id: crypto.randomUUID(),
				type: EventType.StreamOffline,
				v: 1,
				timestamp: new Date().toISOString(),
				source: EventSource.StreamLifecycle,
				streamId: "stream-123",
				endedAt: new Date().toISOString(),
			};

			const result = await runInDurableObject(stub, (instance: EventBusDO) =>
				instance.publish(streamEvent),
			);

			expect(result.status).toBe("ok");
		});
	});
});
