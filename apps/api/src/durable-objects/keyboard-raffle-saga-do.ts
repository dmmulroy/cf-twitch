import { Result } from "better-result";
import { z } from "zod";

import { writeRaffleRollMetric } from "../lib/analytics";
import { noResultCodec, zodSagaCodec } from "../lib/codecs";
import { getStub, withRpcSerialization } from "../lib/durable-objects";
import {
	SagaNotFoundError,
	SagaPersistedDataError,
	SagaScheduleError,
	SagaStepRetrying,
} from "../lib/errors";
import { logger } from "../lib/logger";
import { SagaHost, type SagaHostDefinition, type SagaHostStatus } from "../lib/saga-host";
import {
	SagaRunner,
	type SagaRollbackStepDefinition,
	type SagaStepDefinition,
	type SagaStepExecutionError,
} from "../lib/saga-runner";
import { TwitchService } from "../services/twitch-service";
import { createRaffleRollEvent } from "./schemas/event-bus-do.schema";

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
	redeemed_at: z.string(),
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
	options: { timeout: 10000, maxRetries: 2 },
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

function generateRandomInt(min: number, max: number): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Keyboard Raffle orchestration hosted by the shared saga lifecycle. */
class _KeyboardRaffleSagaDO extends SagaHost<KeyboardRaffleParams, KeyboardRaffleSagaError> {
	protected get sagaDefinition(): SagaHostDefinition<KeyboardRaffleParams> {
		return KEYBOARD_RAFFLE_SAGA;
	}

	protected async runSaga(
		params: KeyboardRaffleParams,
		runner: SagaRunner<KeyboardRaffleParams>,
	): Promise<Result<void, KeyboardRaffleSagaError>> {
		const sagaId = this.ctx.id.toString();

		const winningNumberResult = await runner.executeStep(GenerateWinningNumberStep, async () => {
			const winningNumber = generateRandomInt(1, 10000);
			logger.info("Generated winning number", { sagaId, winningNumber });
			return { result: winningNumber };
		});
		if (winningNumberResult.status === "error") {
			return this.handleStepError(winningNumberResult.error, params, runner);
		}
		const winningNumber = winningNumberResult.value;

		const userRollResult = await runner.executeStep(GenerateUserRollStep, async () => {
			const roll = generateRandomInt(1, 10000);
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
				const raffle = getStub("KEYBOARD_RAFFLE_DO");
				const result = await raffle.recordRoll({
					id: sagaId,
					userId: params.user_id,
					displayName: params.user_name,
					roll: userRoll,
					winningNumber,
					distance,
					isWinner,
					rolledAt: new Date().toISOString(),
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
				const raffle = getStub("KEYBOARD_RAFFLE_DO");
				const result = await raffle.deleteRollById(rollId);
				if (result.status === "error") {
					logger.error("Failed to rollback raffle roll", {
						rollId,
						error: result.error.message,
					});
				} else {
					logger.info("Rolled back raffle roll", { rollId });
				}
			},
		);
		if (recordRollResult.status === "error") {
			return this.handleStepError(recordRollResult.error, params, runner);
		}
		const { isNewRecord } = recordRollResult.value;

		const fulfillResult = await runner.executeStep(FulfillRedemptionStep, async () => {
			const twitch = new TwitchService(this.env);
			const result = await twitch.updateRedemptionStatus(params.reward.id, params.id, "FULFILLED");
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
			const eventBus = getStub("EVENT_BUS_DO");
			const event = createRaffleRollEvent({
				id: crypto.randomUUID(),
				userId: params.user_id,
				userDisplayName: params.user_name,
				sagaId,
				roll: userRoll,
				winningNumber,
				distance,
				isWinner,
				isNewRecord,
			});
			const result = await eventBus.publish(event);
			if (result.status === "error") {
				logger.warn("Failed to publish raffle_roll event", {
					sagaId,
					error: result.error.message,
				});
			} else {
				logger.info("Published raffle_roll event", {
					sagaId,
					eventId: event.id,
					userId: params.user_id,
				});
			}
			return { result: undefined };
		});
		if (publishResult.status === "error") {
			if (SagaPersistedDataError.is(publishResult.error)) {
				return this.handleStepError(publishResult.error, params, runner);
			}
			logger.warn("Fire-and-forget EventBus publication step did not complete", {
				sagaId,
				error: publishResult.error.message,
			});
		}

		const chatResult = await runner.executeStep(SendChatMessageStep, async () => {
			const twitch = new TwitchService(this.env);
			const message = isWinner
				? `@${params.user_name} YOU WON THE KEYBOARD! 🎉 Your roll: ${userRoll} | Winning number: ${winningNumber}`
				: `@${params.user_name} lost 😭 Winning number was ${winningNumber} and they rolled ${userRoll}. Distance: ${distance}`;
			const result = await twitch.sendChatMessage(message);
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

		writeRaffleRollMetric(this.env.ANALYTICS, {
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

		if (!pointOfNoReturn.value) {
			const compensation = await runner.compensateAll();
			if (compensation.status === "error") {
				logger.error("One or more Keyboard Raffle compensations failed", {
					sagaId,
					failedSteps: compensation.error.map((failure) => failure.stepName),
				});
			}
			await this.refundRedemption(params);
		}

		const failed = await runner.fail(error.message);
		return failed.status === "error" ? Result.err(failed.error) : Result.err(error);
	}

	private async refundRedemption(params: KeyboardRaffleParams): Promise<void> {
		const twitch = new TwitchService(this.env);
		const result = await twitch.updateRedemptionStatus(params.reward.id, params.id, "CANCELED");
		if (result.status === "error") {
			logger.error("Failed to refund redemption", {
				sagaId: this.ctx.id.toString(),
				redemptionId: params.id,
				error: result.error.message,
			});
		} else {
			logger.info("Refunded redemption", {
				sagaId: this.ctx.id.toString(),
				redemptionId: params.id,
			});
		}
	}
}

/** Production Keyboard Raffle Durable Object with inherited serialized saga RPCs. */
export const KeyboardRaffleSagaDO = withRpcSerialization(_KeyboardRaffleSagaDO);
