import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vite-plus/test";

import { RaidShoutoutSagaDO } from "../../durable-objects/raid-shoutout-saga-do";
import * as sagaSchema from "../../durable-objects/schemas/saga.schema";
import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import { VALID_TOKEN_RESPONSE, mockTwitchChatMessage } from "../fixtures/twitch";
import { fetchMock } from "../helpers/fetch-mock";

async function createRaidShoutoutSagaStub(
	name: string,
): Promise<DurableObjectStub<RaidShoutoutSagaDO>> {
	const id = env.RAID_SHOUTOUT_SAGA_DO.idFromName(name);
	const stub = env.RAID_SHOUTOUT_SAGA_DO.get(id);
	await stub.setName(name);
	return stub;
}

async function ensureTwitchTokenStub(): Promise<DurableObjectStub<TwitchTokenDO>> {
	const id = env.TWITCH_TOKEN_DO.idFromName("twitch-token");
	const stub = env.TWITCH_TOKEN_DO.get(id);
	await stub.setName("twitch-token");
	await stub.setTokens(VALID_TOKEN_RESPONSE);
	return stub;
}

function twitchShoutoutPath(toBroadcasterId: string): RegExp {
	return new RegExp(
		`^/helix/chat/shoutouts\\?` +
			`(?=.*from_broadcaster_id=${env.TWITCH_BROADCASTER_ID})` +
			`(?=.*to_broadcaster_id=${toBroadcasterId})` +
			`(?=.*moderator_id=${env.TWITCH_BROADCASTER_ID}).*$`,
	);
}

function mockTwitchShoutout(toBroadcasterId: string): void {
	fetchMock
		.get("https://api.twitch.tv")
		.intercept({ path: twitchShoutoutPath(toBroadcasterId), method: "POST" })
		.reply(204, "");
}

function mockRetryableTwitchShoutoutFailure(toBroadcasterId: string): void {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: twitchShoutoutPath(toBroadcasterId), method: "POST" })
			.reply(503, "Service unavailable");
	}
}

function mockRetryableTwitchChatFailure(): void {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: "/helix/chat/messages", method: "POST" })
			.reply(503, "Service unavailable");
	}
}

async function waitForSagaCompletion(
	stub: DurableObjectStub<RaidShoutoutSagaDO>,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastStatus = await stub.getStatus();

	while (Date.now() < deadline) {
		if (lastStatus.status === "ok" && lastStatus.value?.status === "COMPLETED") return;

		await new Promise((resolve) => setTimeout(resolve, 50));
		lastStatus = await stub.getStatus();
	}

	throw new Error(`Timed out waiting for saga completion: ${JSON.stringify(lastStatus)}`);
}

