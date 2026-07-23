import { Result } from "better-result";
import { z } from "zod";

import { noResultCodec, stringCodec, zodSagaCodec } from "../lib/codecs";
import { getStub, withRpcSerialization } from "../lib/durable-objects";
import {
	InvalidSpotifyUrlError,
	SagaNotFoundError,
	SagaPersistedDataError,
	SagaStepError,
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
import { getSongQueue } from "../lib/song-queue-client";
import {
	parseSpotifyTrackInput,
	spotifyTrackUri,
	type SpotifyTrackId,
} from "../lib/spotify-track-id";
import { SpotifyService } from "../services/spotify-service";
import { TwitchService } from "../services/twitch-service";
import { createSongRequestSuccessEvent } from "./schemas/event-bus-do.schema";

/** Boundary schema for canonical Song Request redemption parameters. */
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

/** Canonical Song Request parameters persisted without webhook routing metadata. */
export type SongRequestParams = z.infer<typeof SongRequestParamsSchema>;

/** Named persistence codec for canonical Song Request parameters. */
export const SongRequestParamsCodec = zodSagaCodec({
	name: "song-request-params",
	codec: z.codec(SongRequestParamsSchema, SongRequestParamsSchema, {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

/** Shared host status projection retained under the Song Request API name. */
export type SongRequestSagaStatus = SagaHostStatus;

type SongRequestSagaError = SagaStepExecutionError | SagaNotFoundError;

const SongRequestSpotifyTrackSchema = z.object({
	id: z.string(),
	name: z.string(),
	artists: z.array(z.string()),
	album: z.string(),
	albumCoverUrl: z.string().nullable(),
});

type SongRequestSpotifyTrack = z.infer<typeof SongRequestSpotifyTrackSchema>;

const SongRequestSpotifyTrackCodec = zodSagaCodec({
	name: "song-request-spotify-track",
	codec: z.codec(SongRequestSpotifyTrackSchema, SongRequestSpotifyTrackSchema, {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

const SPOTIFY_TRACK_ID_PATTERN = /^[a-zA-Z0-9]+$/;

function isPersistedSpotifyTrackId(value: unknown): value is SpotifyTrackId {
	return typeof value === "string" && SPOTIFY_TRACK_ID_PATTERN.test(value);
}

function parsePersistedSpotifyTrackId(value: string): SpotifyTrackId {
	const parsed = parseSpotifyTrackInput(`spotify:track:${value}`);
	if (parsed.status === "error") {
		throw new Error("Spotify Track ID schema and parser disagree");
	}
	return parsed.value;
}

const SpotifyTrackIdSchema = z.string().regex(SPOTIFY_TRACK_ID_PATTERN);
const CanonicalSpotifyTrackIdSchema = z.custom<SpotifyTrackId>(isPersistedSpotifyTrackId);

const SpotifyTrackIdCodec = zodSagaCodec({
	name: "spotify-track-id",
	codec: z.codec(SpotifyTrackIdSchema, CanonicalSpotifyTrackIdSchema, {
		decode: parsePersistedSpotifyTrackId,
		encode: (value) => value,
	}),
});

const PersistRequestUndoSchema = z.object({ eventId: z.string() });
type PersistRequestUndo = z.infer<typeof PersistRequestUndoSchema>;
const PersistRequestUndoCodec = zodSagaCodec({
	name: "song-request-persist-request-undo",
	codec: z.codec(PersistRequestUndoSchema, PersistRequestUndoSchema, {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

const AddToSpotifyQueueUndoSchema = z.object({ trackId: SpotifyTrackIdSchema });
type AddToSpotifyQueueUndo = { readonly trackId: SpotifyTrackId };
const AddToSpotifyQueueUndoCanonicalSchema = z.object({ trackId: CanonicalSpotifyTrackIdSchema });
const AddToSpotifyQueueUndoCodec = zodSagaCodec<AddToSpotifyQueueUndo>({
	name: "song-request-add-to-spotify-queue-undo",
	codec: z.codec(AddToSpotifyQueueUndoSchema, AddToSpotifyQueueUndoCanonicalSchema, {
		decode: (value) => ({ trackId: parsePersistedSpotifyTrackId(value.trackId) }),
		encode: (value) => ({ trackId: value.trackId }),
	}),
});

const ParseSpotifyUrlStep: SagaStepDefinition<SpotifyTrackId> = {
	name: "parse-spotify-url",
	resultCodec: SpotifyTrackIdCodec,
};

const GetTrackInfoStep: SagaStepDefinition<SongRequestSpotifyTrack> = {
	name: "get-track-info",
	resultCodec: SongRequestSpotifyTrackCodec,
	options: { timeout: 30000, maxRetries: 3 },
};

const PersistRequestStep: SagaRollbackStepDefinition<string, PersistRequestUndo> = {
	name: "persist-request",
	resultCodec: stringCodec,
	undoCodec: PersistRequestUndoCodec,
	options: { timeout: 10000, maxRetries: 2 },
};

const AddToSpotifyQueueStep: SagaRollbackStepDefinition<SpotifyTrackId, AddToSpotifyQueueUndo> = {
	name: "add-to-spotify-queue",
	resultCodec: SpotifyTrackIdCodec,
	undoCodec: AddToSpotifyQueueUndoCodec,
	options: { timeout: 30000, maxRetries: 3 },
};

const FulfillRedemptionStep: SagaStepDefinition<void> = {
	name: "fulfill-redemption",
	resultCodec: noResultCodec,
	options: { timeout: 30000, maxRetries: 3 },
};

const SendChatConfirmationStep: SagaStepDefinition<void> = {
	name: "send-chat-confirmation",
	resultCodec: noResultCodec,
	options: { timeout: 10000, maxRetries: 2 },
};

const PublishEventStep: SagaStepDefinition<void> = {
	name: "publish-event",
	resultCodec: noResultCodec,
	options: { timeout: 10000, maxRetries: 2 },
};

const SONG_REQUEST_SAGA: SagaHostDefinition<SongRequestParams> = {
	sagaType: "song-request-saga",
	paramsCodec: SongRequestParamsCodec,
};

/** Song Request orchestration hosted by the shared saga lifecycle. */
class _SongRequestSagaDO extends SagaHost<SongRequestParams, SongRequestSagaError> {
	protected get sagaDefinition(): SagaHostDefinition<SongRequestParams> {
		return SONG_REQUEST_SAGA;
	}

	protected async runSaga(
		params: SongRequestParams,
		runner: SagaRunner<SongRequestParams>,
	): Promise<Result<void, SongRequestSagaError>> {
		const sagaId = this.ctx.id.toString();

		const parseResult = await runner.executeStep(ParseSpotifyUrlStep, async () => {
			const trackIdResult = parseSpotifyTrackInput(params.user_input);
			if (trackIdResult.status === "error") throw trackIdResult.error;

			logger.info("Parsed Spotify track input", {
				sagaId,
				trackId: trackIdResult.value,
				input: params.user_input,
			});
			return { result: trackIdResult.value };
		});
		if (parseResult.status === "error") {
			return this.handleStepError(parseResult.error, params, runner);
		}
		const trackId = parseResult.value;

		const trackInfoResult = await runner.executeStep(GetTrackInfoStep, async () => {
			const spotify = new SpotifyService(this.env);
			const result = await spotify.getTrack(trackId);
			if (result.status === "error") {
				if (result.error._tag === "SpotifyTrackNotFoundError") {
					throw new InvalidSpotifyUrlError({ url: spotifyTrackUri(trackId) });
				}
				throw result.error;
			}

			logger.info("Got track info", {
				sagaId,
				trackId: result.value.id,
				name: result.value.name,
			});
			return { result: result.value };
		});
		if (trackInfoResult.status === "error") {
			return this.handleStepError(trackInfoResult.error, params, runner);
		}
		const trackInfo = trackInfoResult.value;

		const persistResult = await runner.executeStepWithRollback(
			PersistRequestStep,
			async () => {
				using songQueue = await getSongQueue();
				const result = await songQueue.persistRequest({
					eventId: sagaId,
					trackId: trackInfo.id,
					trackName: trackInfo.name,
					artists: JSON.stringify(trackInfo.artists),
					album: trackInfo.album,
					albumCoverUrl: trackInfo.albumCoverUrl,
					requesterUserId: params.user_id,
					requesterDisplayName: params.user_name,
					requestedAt: new Date().toISOString(),
				});
				if (result.status === "error") throw result.error;

				logger.info("Persisted song request", { sagaId });
				return { result: sagaId, undoPayload: { eventId: sagaId } };
			},
			async (undoPayload) => {
				using songQueue = await getSongQueue();
				const result = await songQueue.deleteRequest(undoPayload.eventId);
				if (result.status === "error") {
					logger.error("Failed to rollback song request", {
						eventId: undoPayload.eventId,
						error: result.error.message,
					});
				} else {
					logger.info("Rolled back song request", { eventId: undoPayload.eventId });
				}
			},
		);
		if (persistResult.status === "error") {
			return this.handleStepError(persistResult.error, params, runner);
		}

		const addToQueueResult = await runner.executeStepWithRollback(
			AddToSpotifyQueueStep,
			async () => {
				const spotify = new SpotifyService(this.env);
				const queueResult = await spotify.getQueue();
				if (
					queueResult.status === "ok" &&
					queueResult.value.queue.some((track) => track.id === trackId)
				) {
					logger.info("Track already in Spotify queue, skipping add", { sagaId, trackId });
					return { result: trackId, undoPayload: { trackId } };
				}

				const result = await spotify.addToQueue(spotifyTrackUri(trackId));
				if (result.status === "error") throw result.error;

				logger.info("Added track to Spotify queue", { sagaId, trackId });
				return { result: trackId, undoPayload: { trackId } };
			},
			async (undoPayload) => {
				const spotify = new SpotifyService(this.env);
				const currentResult = await spotify.getCurrentlyPlaying();
				if (currentResult.status === "error") {
					logger.warn("Could not check currently playing for rollback", {
						trackId: undoPayload.trackId,
						error: currentResult.error.message,
					});
					return;
				}

				const currentTrack = currentResult.value;
				if (currentTrack?.id === undoPayload.trackId) {
					const skipResult = await spotify.skipTrack();
					if (skipResult.status === "error") {
						logger.warn("Failed to skip track during rollback", {
							trackId: undoPayload.trackId,
							error: skipResult.error.message,
						});
					} else {
						logger.info("Skipped track during rollback", { trackId: undoPayload.trackId });
					}
				} else {
					logger.warn("Track queued but not playing, cannot remove from Spotify queue", {
						trackId: undoPayload.trackId,
						currentlyPlaying: currentTrack?.id ?? null,
					});
				}
			},
		);
		if (addToQueueResult.status === "error") {
			return this.handleStepError(addToQueueResult.error, params, runner);
		}

		const fulfillResult = await runner.executeStep(FulfillRedemptionStep, async () => {
			const twitch = new TwitchService(this.env);
			const result = await twitch.updateRedemptionStatus(params.reward.id, params.id, "FULFILLED");
			if (result.status === "error") throw result.error;

			logger.info("Fulfilled redemption", {
				sagaId,
				redemptionId: params.id,
				rewardId: params.reward.id,
			});
			return { result: undefined };
		});
		if (fulfillResult.status === "error") {
			return this.handleStepError(fulfillResult.error, params, runner);
		}

		const pointOfNoReturn = await runner.markPointOfNoReturn();
		if (pointOfNoReturn.status === "error") return Result.err(pointOfNoReturn.error);

		const chatResult = await runner.executeStep(SendChatConfirmationStep, async () => {
			const twitch = new TwitchService(this.env);
			const artistNames = trackInfo.artists.join(", ");
			const message = `@${params.user_name} added "${trackInfo.name}" by ${artistNames} to the queue!`;
			const result = await twitch.sendChatMessage(message);
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
		});
		if (chatResult.status === "error") {
			if (SagaPersistedDataError.is(chatResult.error)) {
				return this.handleStepError(chatResult.error, params, runner);
			}
			logger.warn("Best-effort chat confirmation step did not complete", {
				sagaId,
				error: chatResult.error.message,
			});
		}

		const publishResult = await runner.executeStep(PublishEventStep, async () => {
			const eventBus = getStub("EVENT_BUS_DO");
			const event = createSongRequestSuccessEvent({
				id: crypto.randomUUID(),
				userId: params.user_id,
				userDisplayName: params.user_name,
				sagaId,
				trackId,
			});
			const result = await eventBus.publish(event);
			if (result.status === "error") {
				logger.warn("Failed to publish song_request_success event", {
					sagaId,
					error: result.error.message,
				});
			} else {
				logger.info("Published song_request_success event", { sagaId, eventId: event.id });
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

		const completion = await runner.complete();
		if (completion.status === "error") return Result.err(completion.error);

		logger.info("Song request saga completed successfully", {
			sagaId,
			trackId,
			requester: params.user_name,
		});
		return Result.ok();
	}

	private async handleStepError(
		error: SagaStepExecutionError,
		params: SongRequestParams,
		runner: SagaRunner<SongRequestParams>,
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
				logger.error("One or more Song Request compensations failed", {
					sagaId,
					failedSteps: compensation.error.map((failure) => failure.stepName),
				});
			}
			await this.refundRedemption(params);
			await this.sendFailureMessage(params, error);
		}

		const failed = await runner.fail(error.message);
		return failed.status === "error" ? Result.err(failed.error) : Result.err(error);
	}

	private async refundRedemption(params: SongRequestParams): Promise<void> {
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

	private async sendFailureMessage(
		params: SongRequestParams,
		error: SagaStepExecutionError,
	): Promise<void> {
		const twitch = new TwitchService(this.env);
		const invalidTrackInput =
			SagaStepError.is(error) &&
			(error.stepName === ParseSpotifyUrlStep.name || error.causeTag === "InvalidSpotifyUrlError");
		const message = invalidTrackInput
			? `@${params.user_name} your song request was invalid and your points have been refunded. Did you use a valid Spotify track link?`
			: `@${params.user_name} Spotify song requests are unavailable right now and your points have been refunded.`;
		const result = await twitch.sendChatMessage(message);
		if (result.status === "error") {
			logger.warn("Failed to send failure chat message", {
				sagaId: this.ctx.id.toString(),
				error: result.error.message,
				user: params.user_name,
			});
		} else {
			logger.info("Sent failure chat message", {
				sagaId: this.ctx.id.toString(),
				user: params.user_name,
			});
		}
	}
}

/** Production Song Request Durable Object with inherited serialized saga RPCs. */
export const SongRequestSagaDO = withRpcSerialization(_SongRequestSagaDO);
