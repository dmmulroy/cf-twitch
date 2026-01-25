/**
 * KeyboardRaffleWorkflow - Handles keyboard raffle channel point redemptions
 *
 * Implements saga pattern with rollback support via cf-workflow-rollback.
 * Winners stay PENDING for manual fulfillment; losers auto-fulfill.
 *
 * Flow:
 * 1. Generate winning number 1-10000 (deterministic step)
 * 2. Generate user roll 1-10000 (deterministic step)
 * 3. Calculate distance = abs(winning - roll)
 * 4. Record roll in KeyboardRaffleDO (rollbackable)
 * 5. Fulfill redemption ONLY on loss (winners stay pending for manual handling)
 * 6. Send chat message with roll, winning number, distance
 *
 * Rollback strategy:
 * - record-roll: delete roll from KeyboardRaffleDO by ID
 *
 * Winners (distance === 0) have redemptions stay PENDING for manual fulfillment
 * Losers (distance > 0) have redemptions auto-fulfilled
 */

import { withRollback } from "cf-workflow-rollback";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { writeRaffleRollMetric } from "../lib/analytics";
import { getStub } from "../lib/durable-objects";
import { logger } from "../lib/logger";
import { waitForActivation } from "../lib/warm-workflow";
import { TwitchService } from "../services/twitch-service";

import type { Env } from "../index";

/**
 * Params passed from queue consumer (RedemptionEventSchema)
 */
export interface KeyboardRaffleParams {
	id: string;
	broadcaster_user_id: string;
	broadcaster_user_login: string;
	broadcaster_user_name: string;
	user_id: string;
	user_login: string;
	user_name: string;
	user_input: string;
	status: "unknown" | "unfulfilled" | "fulfilled" | "canceled";
	reward: {
		id: string;
		title: string;
		cost: number;
		prompt: string;
	};
	redeemed_at: string;
}

/** Random int between min and max (inclusive). Step output cached on replay. */
function generateRandomInt(min: number, max: number): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * KeyboardRaffleWorkflow - WorkflowEntrypoint for keyboard raffle redemptions
 *
 * Supports warm pool pattern: instances can be pre-created with undefined payload
 * and wait at step.waitForEvent("activate") until activated with actual params.
 */
export class KeyboardRaffleWorkflow extends WorkflowEntrypoint<
	Env,
	KeyboardRaffleParams | undefined