describe("RaidShoutoutSagaDO", () => {
	it("rejects invalid parameters before persistence or Twitch work", async () => {
		const stub = await createRaidShoutoutSagaStub(`raid-shoutout-${crypto.randomUUID()}`);

		const result = await stub.start({ viewers: "many" });

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaInputParseError",
				codecName: "raid-shoutout-params",
			});
		}

		const status = await stub.getStatus();
		expect(status).toEqual({ status: "ok", value: null });
	});

	it("thanks the raider in chat and creates a native shoutout", async () => {
		await ensureTwitchTokenStub();
		const raiderUserId = "raider-user-id";
		const stub = await createRaidShoutoutSagaStub(`raid-shoutout-${crypto.randomUUID()}`);
		mockTwitchChatMessage(fetchMock);
		mockTwitchShoutout(raiderUserId);

		const result = await stub.start({
			messageId: `message-${crypto.randomUUID()}`,
			receivedAt: "2026-05-25T00:00:00.000Z",
			raider: {
				userId: raiderUserId,
				login: "raiderlogin",
				displayName: "RaiderLogin",
			},
			viewers: 42,
		});

		expect(result.status).toBe("ok");
		const status = await stub.getStatus();
		expect(status).toMatchObject({
			status: "ok",
			value: { status: "COMPLETED" },
		});
	});

	it("does not repeat chat or native shoutout work when the same message is retried", async () => {
		await ensureTwitchTokenStub();
		const raiderUserId = "raider-user-id";
		const messageId = `message-${crypto.randomUUID()}`;
		const stub = await createRaidShoutoutSagaStub(messageId);
		const params = {
			messageId,
			receivedAt: "2026-05-25T00:00:00.000Z",
			raider: {
				userId: raiderUserId,
				login: "raiderlogin",
				displayName: "RaiderLogin",
			},
			viewers: 42,
		};
		mockTwitchChatMessage(fetchMock);
		mockTwitchShoutout(raiderUserId);

		const firstResult = await stub.start(params);
		const retryResult = await stub.start({
			...params,
			raider: {
				userId: "different-user-id",
				login: "differentlogin",
				displayName: "DifferentLogin",
			},
		});

		expect(firstResult.status).toBe("ok");
		expect(retryResult.status).toBe("ok");
		const persistedParams = await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const saga = await db.query.sagaRuns.findFirst();
			return saga?.paramsJson;
		});
		expect(persistedParams).toBe(JSON.stringify(params));
	});

	it("persists retry evidence and resumes through the inherited scheduled callback", async () => {
		await ensureTwitchTokenStub();
		const raiderUserId = "retry-raider-user-id";
		const stub = await createRaidShoutoutSagaStub(`raid-shoutout-${crypto.randomUUID()}`);
		mockTwitchChatMessage(fetchMock);
		mockRetryableTwitchShoutoutFailure(raiderUserId);

		const start = await stub.start({
			messageId: `message-${crypto.randomUUID()}`,
			receivedAt: "2026-05-25T00:00:00.000Z",
			raider: {
				userId: raiderUserId,
				login: "retryraider",
				displayName: "RetryRaider",
			},
			viewers: 42,
		});

		expect(start.status).toBe("error");
		if (start.status === "error") {
			expect(start.error).toMatchObject({ _tag: "SagaStepRetrying" });
		}

		const retryState = await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return {
				schedules: instance.getSchedules(),
				steps: await db.query.sagaSteps.findMany(),
			};
		});
		expect(retryState.schedules).toHaveLength(1);
		expect(retryState.schedules[0]).toMatchObject({
			type: "scheduled",
			callback: "retrySagaTick",
		});
		const pendingStep = retryState.steps.find((step) => step.stepName === "create-native-shoutout");
		expect(retryState.schedules[0]?.payload).toBe(pendingStep?.nextRetryAt);
		expect(retryState.steps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stepName: "send-chat-thanks", state: "SUCCEEDED" }),
				expect.objectContaining({
					stepName: "create-native-shoutout",
					state: "PENDING",
					attempt: 1,
					nextRetryAt: expect.any(String),
				}),
			]),
		);

		mockTwitchShoutout(raiderUserId);
		await waitForSagaCompletion(stub);
		const schedulesAfterCompletion = await runInDurableObject(
			stub,
			(instance: RaidShoutoutSagaDO) => instance.getSchedules(),
		);
		expect(schedulesAfterCompletion).toEqual([]);
	}, 20_000);

	it("replaces stale retry coordination from SQLite and retains a matching schedule", async () => {
		const stub = await createRaidShoutoutSagaStub(`raid-shoutout-${crypto.randomUUID()}`);
		const dueAt = new Date(Date.now() + 60_000).toISOString();
		const now = new Date().toISOString();

		const restored = await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			await db.insert(sagaSchema.sagaRuns).values({
				id: sagaId,
				status: "RUNNING",
				paramsJson: JSON.stringify({
					messageId: "persisted-message",
					receivedAt: "2026-05-25T00:00:00.000Z",
					raider: {
						userId: "persisted-raider",
						login: "persistedlogin",
						displayName: "PersistedLogin",
					},
					viewers: 42,
				}),
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(sagaSchema.sagaSteps).values({
				sagaId,
				stepName: "create-native-shoutout",
				state: "PENDING",
				attempt: 1,
				nextRetryAt: dueAt,
				lastError: "retryable failure",
			});

			const stale = await instance.schedule(
				new Date(Date.now() + 120_000),
				"retrySagaTick",
				"stale-due-at",
				{ idempotent: true, retry: { maxAttempts: 1 } },
			);
			instance.setState({ retryScheduleId: stale.id, retryDueAt: "stale-due-at" });
			await instance.onStart();
			const replacement = instance.getSchedules()[0];
			const replacementState = instance.state;
			await instance.onStart();

			return {
				staleId: stale.id,
				replacement,
				replacementState,
				schedulesAfterSecondStart: instance.getSchedules(),
			};
		});

		expect(restored.replacement).toMatchObject({
			type: "scheduled",
			callback: "retrySagaTick",
			payload: dueAt,
			time: Math.floor(new Date(dueAt).getTime() / 1000),
		});
		expect(restored.replacement?.id).not.toBe(restored.staleId);
		expect(restored.replacementState).toMatchObject({
			retryScheduleId: restored.replacement?.id,
			retryDueAt: dueAt,
		});
		expect(restored.schedulesAfterSecondStart).toHaveLength(1);
		expect(restored.schedulesAfterSecondStart[0]?.id).toBe(restored.replacement?.id);
	});

	it("contains retry schedule inspection failures during startup restoration", async () => {
		const stub = await createRaidShoutoutSagaStub(`raid-shoutout-${crypto.randomUUID()}`);
		const dueAt = new Date(Date.now() + 60_000).toISOString();

		const restored = await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const now = new Date().toISOString();
			await db.insert(sagaSchema.sagaRuns).values({
				id: sagaId,
				status: "RUNNING",
				paramsJson: "{}",
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(sagaSchema.sagaSteps).values({
				sagaId,
				stepName: "create-native-shoutout",
				state: "PENDING",
				attempt: 1,
				nextRetryAt: dueAt,
				lastError: "retryable failure",
			});
			const schedule = await instance.schedule(new Date(dueAt), "retrySagaTick", dueAt);
			instance.setState({ retryScheduleId: schedule.id, retryDueAt: dueAt });
			instance.ctx.storage.sql.exec(
				"UPDATE cf_agents_schedules SET payload = ? WHERE id = ?",
				"{invalid-json",
				schedule.id,
			);

			await instance.onStart();

			return {
				sagaStatus: (await db.query.sagaRuns.findFirst())?.status,
				state: instance.state,
			};
		});

		expect(restored).toEqual({
			sagaStatus: "RUNNING",
			state: { retryScheduleId: expect.any(String), retryDueAt: dueAt },
		});
	});

	it.each([undefined, "COMPLETED", "FAILED", "COMPENSATING", "RUNNING"] as const)(
		"clears stale retry coordination for saga status %s without business effects",
		async (status) => {
			const stub = await createRaidShoutoutSagaStub(`raid-shoutout-${crypto.randomUUID()}`);
			const coordination = await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
				const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
				const sagaId = instance.ctx.id.toString();
				const now = new Date().toISOString();
				if (status !== undefined) {
					await db.insert(sagaSchema.sagaRuns).values({
						id: sagaId,
						status,
						paramsJson: "{}",
						createdAt: now,
						updatedAt: now,
					});
				}
				await instance.schedule(new Date(Date.now() + 60_000), "retrySagaTick", "stale-due-at");
				instance.setState({ retryScheduleId: null, retryDueAt: null });
				await instance.onStart();
				return { schedules: instance.getSchedules(), state: instance.state };
			});

			expect(coordination).toEqual({
				schedules: [],
				state: { retryScheduleId: null, retryDueAt: null },
			});
		},
	);

	it("scheduled callbacks safely skip missing and non-running sagas", async () => {
		const missingStub = await createRaidShoutoutSagaStub(`raid-shoutout-${crypto.randomUUID()}`);
		await runInDurableObject(missingStub, (instance: RaidShoutoutSagaDO) => {
			instance.setState({ retryScheduleId: null, retryDueAt: "missing-schedule" });
		});
		await missingStub.retrySagaTick("missing-schedule");
		expect(await missingStub.getStatus()).toEqual({ status: "ok", value: null });

		const completedStub = await createRaidShoutoutSagaStub(`raid-shoutout-${crypto.randomUUID()}`);
		await runInDurableObject(completedStub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const now = new Date().toISOString();
			await db.insert(sagaSchema.sagaRuns).values({
				id: instance.ctx.id.toString(),
				status: "COMPLETED",
				paramsJson: "not parsed for terminal callbacks",
				createdAt: now,
				updatedAt: now,
			});
		});
		await runInDurableObject(completedStub, (instance: RaidShoutoutSagaDO) => {
			instance.setState({ retryScheduleId: null, retryDueAt: "completed-schedule" });
		});
		await completedStub.retrySagaTick("completed-schedule");
		expect(await completedStub.getStatus()).toMatchObject({
			status: "ok",
			value: { status: "COMPLETED" },
		});
	});

	it("returns a typed scheduling error while preserving SQLite retry evidence", async () => {
		await ensureTwitchTokenStub();
		const stub = await createRaidShoutoutSagaStub(`raid-shoutout-${crypto.randomUUID()}`);
		await runInDurableObject(stub, (instance: RaidShoutoutSagaDO) => {
			instance.ctx.storage.sql.exec(`
				CREATE TRIGGER fail_saga_schedule
				BEFORE INSERT ON cf_agents_schedules
				BEGIN
					SELECT RAISE(FAIL, 'scheduler unavailable');
				END
			`);
		});
		mockRetryableTwitchChatFailure();

		const result = await stub.start({
			messageId: `message-${crypto.randomUUID()}`,
			receivedAt: "2026-05-25T00:00:00.000Z",
			raider: {
				userId: "schedule-failure-raider",
				login: "schedulefailure",
				displayName: "ScheduleFailure",
			},
			viewers: 42,
		});

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaScheduleError",
				operation: "schedule",
			});
		}
		const pending = await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return db.query.sagaSteps.findFirst();
		});
		expect(pending).toMatchObject({
			stepName: "send-chat-thanks",
			state: "PENDING",
			attempt: 1,
			nextRetryAt: expect.any(String),
		});
	}, 20_000);
});
