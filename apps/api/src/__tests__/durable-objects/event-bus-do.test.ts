/**
 * EventBusDO integration tests
 *
 * Tests public EventBus behavior through the Agent interface.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { EventBusDO } from "../../durable-objects/event-bus-do";
import * as eventBusSchema from "../../durable-objects/schemas/event-bus-do.schema";
import {
	createSongRequestSuccessEvent,
	deadLetterQueue,
	pendingEvents,
} from "../../durable-objects/schemas/event-bus-do.schema";

function createTestEvent(overrides: { id?: string } = {}) {
	return createSongRequestSuccessEvent({
		id: overrides.id ?? crypto.randomUUID(),
		userId: "user-123",
		userDisplayName: "TestUser",
		sagaId: "saga-456",
		trackId: "spotify:track:abc123",
	});
}

async function seedPendingRow(
	instance: EventBusDO,
	params: {
		id: string;
		event: string;
		attempts: number;
		nextRetryAt: string;
		createdAt: string;
	},
): Promise<void> {
	const db = drizzle(instance.ctx.storage, { schema: eventBusSchema });
	await db.insert(pendingEvents).values(params);
}

async function seedDlqRow(
	instance: EventBusDO,
	params: {
		id: string;
		event: string;
		error: string;
		attempts: number;
		firstFailedAt: string;
		lastFailedAt: string;
		expiresAt: string;
	},
): Promise<void> {
	const db = drizzle(instance.ctx.storage, { schema: eventBusSchema });
	await db.insert(deadLetterQueue).values(params);
}

describe("EventBusDO", () => {
	let stub: DurableObjectStub<EventBusDO>;
	let busName: string;

	beforeEach(async () => {
		busName = `event-bus-${crypto.randomUUID()}`;
		const id = env.EVENT_BUS_DO.idFromName(busName);
		stub = env.EVENT_BUS_DO.get(id);
		await stub.setName(busName);
		await stub.getPendingCount();
	});

	describe("publish", () => {
		it("rejects an invalid event payload", async () => {
			const result = await runInDurableObject(stub, (instance: EventBusDO) =>
				instance.publish({ invalid: true }),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("EventBusValidationError");
			}
		});

		it("delivers a valid event immediately when the handler succeeds", async () => {
			const event = createTestEvent();

			const publishResult = await stub.publish(event);
			const pendingResult = await stub.getPending();

			expect(publishResult.status).toBe("ok");
			expect(pendingResult.status).toBe("ok");
			if (pendingResult.status === "ok") {
				expect(pendingResult.value.totalCount).toBe(0);
			}
		});
	});

	describe("scheduled retry and purge callbacks", () => {
		it("restores retry and DLQ purge schedules from durable rows during onStart", async () => {
			const pendingEvent = createTestEvent();
			const futureRetryAt = new Date(Date.now() + 60_000).toISOString();
			const futureExpiresAt = new Date(Date.now() + 120_000).toISOString();
			const createdAt = new Date().toISOString();

			const schedules = await runInDurableObject(stub, async (instance: EventBusDO) => {
				await seedPendingRow(instance, {
					id: pendingEvent.id,
					event: JSON.stringify(pendingEvent),
					attempts: 0,
					nextRetryAt: futureRetryAt,
					createdAt,
				});
				await seedDlqRow(instance, {
					id: `${pendingEvent.id}-dlq`,
					event: JSON.stringify(createTestEvent({ id: `${pendingEvent.id}-dlq` })),
					error: "boom",
					attempts: 3,
					firstFailedAt: createdAt,
					lastFailedAt: createdAt,
					expiresAt: futureExpiresAt,
				});

				instance.setState({
					retrySweepScheduleId: "stale-retry-id",
					retrySweepDueAt: "2099-01-01T00:00:00.000Z",
					dlqPurgeScheduleId: "stale-dlq-id",
					dlqPurgeDueAt: "2099-01-01T00:00:00.000Z",
				});

				await instance.onStart();
				return instance.getSchedules();
			});

			expect(schedules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "scheduled",
						callback: "retryDueEventsTick",
					}),
					expect.objectContaining({
						type: "scheduled",
						callback: "purgeExpiredDlqTick",
					}),
				]),
			);
		});

		it("processes a due pending row and removes it when delivery succeeds", async () => {
			const event = createTestEvent();
			const createdAt = new Date(Date.now() - 10_000).toISOString();
			const dueAt = new Date(Date.now() - 1_000).toISOString();

			const pendingResult = await runInDurableObject(stub, async (instance: EventBusDO) => {
				await seedPendingRow(instance, {
					id: event.id,
					event: JSON.stringify(event),
					attempts: 0,
					nextRetryAt: dueAt,
					createdAt,
				});

				await instance.retryDueEventsTick();
				return instance.getPending();
			});

			expect(pendingResult.status).toBe("ok");
			if (pendingResult.status === "ok") {
				expect(pendingResult.value.totalCount).toBe(0);
			}
		});

		it("deletes corrupted pending JSON during retry processing", async () => {
			const eventId = crypto.randomUUID();
			const createdAt = new Date(Date.now() - 10_000).toISOString();
			const dueAt = new Date(Date.now() - 1_000).toISOString();

			const pendingResult = await runInDurableObject(stub, async (instance: EventBusDO) => {
				await seedPendingRow(instance, {
					id: eventId,
					event: "{invalid-json",
					attempts: 0,
					nextRetryAt: dueAt,
					createdAt,
				});

				await instance.retryDueEventsTick();
				return instance.getPending();
			});

			expect(pendingResult.status).toBe("ok");
			if (pendingResult.status === "ok") {
				expect(pendingResult.value.totalCount).toBe(0);
			}
		});

		it("purges expired DLQ rows and keeps unexpired rows", async () => {
			const expiredEvent = createTestEvent();
			const futureEvent = createTestEvent();
			const createdAt = new Date(Date.now() - 10_000).toISOString();
			const expiredAt = new Date(Date.now() - 1_000).toISOString();
			const futureExpiresAt = new Date(Date.now() + 60_000).toISOString();

			const dlqResult = await runInDurableObject(stub, async (instance: EventBusDO) => {
				await seedDlqRow(instance, {
					id: expiredEvent.id,
					event: JSON.stringify(expiredEvent),
					error: "expired",
					attempts: 3,
					firstFailedAt: createdAt,
					lastFailedAt: createdAt,
					expiresAt: expiredAt,
				});
				await seedDlqRow(instance, {
					id: futureEvent.id,
					event: JSON.stringify(futureEvent),
					error: "future",
					attempts: 3,
					firstFailedAt: createdAt,
					lastFailedAt: createdAt,
					expiresAt: futureExpiresAt,
				});

				await instance.purgeExpiredDlqTick();
				return instance.getDLQ();
			});

			expect(dlqResult.status).toBe("ok");
			if (dlqResult.status === "ok") {
				expect(dlqResult.value.totalCount).toBe(1);
				expect(dlqResult.value.items[0]).toMatchObject({ id: futureEvent.id, error: "future" });
			}
		});
	});

	describe("DLQ admin methods", () => {
		it("replays a valid DLQ row immediately and removes it when delivery succeeds", async () => {
			const event = createTestEvent();
			const createdAt = new Date(Date.now() - 10_000).toISOString();
			const expiresAt = new Date(Date.now() + 60_000).toISOString();

			const result = await runInDurableObject(stub, async (instance: EventBusDO) => {
				await seedDlqRow(instance, {
					id: event.id,
					event: JSON.stringify(event),
					error: "boom",
					attempts: 3,
					firstFailedAt: createdAt,
					lastFailedAt: createdAt,
					expiresAt,
				});

				const replayResult = await instance.replayDLQ(event.id);
				const remainingDlq = await instance.getDLQ();
				return { replayResult, remainingDlq };
			});

			expect(result.replayResult.status).toBe("ok");
			if (result.replayResult.status === "ok") {
				expect(result.replayResult.value).toEqual({ success: true, eventId: event.id });
			}
			expect(result.remainingDlq.status).toBe("ok");
			if (result.remainingDlq.status === "ok") {
				expect(result.remainingDlq.value.totalCount).toBe(0);
			}
		});

		it("deletes an existing DLQ row", async () => {
			const event = createTestEvent();
			const createdAt = new Date(Date.now() - 10_000).toISOString();
			const expiresAt = new Date(Date.now() + 60_000).toISOString();

			const result = await runInDurableObject(stub, async (instance: EventBusDO) => {
				await seedDlqRow(instance, {
					id: event.id,
					event: JSON.stringify(event),
					error: "boom",
					attempts: 3,
					firstFailedAt: createdAt,
					lastFailedAt: createdAt,
					expiresAt,
				});

				const deleteResult = await instance.deleteDLQ(event.id);
				const remainingDlq = await instance.getDLQ();
				return { deleteResult, remainingDlq };
			});

			expect(result.deleteResult.status).toBe("ok");
			expect(result.remainingDlq.status).toBe("ok");
			if (result.remainingDlq.status === "ok") {
				expect(result.remainingDlq.value.totalCount).toBe(0);
			}
		});

		it("returns DLQItemNotFoundError when deleting a missing row", async () => {
			const result = await runInDurableObject(stub, (instance: EventBusDO) =>
				instance.deleteDLQ(crypto.randomUUID()),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("DLQItemNotFoundError");
			}
		});
	});
});
