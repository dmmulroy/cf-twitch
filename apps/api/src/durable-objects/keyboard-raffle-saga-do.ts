import { type AgentContext } from "agents";
import { Result } from "better-result";
import { z } from "zod";

import { DurableObjectTwitchAccessTokens } from "../adapters/cloudflare/durable-object-access-tokens";
import { DurableObjectDomainEventPublisher } from "../adapters/cloudflare/durable-object-domain-event-publisher";
import { DurableObjectRaffleStatistics } from "../adapters/cloudflare/durable-object-raffle-statistics";
import { LoggingTracer } from "../capabilities/tracer";
import { parseWorkerConfiguration } from "../configuration/worker-configuration";
import { createRaffleRollEvent } from "../domain/domain-event";
import { writeRaffleRollMetric } from "../lib/analytics";
import { noResultCodec, zodSagaCodec } from "../lib/codecs";
import {
	SagaNotFoundError,
	SagaPersistedDataError,
	SagaScheduleError,
	SagaStepRetrying,
} from "../lib/errors";
import { logger } from "../lib/logger";
import { deriveSagaEventId } from "../lib/saga-event-id";
import { SagaHost, type SagaHostDefinition, type SagaHostStatus } from "../lib/saga-host";
import {
	SagaRunner,
	type SagaRollbackStepDefinition,
	type SagaStepDefinition,
	type SagaStepExecutionError,
} from "../lib/saga-runner";
import { TwitchService } from "../services/twitch-service";
import { CryptoRaffleRandom, type RaffleRandom } from "./raffle-random";

import type { DomainEventPublisher } from "../capabilities/domain-event-publisher";
import type { KeyboardRaffleRollStore } from "../capabilities/keyboard-raffle-roll-store";
import type { Env } from "../index";

/** Boundary schema for canonical Keyboard Raffle redemption parameters. */
export const KeyboardRaffleParamsSchema = z.object({
	id: z.string(),
	broadcaster_user_id: z.string(),
	broadcaster_user_login: z.string(),
	broadcaster_user_name: z.string(),
	user_id: z.string(),
	user_login: z.string(),
	user_name: z.string(),
	user_input: z.string(),
	status: z.enum(["unknown", "unfulfilled", "fulfilled", "canceled"]),
	reward: z.object({
		id: z.string(),
		title: z.string(),
		cost: z.number(),
		prompt: z.string(),
	}),
	redeemed_at: z.iso.datetime(),
});

/** Canonical Keyboard Raffle parameters persisted without webhook routing metadata. */
export type KeyboardRaffleParams = z.infer<typeof KeyboardRaffleParamsSchema>;

