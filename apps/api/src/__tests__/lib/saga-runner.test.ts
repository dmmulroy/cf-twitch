import { Result } from "better-result";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { RaidShoutoutSagaDO } from "../../durable-objects/raid-shoutout-saga-do";
import * as sagaSchema from "../../durable-objects/schemas/saga.schema";
import { noResultCodec, numberCodec, stringCodec, zodSagaCodec } from "../../lib/codecs";
import { SagaScheduleError, SpotifyNetworkError } from "../../lib/errors";
import { SagaRunner } from "../../lib/saga-runner";

const TestParamsSchema = z.object({ request: z.string() });
type TestParams = z.infer<typeof TestParamsSchema>;

const testParamsCodec = zodSagaCodec({
	name: "test-params",
	codec: z.codec(TestParamsSchema, TestParamsSchema, {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

async function createMigratedSagaStub(): Promise<DurableObjectStub<RaidShoutoutSagaDO>> {
	const name = `typed-saga-runner-${crypto.randomUUID()}`;
	const stub = env.RAID_SHOUTOUT_SAGA_DO.get(env.RAID_SHOUTOUT_SAGA_DO.idFromName(name));
	await stub.setName(name);
	return stub;
}

describe("SagaRunner typed persistence", () => {
	it("encodes parameters and replays a parsed successful result without repeating work", async () => {
		const stub = await createMigratedSagaStub();

		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const runner = new SagaRunner<TestParams>({
				sagaId,
				db,
				paramsCodec: testParamsCodec,
				retryScheduler: {
					scheduleRetry: async () => Result.ok(),
				},
			});
			let executions = 0;

			const initialized = await runner.initSaga({ request: "original" });
			const first = await runner.executeStep(
				{ name: "calculate", resultCodec: numberCodec },
				async () => {
					executions += 1;
					return { result: 42 };
				},
			);
			const replay = await runner.executeStep(
				{ name: "calculate", resultCodec: numberCodec },
				async () => {
					executions += 1;
					return { result: 99 };
				},
			);
			const params = await runner.getParams();
			const row = await db.query.sagaRuns.findFirst();

			expect(initialized).toEqual({ status: "ok", value: undefined });
			expect(first).toEqual({ status: "ok", value: 42 });
			expect(replay).toEqual({ status: "ok", value: 42 });
			expect(params).toEqual({ status: "ok", value: { request: "original" } });
			expect(row?.paramsJson).toBe('{"request":"original"}');
			expect(executions).toBe(1);
		});
	});

	it.each(['{"request":42}', '{"request":'])(
		"returns a persisted-data error for invalid parameters: %s",
		async (paramsJson) => {
			const stub = await createMigratedSagaStub();

			await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
				const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
				const sagaId = instance.ctx.id.toString();
				const now = new Date().toISOString();
				await db.insert(sagaSchema.sagaRuns).values({
					id: sagaId,
					status: "RUNNING",
					paramsJson,
					createdAt: now,
					updatedAt: now,
				});
				const runner = new SagaRunner<TestParams>({
					sagaId,
					db,
					paramsCodec: testParamsCodec,
					retryScheduler: { scheduleRetry: async () => Result.ok() },
				});

				const result = await runner.getParams();

				expect(result.status).toBe("error");
				if (result.status === "error") {
					expect(result.error).toMatchObject({
						_tag: "SagaPersistedDataError",
						sagaId,
						field: "params",
						codecName: "test-params",
					});
				}
			});
		},
	);

	it("stops on a malformed cached result without invoking the successful step again", async () => {
		const stub = await createMigratedSagaStub();

		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const runner = new SagaRunner<TestParams>({
				sagaId,
				db,
				paramsCodec: testParamsCodec,
				retryScheduler: { scheduleRetry: async () => Result.ok() },
			});
			await runner.initSaga({ request: "cached" });
			await db.insert(sagaSchema.sagaSteps).values({
				sagaId,
				stepName: "calculate",
				state: "SUCCEEDED",
				attempt: 1,
				resultJson: '"not-a-number"',
			});
			let executions = 0;

			const result = await runner.executeStep(
				{ name: "calculate", resultCodec: numberCodec },
				async () => {
					executions += 1;
					return { result: 42 };
				},
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error).toMatchObject({
					_tag: "SagaPersistedDataError",
					field: "step-result",
					stepName: "calculate",
					codecName: "number",
				});
			}
			expect(executions).toBe(0);
		});
	});

	it("rejects malformed undo evidence without invoking the handler or compensation", async () => {
		const stub = await createMigratedSagaStub();

		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const runner = new SagaRunner<TestParams>({
				sagaId,
				db,
				paramsCodec: testParamsCodec,
				retryScheduler: { scheduleRetry: async () => Result.ok() },
			});
			await runner.initSaga({ request: "rollback" });
			await db.insert(sagaSchema.sagaSteps).values({
				sagaId,
				stepName: "reserve",
				state: "SUCCEEDED",
				attempt: 1,
				resultJson: '"reserved"',
				undoJson: "42",
			});
			let handlerExecutions = 0;
			const compensated: string[] = [];

			const result = await runner.executeStepWithRollback(
				{ name: "reserve", resultCodec: stringCodec, undoCodec: stringCodec },
				async () => {
					handlerExecutions += 1;
					return { result: "new", undoPayload: "new-undo" };
				},
				async (undoPayload) => {
					compensated.push(undoPayload);
				},
			);
			await runner.compensateAll();

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error).toMatchObject({
					_tag: "SagaPersistedDataError",
					field: "step-undo",
					stepName: "reserve",
					codecName: "string",
				});
			}
			expect(handlerExecutions).toBe(0);
			expect(compensated).toEqual([]);
		});
	});

	it("captures typed compensation values for fresh and replayed steps", async () => {
		const stub = await createMigratedSagaStub();

		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const compensated: string[] = [];
			const createRunner = () =>
				new SagaRunner<TestParams>({
					sagaId,
					db,
					paramsCodec: testParamsCodec,
					retryScheduler: { scheduleRetry: async () => Result.ok() },
				});
			const firstRunner = createRunner();
			await firstRunner.initSaga({ request: "typed-undo" });

			await firstRunner.executeStepWithRollback(
				{ name: "reserve", resultCodec: stringCodec, undoCodec: stringCodec },
				async () => ({ result: "reserved", undoPayload: "reservation-123" }),
				async (undoPayload) => {
					compensated.push(`fresh:${undoPayload}`);
				},
			);
			await firstRunner.compensateAll();

			await db.update(sagaSchema.sagaSteps).set({ state: "SUCCEEDED" });
			const replayRunner = createRunner();
			await replayRunner.executeStepWithRollback(
				{ name: "reserve", resultCodec: stringCodec, undoCodec: stringCodec },
				async () => ({ result: "must-not-run", undoPayload: "must-not-run" }),
				async (undoPayload) => {
					compensated.push(`replay:${undoPayload}`);
				},
			);
			await replayRunner.compensateAll();

			expect(compensated).toEqual(["fresh:reservation-123", "replay:reservation-123"]);
		});
	});

	it("encodes result and undo values before marking a rollbackable step successful", async () => {
		const stub = await createMigratedSagaStub();

		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const runner = new SagaRunner<TestParams>({
				sagaId,
				db,
				paramsCodec: testParamsCodec,
				retryScheduler: { scheduleRetry: async () => Result.ok() },
			});
			await runner.initSaga({ request: "encode-before-success" });

			const result = await runner.executeStepWithRollback(
				{ name: "reserve", resultCodec: stringCodec, undoCodec: numberCodec },
				async () => ({ result: "reserved", undoPayload: Number.NaN }),
				async () => {},
			);
			const row = await db.query.sagaSteps.findFirst();

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error).toMatchObject({
					_tag: "SagaPersistedDataError",
					field: "step-undo",
					stepName: "reserve",
				});
			}
			expect(row).toMatchObject({
				state: "PENDING",
				resultJson: null,
				undoJson: null,
			});
		});
	});

	it("persists and replays a no-result step as explicit null", async () => {
		const stub = await createMigratedSagaStub();

		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const runner = new SagaRunner<TestParams>({
				sagaId,
				db,
				paramsCodec: testParamsCodec,
				retryScheduler: { scheduleRetry: async () => Result.ok() },
			});
			await runner.initSaga({ request: "no-result" });
			let executions = 0;
			const step = { name: "notify", resultCodec: noResultCodec };

			const first = await runner.executeStep(step, async () => {
				executions += 1;
				return { result: undefined };
			});
			const replay = await runner.executeStep(step, async () => {
				executions += 1;
				return { result: undefined };
			});
			const row = await db.query.sagaSteps.findFirst();

			expect(first).toEqual({ status: "ok", value: undefined });
			expect(replay).toEqual({ status: "ok", value: undefined });
			expect(row?.resultJson).toBe("null");
			expect(executions).toBe(1);
		});
	});

	it("preserves pending retry evidence when scheduling fails", async () => {
		const stub = await createMigratedSagaStub();

		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const scheduleError = new SagaScheduleError({
				sagaId,
				operation: "schedule",
				message: "Test scheduler unavailable",
			});
			const runner = new SagaRunner<TestParams>({
				sagaId,
				db,
				paramsCodec: testParamsCodec,
				retryScheduler: { scheduleRetry: async () => Result.err(scheduleError) },
			});
			await runner.initSaga({ request: "retry" });

			const result = await runner.executeStep(
				{
					name: "remote-call",
					resultCodec: noResultCodec,
					options: { maxRetries: 3 },
				},
				async () => {
					throw new SpotifyNetworkError({ status: 503, context: "typed runner test" });
				},
			);
			const row = await db.query.sagaSteps.findFirst();

			expect(result).toEqual({ status: "error", error: scheduleError });
			expect(row).toMatchObject({
				state: "PENDING",
				attempt: 1,
				nextRetryAt: expect.any(String),
				lastError: expect.stringContaining("Spotify API error (503)"),
			});
		});
	});

	it("does not bypass a future retry or reopen an exhausted failed step", async () => {
		const stub = await createMigratedSagaStub();
		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const runner = new SagaRunner<TestParams>({
				sagaId,
				db,
				paramsCodec: testParamsCodec,
				retryScheduler: { scheduleRetry: async () => Result.ok() },
			});
			await runner.initSaga({ request: "guard retries" });
			await db.insert(sagaSchema.sagaSteps).values({
				sagaId,
				stepName: "guarded",
				state: "PENDING",
				attempt: 1,
				nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
			});
			let executions = 0;
			const pending = await runner.executeStep(
				{ name: "guarded", resultCodec: noResultCodec, options: { maxRetries: 2 } },
				async () => {
					executions += 1;
					return { result: undefined };
				},
			);
			expect(pending.status).toBe("error");
			expect(executions).toBe(0);

			await db
				.update(sagaSchema.sagaSteps)
				.set({ state: "FAILED", nextRetryAt: null, lastError: "attempt budget exhausted" });
			const exhausted = await runner.executeStep(
				{ name: "guarded", resultCodec: noResultCodec, options: { maxRetries: 2 } },
				async () => {
					executions += 1;
					return { result: undefined };
				},
			);
			expect(exhausted.status).toBe("error");
			expect(executions).toBe(0);
		});
	});

	it("does not repeat an interrupted mutation with an ambiguous provider outcome", async () => {
		const stub = await createMigratedSagaStub();
		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const runner = new SagaRunner<TestParams>({
				sagaId,
				db,
				paramsCodec: testParamsCodec,
				retryScheduler: { scheduleRetry: async () => Result.ok() },
			});
			await runner.initSaga({ request: "ambiguous mutation" });
			await db.insert(sagaSchema.sagaSteps).values({
				sagaId,
				stepName: "send-chat",
				state: "PENDING",
				attempt: 1,
			});
			let executions = 0;
			const result = await runner.executeStep(
				{
					name: "send-chat",
					resultCodec: noResultCodec,
					options: { ambiguousEffect: true },
				},
				async () => {
					executions += 1;
					return { result: undefined };
				},
			);
			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error).toMatchObject({
					_tag: "SagaEffectOutcomeUnknown",
					causeTag: "InterruptedEffect",
				});
			}
			expect(executions).toBe(0);
			expect(await db.query.sagaSteps.findFirst()).toMatchObject({ state: "FAILED" });
		});
	});

	it("waits for late handler settlement before recording a timeout outcome", async () => {
		const stub = await createMigratedSagaStub();
		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const runner = new SagaRunner<TestParams>({
				sagaId: instance.ctx.id.toString(),
				db,
				paramsCodec: testParamsCodec,
				retryScheduler: { scheduleRetry: async () => Result.ok() },
			});
			await runner.initSaga({ request: "late success" });
			let settled = false;
			const result = await runner.executeStep(
				{ name: "late-mutation", resultCodec: stringCodec, options: { timeout: 5 } },
				async (signal) => {
					await new Promise((resolve) => setTimeout(resolve, 15));
					expect(signal.aborted).toBe(true);
					settled = true;
					return { result: "committed" };
				},
			);
			expect(settled).toBe(true);
			expect(result).toEqual({ status: "ok", value: "committed" });
			expect(await db.query.sagaSteps.findFirst()).toMatchObject({ state: "SUCCEEDED" });
		});
	});

	it("persists failed compensation and resumes it from reconstructed undo evidence", async () => {
		const stub = await createMigratedSagaStub();
		await runInDurableObject(stub, async (instance: RaidShoutoutSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const createRunner = () =>
				new SagaRunner<TestParams>({
					sagaId,
					db,
					paramsCodec: testParamsCodec,
					retryScheduler: { scheduleRetry: async () => Result.ok() },
				});
			const first = createRunner();
			await first.initSaga({ request: "resume compensation" });
			await first.executeStepWithRollback(
				{ name: "reserve", resultCodec: stringCodec, undoCodec: stringCodec },
				async () => ({ result: "reserved", undoPayload: "reservation-id" }),
				async () => {
					throw new Error("temporary compensation outage");
				},
			);
			const failed = await first.compensateAll();
			expect(failed.status).toBe("error");
			expect(await db.query.sagaRuns.findFirst()).toMatchObject({ status: "COMPENSATING" });
			expect(await db.query.sagaSteps.findFirst()).toMatchObject({
				state: "COMPENSATION_PENDING",
				nextRetryAt: expect.any(String),
			});

			const resumed = createRunner();
			resumed.prepareExecution({ retryCallback: true });
			let compensated = "";
			await resumed.executeStepWithRollback(
				{ name: "reserve", resultCodec: stringCodec, undoCodec: stringCodec },
				async () => ({ result: "must-not-run", undoPayload: "must-not-run" }),
				async (undo) => {
					compensated = undo;
				},
			);
			expect(await resumed.compensateAll()).toEqual({ status: "ok", value: undefined });
			expect(compensated).toBe("reservation-id");
			expect(await db.query.sagaSteps.findFirst()).toMatchObject({ state: "COMPENSATED" });
		});
	});
});
