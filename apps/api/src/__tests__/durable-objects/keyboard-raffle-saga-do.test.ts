/**
 * KeyboardRaffleSagaDO integration tests
 *
 * Tests the public Agent contract for keyboard raffle saga startup, retry
 * scheduling, scheduled resume, and status transitions.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vite-plus/test";

import { EventBusDO } from "../../durable-objects/event-bus-do";
import { KeyboardRaffleDO } from "../../durable-objects/keyboard-raffle-do";
import { KeyboardRaffleSagaDO } from "../../durable-objects/keyboard-raffle-saga-do";
import * as raffleSchema from "../../durable-objects/schemas/keyboard-raffle-do.schema";
import * as sagaSchema from "../../durable-objects/schemas/saga.schema";
import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import { getStub } from "../../lib/durable-objects";
import {
	VALID_TOKEN_RESPONSE as VALID_TWITCH_TOKEN_RESPONSE,
	mockTwitchChatMessage,
	mockTwitchRedemptionUpdate,
} from "../fixtures/twitch";
import {
	ensureAchievementsSingletonStub,
	waitForAchievementQueuesToDrain,
} from "../helpers/durable-objects";
import { fetchMock } from "../helpers/fetch-mock";

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

async function ensureKeyboardRaffleStub(): Promise<DurableObjectStub<KeyboardRaffleDO>> {
	const id = env.KEYBOARD_RAFFLE_DO.idFromName("keyboard-raffle");
	const stub = env.KEYBOARD_RAFFLE_DO.get(id);
	await stub.setName("keyboard-raffle");
	await stub.getClosestRecord();
	return stub;
}

function mockTwitchRedemptionFailure(status: number): void {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({
				path: /\/helix\/channel_points\/custom_rewards\/redemptions/,
				method: "PATCH",
			})
			.reply(status, "Redemption update failed");
	}
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
	it("rejects invalid parameters before persistence or raffle effects", async () => {
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);
		const raffle = getStub("KEYBOARD_RAFFLE_DO");
		const userId = `invalid-${crypto.randomUUID()}`;

		const result = await stub.start({
			...createKeyboardRaffleParams({ user_id: userId }),
			user_input: 42,
		});

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaInputParseError",
				codecName: "keyboard-raffle-params",
			});
		}
		expect(await stub.getStatus()).toEqual({ status: "ok", value: null });
		expect((await raffle.getUserStats(userId)).status).toBe("error");
	});

	it("returns null status before a saga starts", async () => {
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);

		const result = await stub.getStatus();

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toBeNull();
		}
	});

	it("clears a legacy Durable Object alarm during inherited startup", async () => {
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);

		const alarm = await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			await instance.ctx.storage.setAlarm(Date.now() + 60_000);
			await instance.onStart();
			return instance.ctx.storage.getAlarm();
		});

		expect(alarm).toBeNull();
	});

	it("stops before random generation and effects when persisted parameters are malformed", async () => {
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);
		const params = createKeyboardRaffleParams({ id: `redemption-${crypto.randomUUID()}` });
		await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const now = new Date().toISOString();
			await db.insert(sagaSchema.sagaRuns).values({
				id: instance.ctx.id.toString(),
				status: "RUNNING",
				paramsJson: JSON.stringify({ ...params, user_input: 42 }),
				createdAt: now,
				updatedAt: now,
			});
		});

		const result = await stub.start(params);

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaPersistedDataError",
				field: "params",
				codecName: "keyboard-raffle-params",
			});
		}
		const steps = await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return db.query.sagaSteps.findMany();
		});
		expect(steps).toEqual([]);
	});

	it("rejects malformed cached random values without regenerating a Roll", async () => {
		await ensureTwitchTokenStub();
		const raffle = await ensureKeyboardRaffleStub();

		for (const malformedStep of ["generate-winning-number", "generate-user-roll"] as const) {
			const stub = await createKeyboardRaffleSagaStub(
				`keyboard-raffle-saga-${crypto.randomUUID()}`,
			);
			const userId = `malformed-random-${crypto.randomUUID()}`;
			const params = createKeyboardRaffleParams({
				id: `redemption-${crypto.randomUUID()}`,
				user_id: userId,
			});
			await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
				const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
				const sagaId = instance.ctx.id.toString();
				const now = new Date().toISOString();
				await db.insert(sagaSchema.sagaRuns).values({
					id: sagaId,
					status: "RUNNING",
					paramsJson: JSON.stringify(params),
					createdAt: now,
					updatedAt: now,
				});
				await db.insert(sagaSchema.sagaSteps).values(
					malformedStep === "generate-winning-number"
						? {
								sagaId,
								stepName: malformedStep,
								state: "SUCCEEDED",
								attempt: 1,
								resultJson: JSON.stringify(0),
							}
						: [
								{
									sagaId,
									stepName: "generate-winning-number",
									state: "SUCCEEDED",
									attempt: 1,
									resultJson: JSON.stringify(777),
								},
								{
									sagaId,
									stepName: malformedStep,
									state: "SUCCEEDED",
									attempt: 1,
									resultJson: JSON.stringify(10001),
								},
							],
				);
			});
			mockTwitchRedemptionUpdate(fetchMock);

			const result = await stub.start(params);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error).toMatchObject({
					_tag: "SagaPersistedDataError",
					field: "step-result",
					stepName: malformedStep,
					codecName: "keyboard-raffle-number",
				});
			}
			const roll = await runInDurableObject(raffle, async (instance: KeyboardRaffleDO) => {
				const db = drizzle(instance.ctx.storage, { schema: raffleSchema });
				return db.query.rolls.findFirst({
					where: (row, operators) => operators.eq(row.userId, userId),
				});
			});
			expect(roll).toBeUndefined();
		}
	});

	it("replays cached random values and preserves the original Distance and win status", async () => {
		await ensureTwitchTokenStub();
		await ensureEventBusStub();
		const achievements = await ensureAchievementsSingletonStub();
		const raffle = await ensureKeyboardRaffleStub();
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);
		const userId = `cached-roll-${crypto.randomUUID()}`;
		const params = createKeyboardRaffleParams({
			id: `redemption-${crypto.randomUUID()}`,
			user_id: userId,
			user_name: `CachedViewer${crypto.randomUUID()}`,
		});
		await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const now = new Date().toISOString();
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
			]);
		});
		mockTwitchRedemptionUpdate(fetchMock);
		for (let message = 0; message < 4; message += 1) mockTwitchChatMessage(fetchMock);

		const result = await stub.start({
			...params,
			user_id: `different-${crypto.randomUUID()}`,
			user_name: "DifferentViewer",
		});
		expect(result.status).toBe("ok");
		await waitForAchievementQueuesToDrain(achievements, params.user_name);

		const roll = await runInDurableObject(raffle, async (instance: KeyboardRaffleDO) => {
			const db = drizzle(instance.ctx.storage, { schema: raffleSchema });
			return db.query.rolls.findFirst({
				where: (row, operators) => operators.eq(row.id, stub.id.toString()),
			});
		});
		expect(roll).toMatchObject({
			userId,
			roll: 770,
			winningNumber: 777,
			distance: 7,
			isWinner: false,
		});

		const duplicate = await stub.start({
			...params,
			user_name: "AnotherViewer",
			user_input: "different valid input",
		});
		expect(duplicate.status).toBe("ok");
		const persisted = await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return db.query.sagaRuns.findFirst();
		});
		expect(persisted?.paramsJson).toBe(JSON.stringify(params));
		const rows = await runInDurableObject(raffle, async (instance: KeyboardRaffleDO) => {
			const db = drizzle(instance.ctx.storage, { schema: raffleSchema });
			return db.query.rolls.findMany({
				where: (row, operators) => operators.eq(row.id, stub.id.toString()),
			});
		});
		expect(rows).toHaveLength(1);
	});

	it("never passes malformed recorded-roll undo data to compensation", async () => {
		await ensureTwitchTokenStub();
		const raffle = await ensureKeyboardRaffleStub();
		const protectedUserId = `protected-${crypto.randomUUID()}`;
		const protectedRoll = await raffle.recordRoll({
			id: "42",
			userId: protectedUserId,
			displayName: "ProtectedViewer",
			roll: 700,
			winningNumber: 777,
			distance: 77,
			isWinner: false,
			rolledAt: new Date().toISOString(),
		});
		expect(protectedRoll.status).toBe("ok");

		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);
		const params = createKeyboardRaffleParams({ id: `redemption-${crypto.randomUUID()}` });
		await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const now = new Date().toISOString();
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
					undoJson: JSON.stringify(42),
				},
			]);
		});
		mockTwitchRedemptionUpdate(fetchMock);

		const result = await stub.start(params);

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaPersistedDataError",
				field: "step-undo",
				stepName: "record-roll",
				codecName: "keyboard-raffle-roll-id",
			});
		}
		const protectedStats = await raffle.getUserStats(protectedUserId);
		expect(protectedStats.status).toBe("ok");
	});

	it("persists retry evidence, schedules once, and resumes without repeating successful steps", async () => {
		await ensureTwitchTokenStub();
		await ensureEventBusStub();
		const achievements = await ensureAchievementsSingletonStub();
		const raffle = await ensureKeyboardRaffleStub();
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);
		const params = createKeyboardRaffleParams({
			id: `redemption-${crypto.randomUUID()}`,
			user_id: `retry-${crypto.randomUUID()}`,
			user_name: `RetryViewer${crypto.randomUUID()}`,
		});
		mockTwitchRedemptionFailure(503);

		const start = await stub.start({ ...params, _tag: "KeyboardRaffleRedemption" });

		expect(start.status).toBe("error");
		if (start.status === "error") {
			expect(start.error).toMatchObject({
				_tag: "SagaStepRetrying",
				stepName: "fulfill-redemption",
				attempt: 1,
			});
		}
		const retryState = await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return {
				saga: await db.query.sagaRuns.findFirst(),
				steps: await db.query.sagaSteps.findMany(),
				schedules: instance.getSchedules(),
			};
		});
		expect(retryState.saga?.paramsJson).toBe(JSON.stringify(params));
		expect(retryState.schedules).toHaveLength(1);
		expect(retryState.schedules[0]).toMatchObject({
			type: "scheduled",
			callback: "retrySagaTick",
			payload: expect.any(String),
		});
		expect(retryState.steps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stepName: "generate-winning-number",
					state: "SUCCEEDED",
					attempt: 1,
				}),
				expect.objectContaining({
					stepName: "generate-user-roll",
					state: "SUCCEEDED",
					attempt: 1,
				}),
				expect.objectContaining({
					stepName: "record-roll",
					state: "SUCCEEDED",
					attempt: 1,
				}),
				expect.objectContaining({
					stepName: "fulfill-redemption",
					state: "PENDING",
					attempt: 1,
					nextRetryAt: expect.any(String),
					lastError: expect.any(String),
				}),
			]),
		);

		mockTwitchRedemptionUpdate(fetchMock);
		mockTwitchChatMessage(fetchMock);
		mockTwitchChatMessage(fetchMock);
		await stub.retrySagaTick();
		await waitForAchievementQueuesToDrain(achievements, params.user_name);

		expect(await stub.getStatus()).toMatchObject({
			status: "ok",
			value: { status: "COMPLETED" },
		});
		const completed = await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return { steps: await db.query.sagaSteps.findMany(), schedules: instance.getSchedules() };
		});
		expect(completed.schedules).toEqual([]);
		expect(completed.steps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stepName: "generate-winning-number", attempt: 1 }),
				expect.objectContaining({ stepName: "generate-user-roll", attempt: 1 }),
				expect.objectContaining({ stepName: "record-roll", attempt: 1 }),
				expect.objectContaining({ stepName: "fulfill-redemption", attempt: 2 }),
			]),
		);
		const rows = await runInDurableObject(raffle, async (instance: KeyboardRaffleDO) => {
			const db = drizzle(instance.ctx.storage, { schema: raffleSchema });
			return db.query.rolls.findMany({
				where: (row, operators) => operators.eq(row.id, stub.id.toString()),
			});
		});
		expect(rows).toHaveLength(1);
	}, 20_000);

	it("keeps retry evidence recoverable when runtime scheduling fails", async () => {
		await ensureTwitchTokenStub();
		const raffle = await ensureKeyboardRaffleStub();
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);
		const userId = `schedule-failure-${crypto.randomUUID()}`;
		const params = createKeyboardRaffleParams({
			id: `redemption-${crypto.randomUUID()}`,
			user_id: userId,
		});
		await runInDurableObject(stub, (instance: KeyboardRaffleSagaDO) => {
			instance.ctx.storage.sql.exec(`
				CREATE TRIGGER fail_keyboard_raffle_schedule
				BEFORE INSERT ON cf_agents_schedules
				BEGIN
					SELECT RAISE(FAIL, 'scheduler unavailable');
				END
			`);
		});
		mockTwitchRedemptionFailure(503);

		const result = await stub.start(params);

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaScheduleError",
				operation: "schedule",
			});
		}
		expect(await stub.getStatus()).toMatchObject({
			status: "ok",
			value: { status: "RUNNING" },
		});
		const pending = await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return db.query.sagaSteps.findFirst({
				where: (step, operators) => operators.eq(step.stepName, "fulfill-redemption"),
			});
		});
		expect(pending).toMatchObject({
			state: "PENDING",
			attempt: 1,
			nextRetryAt: expect.any(String),
		});
		expect((await raffle.getUserStats(userId)).status).toBe("ok");
	}, 20_000);

	it("resumes a pending retry via the scheduled callback and completes the saga", async () => {
		await ensureTwitchTokenStub();
		await ensureEventBusStub();
		const achievementsStub = await ensureAchievementsSingletonStub();

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
		await waitForAchievementQueuesToDrain(achievementsStub, "TestUser");
		await cancelKeyboardRaffleSagaSchedules(stub);

		const statusResult = await stub.getStatus();
		expect(statusResult.status).toBe("ok");
		if (statusResult.status === "ok") {
			expect(statusResult.value).toMatchObject({
				status: "COMPLETED",
			});
		}
	});

	it("rolls back the recorded Roll, refunds, and fails on a permanent pre-fulfillment error", async () => {
		await ensureTwitchTokenStub();
		const raffle = await ensureKeyboardRaffleStub();
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);
		const userId = `rollback-${crypto.randomUUID()}`;
		const params = createKeyboardRaffleParams({
			id: `redemption-${crypto.randomUUID()}`,
			user_id: userId,
		});
		mockTwitchRedemptionFailure(400);
		mockTwitchRedemptionUpdate(fetchMock);

		const result = await stub.start(params);

		expect(result.status).toBe("error");
		expect(await stub.getStatus()).toMatchObject({
			status: "ok",
			value: { status: "FAILED", fulfilledAt: null },
		});
		const roll = await runInDurableObject(raffle, async (instance: KeyboardRaffleDO) => {
			const db = drizzle(instance.ctx.storage, { schema: raffleSchema });
			return db.query.rolls.findFirst({
				where: (row, operators) => operators.eq(row.userId, userId),
			});
		});
		expect(roll).toBeUndefined();
		const recordStep = await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return db.query.sagaSteps.findFirst({
				where: (step, operators) => operators.eq(step.stepName, "record-roll"),
			});
		});
		expect(recordStep).toMatchObject({ state: "COMPENSATED" });
	}, 20_000);

	it("restores a pending retry schedule from durable saga rows during startup", async () => {
		const stub = await createKeyboardRaffleSagaStub(`keyboard-raffle-saga-${crypto.randomUUID()}`);
		const now = new Date().toISOString();
		const dueAt = new Date(Date.now() + 60_000).toISOString();
		const params = createKeyboardRaffleParams({
			id: `redemption-${crypto.randomUUID()}`,
		});

		const restoration = await runInDurableObject(stub, async (instance: KeyboardRaffleSagaDO) => {
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

			const staleDueAt = new Date(Date.now() + 120_000).toISOString();
			const staleSchedule = await instance.schedule(
				new Date(staleDueAt),
				"retrySagaTick",
				staleDueAt,
				{ idempotent: true, retry: { maxAttempts: 1 } },
			);
			instance.setState({
				retryScheduleId: staleSchedule.id,
				retryDueAt: staleDueAt,
			});
			await instance.onStart();
			return { schedules: instance.getSchedules(), state: instance.state };
		});

		expect(restoration.schedules).toHaveLength(1);
		expect(restoration.schedules[0]).toMatchObject({
			type: "scheduled",
			callback: "retrySagaTick",
			payload: dueAt,
			time: Math.floor(new Date(dueAt).getTime() / 1000),
		});
		expect(restoration.state).toMatchObject({
			retryScheduleId: restoration.schedules[0]?.id,
			retryDueAt: dueAt,
		});
	});
});
