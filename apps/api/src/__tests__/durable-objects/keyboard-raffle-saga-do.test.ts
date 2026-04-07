/**
 * KeyboardRaffleSagaDO integration tests
 *
 * Tests the public Agent contract for keyboard raffle saga startup, retry
 * scheduling, scheduled resume, and status transitions.
 */

import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import { EventBusDO } from "../../durable-objects/event-bus-do";
import { KeyboardRaffleSagaDO } from "../../durable-objects/keyboard-raffle-saga-do";
import * as sagaSchema from "../../durable-objects/schemas/saga.schema";
import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import {
	VALID_TOKEN_RESPONSE as VALID_TWITCH_TOKEN_RESPONSE,
	mockTwitchChatMessage,
	mockTwitchRedemptionUpdate,
} from "../fixtures/twitch";

import type { KeyboardRaffleParams } from "../../durable-objects/keyboard-raffle-saga-do";

const KEYBOARD_RAFFLE_PARAMS: KeyboardRaffleParams = {
	id: "redemption-123",
	broadcaster_user_id: "12345",
	broadcaster_user_login: "teststreamer",
	broadcaster_user_name: "TestStreamer",
	user_id: "user-123",
	user_login: "testuser",
	user_name: "TestUser",
	user_input: "keyboard raffle",
	status: "unfulfilled",
	reward: {
		id: "test-keyboard-reward",
		title: "Keyboard Raffle",
		cost: 100,
		prompt: "Roll for the keyboard",
	},
	redeemed_at: "2026-01-22T12:00:00.000Z",
};

function createKeyboardRaffleParams(
	overrides: Partial<KeyboardRaffleParams> = {},
): KeyboardRaffleParams {
	return {
		...KEYBOARD_RAFFLE_PARAMS,
		...overrides,
		id: overrides.id ?? `redemption-${Date.now()}`,
	};
}

async function createKeyboardRaffleSagaStub(
	name: string,
): Promise<DurableObjectStub<KeyboardRaffleSagaDO>> {
	const id = env.KEYBOARD_RAFFLE_SAGA_DO.idFromName(name);
	const stub = env.KEYBOARD_RAFFLE_SAGA_DO.get(id);
	await stub.setName(name);
	await stub.getStatus();
	return stub;
}

async function ensureTwitchTokenStub(): Promise<DurableObjectStub<TwitchTokenDO>> {
	const id = env.TWITCH_TOKEN_DO.idFromName("twitch-token");
	const stub = env.TWITCH_TOKEN_DO.get(id);
	await stub.setName("twitch-token");
	await stub.setTokens(VALID_TWITCH_TOKEN_RESPONSE);
	return stub;
}

async function ensureEventBusStub(): Promise<DurableObjectStub<EventBusDO>> {
	const id = env.EVENT_BUS_DO.idFromName("event-bus");
	const stub = env.EVENT_BUS_DO.get(id);
	await stub.setName("event-bus");
	await stub.getPendingCount();
	return stub;
}

async function cancelKeyboardRaffleSagaSchedules(
	stub: DurableObjectStub<KeyboardRaffleSagaDO>,
): Promise<void> {
	await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
		for (const schedule of instance.getSchedules()) {
			await instance.cancelSchedule(schedule.id);
		}
	});
}

describe("KeyboardRaffleSagaDO", () => {
	it("returns null status before a saga starts", async () => {
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);

		const result = await stub.getStatus();

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toBeNull();
		}
	});

	it("resumes a pending retry via the scheduled callback and completes the saga", async () => {
		await ensureTwitchTokenStub();
		await ensureEventBusStub();

		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);
		const now = new Date().toISOString();
		const dueAt = new Date(Date.now() - 1_000).toISOString();
		const params = createKeyboardRaffleParams({
			id: `redemption-${crypto.randomUUID()}`,
		});

		await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();

			await db.insert(sagaSchema.sagaRuns).values({
				id: sagaId,
				status: "RUNNING",
				paramsJson: JSON.stringify(params),
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(sagaSchema.sagaSteps).values([
				{
					sagaId,
					stepName: "generate-winning-number",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify(777),
				},
				{
					sagaId,
					stepName: "generate-user-roll",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify(770),
				},
				{
					sagaId,
					stepName: "record-roll",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify({ rollId: sagaId, isNewRecord: true }),
					undoJson: JSON.stringify(sagaId),
				},
				{
					sagaId,
					stepName: "fulfill-redemption",
					state: "PENDING",
					attempt: 1,
					nextRetryAt: dueAt,
					lastError: "Twitch API error (503) during updateRedemptionStatus",
				},
			]);
		});

		mockTwitchRedemptionUpdate(fetchMock);
		mockTwitchChatMessage(fetchMock);
		mockTwitchChatMessage(fetchMock);
		mockTwitchChatMessage(fetchMock);
		mockTwitchChatMessage(fetchMock);

		await stub.retrySagaTick();
		await cancelKeyboardRaffleSagaSchedules(stub);

		const statusResult = await stub.getStatus();
		expect(statusResult.status).toBe("ok");
		if (statusResult.status === "ok") {
			expect(statusResult.value).toMatchObject({
				status: "COMPLETED",
			});
		}
	});

	it("restores a pending retry schedule from durable saga rows during startup", async () => {
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);
		const now = new Date().toISOString();
		const dueAt = new Date(Date.now() + 60_000).toISOString();
		const params = createKeyboardRaffleParams({
			id: `redemption-${crypto.randomUUID()}`,
		});

		const schedules = await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			await db.insert(sagaSchema.sagaRuns).values({
				id: instance.ctx.id.toString(),
				status: "RUNNING",
				paramsJson: JSON.stringify(params),
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(sagaSchema.sagaSteps).values({
				sagaId: instance.ctx.id.toString(),
				stepName: "fulfill-redemption",
				state: "PENDING",
				attempt: 1,
				nextRetryAt: dueAt,
				lastError: "Twitch API error (503) during updateRedemptionStatus",
			});

			instance.setState({
				retryScheduleId: "stale-retry-id",
				retryDueAt: "2099-01-01T00:00:00.000Z",
			});
			await instance.onStart();
			return instance.getSchedules();
		});

		expect(schedules).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "scheduled",
					callback: "retrySagaTick",
				}),
			]),
		);
	});
});
