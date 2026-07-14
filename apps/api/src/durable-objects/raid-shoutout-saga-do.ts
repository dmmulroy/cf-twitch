import { Agent, type AgentContext } from "agents";
import { Result } from "better-result";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/saga-do/migrations";
import { rpc, withRpcSerialization } from "../lib/durable-objects";
import { SagaAlreadyExistsError, SagaNotFoundError, SagaStepRetrying } from "../lib/errors";
import { LegacySagaRunner } from "../lib/legacy-saga-runner";
import { logger } from "../lib/logger";
import { SagaRunnerDbError } from "../lib/saga-runner";
import { TwitchService } from "../services/twitch-service";
import * as sagaSchema from "./schemas/saga.schema";

import type { Env } from "../index";
import type { SagaStepError } from "../lib/errors";

export const RaidShoutoutParamsSchema = z.object({
	messageId: z.string(),
	receivedAt: z.string(),
	raider: z.object({
		userId: z.string(),
		login: z.string(),
		displayName: z.string(),
	}),
	viewers: z.number(),
});

export type RaidShoutoutParams = z.infer<typeof RaidShoutoutParamsSchema>;

interface RaidShoutoutSagaState {
	retryScheduleId: string | null;
	retryDueAt: string | null;
}

class _RaidShoutoutSagaDO extends Agent<Env, RaidShoutoutSagaState> {
	private db: ReturnType<typeof drizzle<typeof sagaSchema>>;
	private runner: LegacySagaRunner | null = null;

	initialState: RaidShoutoutSagaState = {
		retryScheduleId: null,
		retryDueAt: null,
	};

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema: sagaSchema });
	}

	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	private getRunner(): LegacySagaRunner {
		if (!this.runner) {
			this.runner = new LegacySagaRunner(
				this.ctx.id.toString(),
				this.db,
				{
					scheduleRetry: async (delayMs: number) => {
						await this.scheduleRetryIn(delayMs);
					},
				},
				this.env.ANALYTICS,
				"raid-shoutout-saga",
			);
		}

		return this.runner;
	}

	@rpc
	async start(
		params: RaidShoutoutParams,
	): Promise<
		Result<void, SagaAlreadyExistsError | SagaRunnerDbError | SagaStepError | SagaStepRetrying>
	> {
		const parsed = RaidShoutoutParamsSchema.safeParse(params);
		if (!parsed.success) {
			logger.error("Invalid raid shoutout params", {
				event: "raid_shoutout.params_invalid",
				error: parsed.error.message,
			});
			return Result.ok();
		}

		const runner = this.getRunner();
		const init = await runner.initSaga(parsed.data);

		if (init.status === "error" && !SagaAlreadyExistsError.is(init.error)) {
			return Result.err(init.error);
		}

		return this.execute();
	}

	private async execute(): Promise<
		Result<void, SagaRunnerDbError | SagaStepError | SagaStepRetrying>
	> {
		const runner = this.getRunner();
		const isRunningResult = await runner.isRunning();
		if (isRunningResult.status === "error") return Result.err(isRunningResult.error);
		if (!isRunningResult.value) return Result.ok();

		const paramsResult = await runner.getParams<RaidShoutoutParams>();
		if (paramsResult.status === "error") {
			if (SagaNotFoundError.is(paramsResult.error)) return Result.ok();
			return Result.err(paramsResult.error);
		}
		if (!paramsResult.value) return Result.ok();

		const params = paramsResult.value;
		const twitch = new TwitchService(this.env);

		const chatResult = await runner.executeStep(
			"send-chat-thanks",
			async () => {
				const result = await twitch.sendChatMessage(
					`Thanks for the raid @${params.raider.login}! ` +
						`Go check them out: https://twitch.tv/${params.raider.login}`,
				);

				if (result.status === "error") throw result.error;
				return { result: undefined };
			},
			{ timeout: 10000, maxRetries: 2 },
		);

		if (chatResult.status === "error") return Result.err(chatResult.error);

		const shoutoutResult = await runner.executeStep(
			"create-native-shoutout",
			async () => {
				const result = await twitch.createShoutout(params.raider.userId);

				if (result.status === "error") throw result.error;
				return { result: undefined };
			},
			{ timeout: 10000, maxRetries: 2 },
		);

		if (shoutoutResult.status === "error") return Result.err(shoutoutResult.error);

		const completeResult = await runner.complete();
		if (completeResult.status === "error") return Result.err(completeResult.error);
		return Result.ok();
	}

	private async scheduleRetryIn(delayMs: number): Promise<void> {
		const dueAt = new Date(Date.now() + delayMs).toISOString();

		if (this.state.retryScheduleId !== null) {
			await this.cancelSchedule(this.state.retryScheduleId);
		}

		const schedule = await this.schedule(new Date(dueAt), "retrySagaTick", dueAt, {
			idempotent: true,
			retry: { maxAttempts: 1 },
		});

		this.setState({
			retryScheduleId: schedule.id,
			retryDueAt: dueAt,
		});
	}

	async retrySagaTick(): Promise<void> {
		this.setState({
			retryScheduleId: null,
			retryDueAt: null,
		});

		const result = await this.execute();

		if (result.status === "error") {
			logger.error("Raid shoutout retry failed", {
				event: "raid_shoutout.retry_failed",
				saga_id: this.ctx.id.toString(),
				error_tag: result.error._tag,
				error_message: result.error.message,
			});
		}
	}
}

export const RaidShoutoutSagaDO = withRpcSerialization(_RaidShoutoutSagaDO);
