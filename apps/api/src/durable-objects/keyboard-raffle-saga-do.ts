/**
 * KeyboardRaffleSagaDO - Handles keyboard raffle saga with durable step execution
 *
 * Each instance is keyed by redemption ID for per-saga isolation.
 * Uses SagaRunner for step execution with retry and compensation support.
 *
 * Flow:
 * 1. generate-winning-number → random 1-10000 (cached on replay)
 * 2. generate-user-roll → random 1-10000 (cached on replay)
 * 3. record-roll → KeyboardRaffleDO (rollbackable)
 * 4. fulfill-redemption → POINT OF NO RETURN (both winners and losers)
 * 5. send-chat-message → best-effort notification
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/saga-do/migrations";
import { writeRaffleRollMetric } from "../lib/analytics";
import { getStub } from "../lib/durable-objects";
import {
	SagaAlreadyExistsError,
	SagaNotFoundError,
	SagaStepError,
	SagaStepRetrying,
} from "../lib/errors";
import { logger } from "../lib/logger";
import { SagaRunner, SagaRunnerDbError } from "../lib/saga-runner";
import { TwitchService } from "../services/twitch-service";
import * as sagaSchema from "./schemas/saga.schema";
import { type SagaStatus, sagaRuns } from "./schemas/saga.schema";

import type { Env } from "../index";

/**
 * Params for starting a keyboard raffle saga
 * Matches workflow KeyboardRaffleParams structure
 */
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

export type KeyboardRaffleParams = z.infer<typeof KeyboardRaffleParamsSchema>;

/**
 * Status response for getStatus RPC
 */