/** Named persistence codec for canonical Keyboard Raffle parameters. */
export const KeyboardRaffleParamsCodec = zodSagaCodec({
	name: "keyboard-raffle-params",
	codec: z.codec(KeyboardRaffleParamsSchema, KeyboardRaffleParamsSchema, {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

/** Shared host status projection retained under the Keyboard Raffle API name. */
export type KeyboardRaffleSagaStatus = SagaHostStatus;

type KeyboardRaffleSagaError = SagaStepExecutionError | SagaNotFoundError;

type RecordedRollResult = {
	readonly rollId: string;
	readonly isNewRecord: boolean;
};

const RecordedRollResultSchema = z.object({
	rollId: z.string(),
	isNewRecord: z.boolean(),
});

const RecordedRollResultCodec = zodSagaCodec<RecordedRollResult>({
	name: "keyboard-raffle-recorded-roll-result",
	codec: z.codec(RecordedRollResultSchema, RecordedRollResultSchema, {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

const RollIdCodec = zodSagaCodec<string>({
	name: "keyboard-raffle-roll-id",
	codec: z.codec(z.string(), z.string(), {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

const RaffleNumberSchema = z.number().int().min(1).max(10000);
const RaffleNumberCodec = zodSagaCodec<number>({
	name: "keyboard-raffle-number",
	codec: z.codec(RaffleNumberSchema, RaffleNumberSchema, {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

const GenerateWinningNumberStep: SagaStepDefinition<number> = {
	name: "generate-winning-number",
	resultCodec: RaffleNumberCodec,
};

const GenerateUserRollStep: SagaStepDefinition<number> = {
	name: "generate-user-roll",
	resultCodec: RaffleNumberCodec,
};

const RecordRollStep: SagaRollbackStepDefinition<RecordedRollResult, string> = {
	name: "record-roll",
	resultCodec: RecordedRollResultCodec,
	undoCodec: RollIdCodec,
	options: { timeout: 10000, maxRetries: 2 },
};

const FulfillRedemptionStep: SagaStepDefinition<void> = {
	name: "fulfill-redemption",
	resultCodec: noResultCodec,
	options: { timeout: 30000, maxRetries: 3 },
};

const PublishEventStep: SagaStepDefinition<void> = {
	name: "publish-event",
	resultCodec: noResultCodec,
	options: { timeout: 10000, maxRetries: 5, retryAllErrors: true },
};

const SendChatMessageStep: SagaStepDefinition<void> = {
	name: "send-chat-message",
	resultCodec: noResultCodec,
	options: { timeout: 10000, maxRetries: 2 },
};

const KEYBOARD_RAFFLE_SAGA: SagaHostDefinition<KeyboardRaffleParams> = {
	sagaType: "keyboard-raffle-saga",
	paramsCodec: KeyboardRaffleParamsCodec,
};

/** Keyboard Raffle orchestration hosted by the shared saga lifecycle. */
class _KeyboardRaffleSagaDO extends SagaHost<KeyboardRaffleParams, KeyboardRaffleSagaError> {
	private readonly analytics: Cloudflare.Env["ANALYTICS"];
	private readonly domainEvents: DomainEventPublisher;
	private readonly raffleRolls: KeyboardRaffleRollStore;
	private readonly twitchService: TwitchService;

	constructor(
		ctx: AgentContext,
		env: Env,
		private readonly raffleRandom: RaffleRandom = new CryptoRaffleRandom(),
	) {
		super(ctx, env);
		this.analytics = env.ANALYTICS;
		const configuration = parseWorkerConfiguration(env);
		if (configuration.status === "error") {
			throw new Error("Keyboard Raffle saga configuration is invalid");
		}
		const tracer = new LoggingTracer(logger);
		this.domainEvents = new DurableObjectDomainEventPublisher(env.EVENT_BUS_DO, tracer);
		this.raffleRolls = new DurableObjectRaffleStatistics(env.KEYBOARD_RAFFLE_DO, tracer);
		this.twitchService = new TwitchService({
			configuration: configuration.value.twitch,
			accessTokens: new DurableObjectTwitchAccessTokens(env.TWITCH_TOKEN_DO, tracer),
		});
	}
	protected get sagaDefinition(): SagaHostDefinition<KeyboardRaffleParams> {
		return KEYBOARD_RAFFLE_SAGA;
	}

	protected async runSaga(
		params: KeyboardRaffleParams,
		runner: SagaRunner<KeyboardRaffleParams>,
	): Promise<Result<void, KeyboardRaffleSagaError>> {
		const sagaId = this.ctx.id.toString();

		const winningNumberResult = await runner.executeStep(GenerateWinningNumberStep, async () => {
			const winningNumber = this.raffleRandom.drawInclusiveInteger(1, 10_000);
			logger.info("Generated winning number", { sagaId, winningNumber });
			return { result: winningNumber };
		});
		if (winningNumberResult.status === "error") {
			return this.handleStepError(winningNumberResult.error, params, runner);
		}
		const winningNumber = winningNumberResult.value;

		const userRollResult = await runner.executeStep(GenerateUserRollStep, async () => {
			const roll = this.raffleRandom.drawInclusiveInteger(1, 10_000);
			logger.info("Generated user roll", { sagaId, userId: params.user_id, roll });
			return { result: roll };
		});
		if (userRollResult.status === "error") {
			return this.handleStepError(userRollResult.error, params, runner);
		}
		const userRoll = userRollResult.value;

		const distance = Math.abs(winningNumber - userRoll);
		const isWinner = distance === 0;
		logger.info("Calculated raffle result", {
			sagaId,
			winningNumber,
			userRoll,
			distance,
			isWinner,
		});

		const recordRollResult = await runner.executeStepWithRollback(
			RecordRollStep,
			async () => {
				const result = await this.raffleRolls.recordRoll({
					id: sagaId,
					userId: params.user_id,
					displayName: params.user_name,
					roll: userRoll,
					winningNumber,
					rolledAt: params.redeemed_at,
				});
				if (result.status === "error") throw result.error;

				logger.info("Recorded raffle roll", {
					sagaId,
					rollId: result.value.roll.id,
					isWinner,
					isNewRecord: result.value.isNewRecord,
				});
				return {
					result: {
						rollId: result.value.roll.id,
						isNewRecord: result.value.isNewRecord,
					},
					undoPayload: result.value.roll.id,
				};
			},
			async (rollId) => {
				const result = await this.raffleRolls.deleteRoll(rollId);
				if (result.status === "error") throw result.error;
				logger.info("Rolled back raffle Roll", { rollId });
			},
		);
		if (recordRollResult.status === "error") {
			return this.handleStepError(recordRollResult.error, params, runner);
		}
		const { isNewRecord } = recordRollResult.value;

		const fulfillResult = await runner.executeStep(FulfillRedemptionStep, async (signal) => {
			const twitch = this.twitchService;
			const result = await twitch.updateRedemptionStatus(params.reward.id, params.id, "FULFILLED", {
				signal,
			});
			if (result.status === "error") throw result.error;

			logger.info("Fulfilled redemption", {
				sagaId,
				redemptionId: params.id,
				rewardId: params.reward.id,
				isWinner,
			});
			return { result: undefined };
		});
		if (fulfillResult.status === "error") {
			return this.handleStepError(fulfillResult.error, params, runner);
		}

		const pointOfNoReturn = await runner.markPointOfNoReturn();
		if (pointOfNoReturn.status === "error") return Result.err(pointOfNoReturn.error);

		const publishResult = await runner.executeStep(PublishEventStep, async () => {
			const event = {
				...createRaffleRollEvent({
					id: await deriveSagaEventId(sagaId),
					userId: params.user_id,
					userDisplayName: params.user_name,
					sagaId,
					roll: userRoll,
					winningNumber,
					distance,
					isWinner,
					isNewRecord,
				}),
				timestamp: params.redeemed_at,
			};
			const result = await this.domainEvents.publish(event);
			if (result.status === "error") throw result.error;
			logger.info("Published raffle_roll event", {
				sagaId,
				eventId: event.id,
				userId: params.user_id,
			});
			return { result: undefined };
		});
		if (publishResult.status === "error") {
			return this.handleStepError(publishResult.error, params, runner);
		}

		const chatResult = await runner.executeStep(SendChatMessageStep, async (signal) => {
			const twitch = this.twitchService;
			const message = isWinner
				? `@${params.user_name} YOU WON THE KEYBOARD! 🎉 Your roll: ${userRoll} | Winning number: ${winningNumber}`
				: `@${params.user_name} lost 😭 Winning number was ${winningNumber} and they rolled ${userRoll}. Distance: ${distance}`;
			const result = await twitch.sendChatMessage(message, { signal });
			if (result.status === "error") {
				logger.warn("Failed to send chat message", {
					sagaId,
					error: result.error.message,
					user: params.user_name,
				});
			} else {
				logger.info("Sent chat message", { sagaId, user: params.user_name, isWinner });
			}
			return { result: undefined };
		});
		if (chatResult.status === "error") {
			if (SagaPersistedDataError.is(chatResult.error)) {
				return this.handleStepError(chatResult.error, params, runner);
			}
			logger.warn("Best-effort chat step did not complete", {
				sagaId,
				error: chatResult.error.message,
			});
		}

		const completion = await runner.complete();
		if (completion.status === "error") return Result.err(completion.error);

		writeRaffleRollMetric(this.analytics, {
			user: params.user_name,
			roll: userRoll,
			winningNumber,
			distance,
			status: isWinner ? "win" : "loss",
		});
		logger.info("Keyboard raffle saga completed successfully", {
			sagaId,
			userId: params.user_id,
			isWinner,
			distance,
		});
		return Result.ok();
	}

	private async handleStepError(
		error: SagaStepExecutionError,
		params: KeyboardRaffleParams,
		runner: SagaRunner<KeyboardRaffleParams>,
	): Promise<Result<void, SagaStepExecutionError>> {
		const sagaId = this.ctx.id.toString();
		if (SagaPersistedDataError.is(error)) return Result.err(error);
		if (SagaStepRetrying.is(error)) {
			logger.info("Step scheduled for retry", {
				sagaId,
				stepName: error.stepName,
				attempt: error.attempt,
				nextRetryAt: error.nextRetryAt,
			});
			return Result.err(error);
		}

		if (SagaScheduleError.is(error)) {
			logger.error("Retry evidence persisted but runtime scheduling failed", {
				sagaId,
				operation: error.operation,
			});
			return Result.err(error);
		}

		logger.error("Saga step failed permanently", {
			sagaId,
			stepName: "stepName" in error ? error.stepName : "unknown",
			error: error.message,
		});
		const pointOfNoReturn = await runner.isPointOfNoReturnReached();
		if (pointOfNoReturn.status === "error") return Result.err(pointOfNoReturn.error);

		if (pointOfNoReturn.value) {
			const terminal = await runner.markPostCommitFailed(error.message);
			return terminal.status === "error" ? Result.err(terminal.error) : Result.err(error);
		}

		if (!pointOfNoReturn.value) {
			const compensation = await runner.compensateAll();
			if (compensation.status === "error") {
				if (SagaStepRetrying.is(compensation.error) || SagaScheduleError.is(compensation.error)) {
					return Result.err(compensation.error);
				}
				logger.error("Keyboard Raffle compensation retry exhausted", { sagaId });
				return Result.err(error);
			}

			const refund = await this.refundRedemption(params, runner);
			if (refund.status === "error") return refund;
		}

		const failed = await runner.fail(error.message);
		return failed.status === "error" ? Result.err(failed.error) : Result.err(error);
	}

	private async refundRedemption(
		params: KeyboardRaffleParams,
		runner: SagaRunner<KeyboardRaffleParams>,
	): Promise<Result<void, SagaStepExecutionError>> {
		return runner.executeCompensationStep(
			"refund-redemption",
			async () => {
				const twitch = this.twitchService;
				const result = await twitch.updateRedemptionStatus(params.reward.id, params.id, "CANCELED");
				if (result.status === "error") throw result.error;
				logger.info("Refunded Keyboard Raffle redemption", {
					sagaId: this.ctx.id.toString(),
					redemptionId: params.id,
				});
			},
			{ timeout: 30000, maxRetries: 5 },
		);
	}
}

/** Production Keyboard Raffle Durable Object with inherited serialized saga RPCs. */
export { _KeyboardRaffleSagaDO as KeyboardRaffleSagaDO };
