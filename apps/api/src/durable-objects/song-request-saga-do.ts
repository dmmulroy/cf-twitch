/**
 * SongRequestSagaDO - Handles song request saga with durable step execution
 *
 * Each instance is keyed by redemption ID for per-saga isolation.
 * Uses SagaRunner for step execution with retry and compensation support.
 *
 * Flow:
 * 1. parse-spotify-url → extract track ID (NonRetryable on invalid)
 * 2. get-track-info → fetch from Spotify API
 * 3. persist-request → SongQueueDO (rollbackable)
 * 4. add-to-spotify-queue → with rollback (skip if currently playing)
 * 5. write-history → analytics, non-critical
 * 6. fulfill-redemption → POINT OF NO RETURN
 * 7. send-chat-confirmation → best-effort
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/saga-do/migrations";
import { getStub } from "../lib/durable-objects";
import {
	InvalidSpotifyUrlError,
	SagaAlreadyExistsError,
	SagaNotFoundError,
	SagaStepError,
	SagaStepRetrying,
	isRetryableError,
} from "../lib/errors";
import { logger } from "../lib/logger";
import { SagaRunner, SagaRunnerDbError } from "../lib/saga-runner";
import { SpotifyService, type TrackInfo } from "../services/spotify-service";
import { TwitchService } from "../services/twitch-service";
import * as sagaSchema from "./schemas/saga.schema";
import { type SagaStatus, sagaRuns } from "./schemas/saga.schema";

import type { Env } from "../index";

/**
 * Params for starting a song request saga
 * Matches workflow SongRequestParams structure
 */