export interface KeyboardRaffleSagaStatus {
	sagaId: string;
	status: SagaStatus;
	fulfilledAt: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Generate random integer between min and max (inclusive)
 */
function generateRandomInt(min: number, max: number): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * KeyboardRaffleSagaDO - Durable Object for keyboard raffle saga orchestration
 *
 * Each instance handles a single raffle roll (keyed by redemption ID).
 * Uses DO alarms for retry scheduling and durable step execution.
 */
export class KeyboardRaffleSagaDO extends DurableObject<Env> {
	private db: ReturnType<typeof drizzle<typeof sagaSchema>>;
	private runner: SagaRunner | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema: sagaSchema });

		void this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	/**
	 * Get or create saga runner for this instance
	 */
	private getRunner(): SagaRunner {
		if (!this.runner) {
			this.runner = new SagaRunner(
				this.ctx.id.toString(),
				this.db,
				this.ctx,
				this.env.ANALYTICS,
				"keyboard-raffle-saga",
			);
		}
		return this.runner;
	}

	/**
	 * Start the keyboard raffle saga (idempotent)
	 *
	 * If saga already exists, returns success (idempotent).
	 * Otherwise, initializes saga and begins execution.
	 */
	async start(
		params: KeyboardRaffleParams,
	): Promise<
		Result<void, SagaAlreadyExistsError | SagaRunnerDbError | SagaStepError | SagaStepRetrying>
	> {
		const runner = this.getRunner();
		const sagaId = this.ctx.id.toString();

		logger.info("Starting keyboard raffle saga", {
			sagaId,
			redemptionId: params.id,
			user: params.user_name,
		});

		const initResult = await runner.initSaga(params);

		if (initResult.status === "error") {
			if (SagaAlreadyExistsError.is(initResult.error)) {
				logger.info("Saga already exists, resuming", { sagaId });
			} else {
				return Result.err(initResult.error);
			}
		}

		return this.execute();
	}

	/**
	 * Execute the saga steps
	 */
	private async execute(): Promise<
		Result<void, SagaRunnerDbError | SagaStepError | SagaStepRetrying>
	> {
		const runner = this.getRunner();
		const sagaId = this.ctx.id.toString();

		// Status gating: only proceed if saga is in RUNNING state
		const isRunningResult = await runner.isRunning();
		if (isRunningResult.status === "error") {
			return Result.err(isRunningResult.error);
		}
		if (!isRunningResult.value) {
			logger.info("Saga not in RUNNING state, skipping execution", { sagaId });
			return Result.ok();
		}

		const paramsResult = await runner.getParams<KeyboardRaffleParams>();
		if (paramsResult.status === "error") {
			if (SagaNotFoundError.is(paramsResult.error)) {
				logger.error("Saga not found during execute", { sagaId });
				return Result.ok();
			}
			return Result.err(paramsResult.error);
		}

		const params = paramsResult.value;
		if (!params) {
			logger.error("No params found for saga", { sagaId });
			return Result.ok();
		}

		// Step 1: Generate winning number (cached on replay)
		const winningNumberResult = await runner.executeStep("generate-winning-number", async () => {
			const winning = generateRandomInt(1, 10000);
			logger.info("Generated winning number", { sagaId, winningNumber: winning });
			return { result: winning };
		});

		if (winningNumberResult.status === "error") {
			return this.handleStepError(winningNumberResult.error, params);
		}
		const winningNumber = winningNumberResult.value;

		// Step 2: Generate user roll (cached on replay)
		const userRollResult = await runner.executeStep("generate-user-roll", async () => {
			const roll = generateRandomInt(1, 10000);
			logger.info("Generated user roll", { sagaId, userId: params.user_id, roll });
			return { result: roll };
		});

		if (userRollResult.status === "error") {
			return this.handleStepError(userRollResult.error, params);
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

		// Step 3: Record roll in KeyboardRaffleDO (with rollback)
		const recordRollResult = await runner.executeStepWithRollback(
			"record-roll",
			async () => {
				const stub = getStub("KEYBOARD_RAFFLE_DO");
				const result = await stub.recordRoll({
					id: sagaId,
					userId: params.user_id,
					displayName: params.user_name,
					roll: userRoll,
					winningNumber,
					distance,
					isWinner,
					rolledAt: new Date().toISOString(),
				});

				if (result.status === "error") {
					throw result.error;
				}

				logger.info("Recorded raffle roll", {
					sagaId,
					rollId: result.value.id,
					isWinner,
				});

				return { result: result.value.id, undoPayload: result.value.id };
			},
			async (undoPayload) => {
				const rollId = undoPayload as string;
				const stub = getStub("KEYBOARD_RAFFLE_DO");
				const result = await stub.deleteRollById(rollId);

				if (result.status === "error") {
					logger.error("Failed to rollback raffle roll", {
						rollId,
						error: result.error.message,
					});
				} else {
					logger.info("Rolled back raffle roll", { rollId });
				}
			},
			{ timeout: 10000, maxRetries: 2 },
		);

		if (recordRollResult.status === "error") {
			return this.handleStepError(recordRollResult.error, params);
		}

		// Step 4: Fulfill redemption (POINT OF NO RETURN - always fulfill for both winners and losers)
		const fulfillResult = await runner.executeStep(
			"fulfill-redemption",
			async () => {
				const twitchService = new TwitchService(this.env);
				const result = await twitchService.updateRedemptionStatus(
					params.reward.id,
					params.id,
					"FULFILLED",
				);

				if (result.status === "error") {
					throw result.error;
				}

				logger.info("Fulfilled redemption", {
					sagaId,
					redemptionId: params.id,
					rewardId: params.reward.id,
					isWinner,
				});

				return { result: undefined };
			},
			{ timeout: 30000, maxRetries: 3 },
		);

		if (fulfillResult.status === "error") {
			return this.handleStepError(fulfillResult.error, params);
		}

		// Mark point of no return immediately after fulfill
		await runner.markPointOfNoReturn();

		// Step 5: Send chat message (best effort)
		await runner.executeStep(
			"send-chat-message",
			async () => {
				const twitchService = new TwitchService(this.env);

				const message = isWinner
					? `@${params.user_name} YOU WON THE KEYBOARD! 🎉 Your roll: ${userRoll} | Winning number: ${winningNumber}`
					: `@${params.user_name} lost 😭 Winning number was ${winningNumber} and they rolled ${userRoll}. Distance: ${distance}`;

				const result = await twitchService.sendChatMessage(message);

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
			},
			{ timeout: 10000, maxRetries: 2 },
		);

		// Mark saga as complete
		await runner.complete();

		// Write analytics metric
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

	/**
	 * Handle step error - either schedule retry or run compensation
	 */
	private async handleStepError(
		error: SagaStepError | SagaStepRetrying | SagaRunnerDbError,
		params: KeyboardRaffleParams,
	): Promise<Result<void, SagaStepError | SagaStepRetrying | SagaRunnerDbError>> {
		const runner = this.getRunner();
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

		logger.error("Saga step failed permanently", {
			sagaId,
			stepName: SagaStepError.is(error) ? error.stepName : "unknown",
			error: error.message,
		});

		const ponrResult = await runner.isPointOfNoReturnReached();
		const ponrReached = ponrResult.status === "ok" && ponrResult.value;

		if (!ponrReached) {
			await runner.compensateAll();
			await this.refundRedemption(params);
		}

		await runner.fail(error.message);

		return Result.err(error);
	}

	/**
	 * Refund the redemption (cancel)
	 */
	private async refundRedemption(params: KeyboardRaffleParams): Promise<void> {
		const sagaId = this.ctx.id.toString();

		const twitchService = new TwitchService(this.env);
		const result = await twitchService.updateRedemptionStatus(
			params.reward.id,
			params.id,
			"CANCELED",
		);

		if (result.status === "error") {
			logger.error("Failed to refund redemption", {
				sagaId,
				redemptionId: params.id,
				error: result.error.message,
			});
		} else {
			logger.info("Refunded redemption", { sagaId, redemptionId: params.id });
		}
	}

	/**
	 * Get saga status for debugging/monitoring
	 */
	async getStatus(): Promise<Result<KeyboardRaffleSagaStatus | null, SagaRunnerDbError>> {
		const sagaId = this.ctx.id.toString();

		return Result.tryPromise({
			try: async () => {
				const saga = await this.db.query.sagaRuns.findFirst({
					where: eq(sagaRuns.id, sagaId),
				});

				if (!saga) {
					return null;
				}

				return {
					sagaId: saga.id,
					status: saga.status,
					fulfilledAt: saga.fulfilledAt,
					error: saga.error,
					createdAt: saga.createdAt,
					updatedAt: saga.updatedAt,
				};
			},
			catch: (cause) => new SagaRunnerDbError({ operation: "getStatus", cause }),
		});
	}

	/**
	 * DO alarm handler - resumes saga execution on retry
	 */
	async alarm(): Promise<void> {
		const sagaId = this.ctx.id.toString();
		logger.info("Saga alarm triggered", { sagaId });

		const runner = this.getRunner();

		const sagaResult = await runner.getSaga();
		if (sagaResult.status === "error" || !sagaResult.value) {
			logger.error("Saga not found on alarm", { sagaId });
			return;
		}

		const saga = sagaResult.value;

		if (saga.status !== "RUNNING") {
			logger.info("Saga not in RUNNING state, skipping alarm", { sagaId, status: saga.status });
			return;
		}

		const executeResult = await this.execute();

		if (executeResult.status === "error") {
			if (SagaStepRetrying.is(executeResult.error)) {
				logger.info("Saga step scheduled for retry", {
					sagaId,
					stepName: executeResult.error.stepName,
				});
			} else {
				logger.error("Saga execution failed on alarm", {
					sagaId,
					error: executeResult.error.message,
				});
			}
		}
	}
}