> {
	override async run(
		event: WorkflowEvent<KeyboardRaffleParams | undefined>,
		workflowStep: WorkflowStep,
	): Promise<void> {
		// Wait for activation if this is a warm instance (undefined payload)
		// or use initial payload directly for cold starts
		// NOTE: Must use workflowStep (not RollbackContext) for waitForEvent
		const params = await waitForActivation(workflowStep, event.payload);

		const step = withRollback(workflowStep);

		// Track whether redemption was fulfilled (determines refund behavior)
		let fulfilled = false;
		let rollId: string | undefined;

		try {
			// Step 1: Generate winning number (deterministic step)
			const winningNumber = await step.do("generate-winning-number", async () => {
				const winning = generateRandomInt(1, 10000);
				logger.info("Generated winning number", {
					eventId: event.instanceId,
					winningNumber: winning,
				});
				return winning;
			});

			// Step 2: Generate user roll (deterministic step)
			const userRoll = await step.do("generate-user-roll", async () => {
				const roll = generateRandomInt(1, 10000);
				logger.info("Generated user roll", {
					eventId: event.instanceId,
					userId: params.user_id,
					roll,
				});
				return roll;
			});

			const distance = Math.abs(winningNumber - userRoll);

			const isWinner = distance === 0;
			logger.info("Calculated raffle result", {
				eventId: event.instanceId,
				winningNumber,
				userRoll,
				distance,
				isWinner,
			});

			// Step 4: Record roll in KeyboardRaffleDO (with rollback)
			rollId = await step.doWithRollback(
				"record-roll",
				{
					run: async () => {
						const stub = getStub("KEYBOARD_RAFFLE_DO");
						const result = await stub.recordRoll({
							id: event.instanceId,
							userId: params.user_id,
							displayName: params.user_name,
							roll: userRoll,
							winningNumber,
							distance,
							isWinner,
							rolledAt: new Date().toISOString(),
						});

						if (result.status === "error") {
							throw new Error(result.error.message);
						}

						logger.info("Recorded raffle roll", {
							eventId: event.instanceId,
							rollId: result.value.id,
							isWinner,
						});

						return result.value.id;
					},
					undo: async (_err, recordedRollId) => {
						const stub = getStub("KEYBOARD_RAFFLE_DO");
						const result = await stub.deleteRollById(recordedRollId);

						if (result.status === "error") {
							logger.error("Failed to rollback raffle roll", {
								rollId: recordedRollId,
								error: result.error.message,
							});
						} else {
							logger.info("Rolled back raffle roll", { rollId: recordedRollId });
						}
					},
				},
				{ timeout: "10 seconds", retries: { limit: 2, delay: "1 second" } },
			);

			await step.do(
				"fulfill-redemption",
				{
					timeout: "30 seconds",
					retries: { limit: 3, delay: "1 second", backoff: "exponential" },
				},
				async () => {
					const twitchService = new TwitchService(this.env);
					const result = await twitchService.updateRedemptionStatus(
						params.reward.id,
						params.id,
						"FULFILLED",
					);

					if (result.status === "error") {
						throw new Error(result.error.message);
					}

					logger.info("Fulfilled redemption", {
						redemptionId: params.id,
						rewardId: params.reward.id,
						isWinner,
					});
				},
			);

			fulfilled = true;

			// Step 6: Send chat message with results (best effort)
			await step.do(
				"send-chat-message",
				{ timeout: "10 seconds", retries: { limit: 2, delay: "1 second" } },
				async () => {
					const twitchService = new TwitchService(this.env);

					const message = isWinner
						? `@${params.user_name} YOU WON THE KEYBOARD! 🎉 Your roll: ${userRoll} | Winning number: ${winningNumber}`
						: `@${params.user_name} lost 😭 Winning number was ${winningNumber} and they rolled ${userRoll}. Distance: ${distance}`;

					const result = await twitchService.sendChatMessage(message);

					if (result.status === "error") {
						// Log but don't fail - chat message is best effort
						logger.warn("Failed to send chat message", {
							error: result.error.message,
							user: params.user_name,
						});
					} else {
						logger.info("Sent chat message", { user: params.user_name, isWinner });
					}
				},
			);

			logger.info("Keyboard raffle workflow completed successfully", {
				eventId: event.instanceId,
				userId: params.user_id,
				isWinner,
				distance,
				rollId,
			});

			// Write analytics metric for raffle roll
			writeRaffleRollMetric(this.env.ANALYTICS, {
				user: params.user_name,
				roll: userRoll,
				winningNumber,
				distance,
				status: isWinner ? "win" : "loss",
			});
		} catch (error) {
			logger.error("Keyboard raffle workflow failed", {
				eventId: event.instanceId,
				error: error instanceof Error ? error.message : String(error),
				fulfilled,
			});

			// Rollback any completed steps that registered undo handlers
			await step.rollbackAll(error);

			// Only refund if we haven't fulfilled the redemption yet
			// (Winners never get auto-fulfilled, so they'll always be refunded on error)
			if (!fulfilled) {
				await step.do(
					"refund-redemption",
					{
						timeout: "30 seconds",
						retries: { limit: 3, delay: "1 second", backoff: "exponential" },
					},
					async () => {
						const twitchService = new TwitchService(this.env);
						const result = await twitchService.updateRedemptionStatus(
							params.reward.id,
							params.id,
							"CANCELED",
						);

						if (result.status === "error") {
							logger.error("Failed to refund redemption", {
								redemptionId: params.id,
								error: result.error.message,
							});
						} else {
							logger.info("Refunded redemption", { redemptionId: params.id });
						}
					},
				);
			}

			throw error;
		}
	}
}