export const SongRequestParamsSchema = z.object({
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

export type SongRequestParams = z.infer<typeof SongRequestParamsSchema>;

/**
 * Status response for getStatus RPC
 */
export interface SongRequestSagaStatus {
	sagaId: string;
	status: SagaStatus;
	fulfilledAt: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Parse Spotify URL and extract track ID
 * Supports:
 * - https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh
 * - spotify:track:4iV5W9uYEdYUVa79Axb7Rh
 * - https://open.spotify.com/intl-de/track/4iV5W9uYEdYUVa79Axb7Rh?si=abc123
 */
function parseSpotifyUrl(input: string): string | null {
	const trimmed = input.trim();

	const uriMatch = trimmed.match(/^spotify:track:([a-zA-Z0-9]+)$/);
	if (uriMatch?.[1]) {
		return uriMatch[1];
	}

	const urlMatch = trimmed.match(
		/^https?:\/\/open\.spotify\.com(?:\/intl-[a-z]{2})?\/track\/([a-zA-Z0-9]+)/,
	);
	if (urlMatch?.[1]) {
		return urlMatch[1];
	}

	return null;
}

/**
 * SongRequestSagaDO - Durable Object for song request saga orchestration
 *
 * Each instance handles a single song request (keyed by redemption ID).
 * Uses DO alarms for retry scheduling and durable step execution.
 */
export class SongRequestSagaDO extends DurableObject<Env> {
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
				"song-request-saga",
			);
		}
		return this.runner;
	}

	/**
	 * Start the song request saga (idempotent)
	 *
	 * If saga already exists, returns success (idempotent).
	 * Otherwise, initializes saga and begins execution.
	 */
	async start(
		params: SongRequestParams,
	): Promise<
		Result<void, SagaAlreadyExistsError | SagaRunnerDbError | SagaStepError | SagaStepRetrying>
	> {
		const runner = this.getRunner();
		const sagaId = this.ctx.id.toString();

		logger.info("Starting song request saga", {
			sagaId,
			redemptionId: params.id,
			user: params.user_name,
			input: params.user_input,
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

		const paramsResult = await runner.getParams<SongRequestParams>();
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

		let trackId: string | undefined;
		let trackInfo: TrackInfo | undefined;

		// Step 1: Parse Spotify URL
		const parseResult = await runner.executeStep("parse-spotify-url", async () => {
			const id = parseSpotifyUrl(params.user_input);
			if (!id) {
				throw new InvalidSpotifyUrlError({ url: params.user_input });
			}
			logger.info("Parsed Spotify URL", { sagaId, trackId: id, input: params.user_input });
			return { result: id };
		});

		if (parseResult.status === "error") {
			return this.handleStepError(parseResult.error, params);
		}
		trackId = parseResult.value;

		// Step 2: Get track info from Spotify
		const trackInfoResult = await runner.executeStep(
			"get-track-info",
			async () => {
				const spotifyService = new SpotifyService(this.env);
				const result = await spotifyService.getTrack(trackId as string);

				if (result.status === "error") {
					const err = result.error;
					if (err._tag === "SpotifyTrackNotFoundError") {
						throw new InvalidSpotifyUrlError({ url: `spotify:track:${trackId}` });
					}
					if (isRetryableError(err)) {
						throw err;
					}
					throw new Error(err.message);
				}

				logger.info("Got track info", {
					sagaId,
					trackId: result.value.id,
					name: result.value.name,
				});

				return { result: result.value };
			},
			{ timeout: 30000, maxRetries: 3 },
		);

		if (trackInfoResult.status === "error") {
			return this.handleStepError(trackInfoResult.error, params);
		}
		trackInfo = trackInfoResult.value;

		// Step 3: Persist request in SongQueueDO (with rollback)
		const persistResult = await runner.executeStepWithRollback(
			"persist-request",
			async () => {
				const stub = getStub("SONG_QUEUE_DO");
				const result = await stub.persistRequest({
					eventId: sagaId,
					trackId: trackInfo?.id ?? "",
					trackName: trackInfo?.name ?? "",
					artists: JSON.stringify(trackInfo?.artists ?? []),
					album: trackInfo?.album ?? "",
					albumCoverUrl: trackInfo?.albumCoverUrl,
					requesterUserId: params.user_id,
					requesterDisplayName: params.user_name,
					requestedAt: new Date().toISOString(),
				});

				if (result.status === "error") {
					throw result.error;
				}

				logger.info("Persisted song request", { sagaId });
				return { result: sagaId, undoPayload: { eventId: sagaId } };
			},
			async (undoPayload) => {
				const payload = undoPayload as { eventId: string };
				const stub = getStub("SONG_QUEUE_DO");
				const result = await stub.deleteRequest(payload.eventId);
				if (result.status === "error") {
					logger.error("Failed to rollback song request", {
						eventId: payload.eventId,
						error: result.error.message,
					});
				} else {
					logger.info("Rolled back song request", { eventId: payload.eventId });
				}
			},
			{ timeout: 10000, maxRetries: 2 },
		);

		if (persistResult.status === "error") {
			return this.handleStepError(persistResult.error, params);
		}

		// Step 4: Add to Spotify queue (with rollback - skip if playing)
		const addToQueueResult = await runner.executeStepWithRollback(
			"add-to-spotify-queue",
			async () => {
				const spotifyService = new SpotifyService(this.env);

				const queueResult = await spotifyService.getQueue();
				if (queueResult.status === "ok") {
					const alreadyQueued = queueResult.value.queue.some((t) => t.id === trackId);
					if (alreadyQueued) {
						logger.info("Track already in Spotify queue, skipping add", { sagaId, trackId });
						return { result: trackId as string, undoPayload: { trackId } };
					}
				}

				const result = await spotifyService.addToQueue(`spotify:track:${trackId}`);

				if (result.status === "error") {
					throw result.error;
				}

				logger.info("Added track to Spotify queue", { sagaId, trackId });
				return { result: trackId as string, undoPayload: { trackId } };
			},
			async (undoPayload) => {
				const payload = undoPayload as { trackId: string };
				const spotifyService = new SpotifyService(this.env);
				const currentResult = await spotifyService.getCurrentlyPlaying();

				if (currentResult.status === "error") {
					logger.warn("Could not check currently playing for rollback", {
						trackId: payload.trackId,
						error: currentResult.error.message,
					});
					return;
				}

				const currentTrack = currentResult.value;
				if (currentTrack && currentTrack.id === payload.trackId) {
					const skipResult = await spotifyService.skipTrack();
					if (skipResult.status === "error") {
						logger.warn("Failed to skip track during rollback", {
							trackId: payload.trackId,
							error: skipResult.error.message,
						});
					} else {
						logger.info("Skipped track during rollback", { trackId: payload.trackId });
					}
				} else {
					logger.warn("Track queued but not playing, cannot remove from Spotify queue", {
						trackId: payload.trackId,
						currentlyPlaying: currentTrack?.id ?? null,
					});
				}
			},
			{ timeout: 30000, maxRetries: 3 },
		);

		if (addToQueueResult.status === "error") {
			return this.handleStepError(addToQueueResult.error, params);
		}

		// Step 5: Write to history (non-critical, don't fail saga)
		await runner.executeStep(
			"write-history",
			async () => {
				const stub = getStub("SONG_QUEUE_DO");
				const result = await stub.writeHistory(sagaId, new Date().toISOString());

				if (result.status === "error") {
					logger.warn("Failed to write request history", {
						sagaId,
						error: result.error.message,
					});
				} else {
					logger.info("Wrote request to history", { sagaId });
				}

				return { result: undefined };
			},
			{ timeout: 10000, maxRetries: 2 },
		);

		// Step 6: Fulfill redemption (POINT OF NO RETURN)
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

		// Step 7: Send chat confirmation (best effort)
		await runner.executeStep(
			"send-chat-confirmation",
			async () => {
				const twitchService = new TwitchService(this.env);
				const artistStr = trackInfo?.artists.join(", ") ?? "Unknown Artist";
				const message = `@${params.user_name} added "${trackInfo?.name ?? "Unknown Track"}" by ${artistStr} to the queue!`;

				const result = await twitchService.sendChatMessage(message);

				if (result.status === "error") {
					logger.warn("Failed to send chat confirmation", {
						sagaId,
						error: result.error.message,
						user: params.user_name,
					});
				} else {
					logger.info("Sent chat confirmation", { sagaId, user: params.user_name });
				}

				return { result: undefined };
			},
			{ timeout: 10000, maxRetries: 2 },
		);

		// Mark saga as complete
		await runner.complete();

		logger.info("Song request saga completed successfully", {
			sagaId,
			trackId,
			requester: params.user_name,
		});

		return Result.ok();
	}

	/**
	 * Handle step error - either schedule retry or run compensation
	 */
	private async handleStepError(
		error: SagaStepError | SagaStepRetrying | SagaRunnerDbError,
		params: SongRequestParams,
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
			await this.sendFailureMessage(params);
		}

		await runner.fail(error.message);

		return Result.err(error);
	}

	/**
	 * Refund the redemption (cancel)
	 */
	private async refundRedemption(params: SongRequestParams): Promise<void> {
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
	 * Send failure message to chat
	 */
	private async sendFailureMessage(params: SongRequestParams): Promise<void> {
		const sagaId = this.ctx.id.toString();

		const twitchService = new TwitchService(this.env);
		const message = `@${params.user_name} your song request was invalid and your points have been refunded. Did you use a valid Spotify track link?`;

		const result = await twitchService.sendChatMessage(message);
		if (result.status === "error") {
			logger.warn("Failed to send failure chat message", {
				sagaId,
				error: result.error.message,
				user: params.user_name,
			});
		} else {
			logger.info("Sent failure chat message", { sagaId, user: params.user_name });
		}
	}

	/**
	 * Get saga status for debugging/monitoring
	 */
	async getStatus(): Promise<Result<SongRequestSagaStatus | null, SagaRunnerDbError>> {
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
