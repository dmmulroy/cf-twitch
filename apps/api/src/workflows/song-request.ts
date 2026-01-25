/**
 * SongRequestWorkflow - Handles song request channel point redemptions
 *
 * Implements saga pattern with rollback support via cf-workflow-rollback.
 * Steps are durable and retry-safe.
 *
 * Flow:
 * 1. Parse Spotify URL → extract track ID (NonRetryableError if invalid)
 * 2. Get track info → fetch from Spotify API (30s timeout)
 * 3. Persist request → SongQueueDO (rollbackable)
 * 4. Add to Spotify queue → with rollback (skip if currently playing)
 * 5. Fulfill redemption → POINT OF NO RETURN
 * 6. Send chat confirmation → non-blocking
 *
 * Rollback strategy:
 * - persist-request: delete from SongQueueDO
 * - add-to-queue: skip track IF it's currently playing (Spotify has no remove-from-queue API)
 *
 * If error before fulfill: refund redemption
 * If error after fulfill: no refund (points already consumed)
 */

import { withRollback } from "cf-workflow-rollback";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { writeSongRequestMetric } from "../lib/analytics";
import { getStub } from "../lib/durable-objects";
import { logger } from "../lib/logger";
import { waitForActivation } from "../lib/warm-workflow";
import { SpotifyService, type TrackInfo } from "../services/spotify-service";
import { TwitchService } from "../services/twitch-service";

import type { Env } from "../index";

/**
 * Params passed from queue consumer (RedemptionEventSchema)
 */
export interface SongRequestParams {
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

/**
 * Parse Spotify URL and extract track ID
 * Supports various Spotify URL formats:
 * - https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh
 * - spotify:track:4iV5W9uYEdYUVa79Axb7Rh
 * - https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh?si=abc123
 */
function parseSpotifyUrl(input: string): string | null {
	const trimmed = input.trim();

	// Spotify URI format: spotify:track:ID
	const uriMatch = trimmed.match(/^spotify:track:([a-zA-Z0-9]+)$/);
	if (uriMatch?.[1]) {
		return uriMatch[1];
	}

	// HTTPS URL format: https://open.spotify.com/track/ID
	// Also handles intl- prefixes like https://open.spotify.com/intl-de/track/ID
	const urlMatch = trimmed.match(
		/^https?:\/\/open\.spotify\.com(?:\/intl-[a-z]{2})?\/track\/([a-zA-Z0-9]+)/,
	);
	if (urlMatch?.[1]) {
		return urlMatch[1];
	}

	return null;
}

/**
 * SongRequestWorkflow - WorkflowEntrypoint for song request redemptions
 *
 * Supports warm pool pattern: instances can be pre-created with undefined payload
 * and wait at step.waitForEvent("activate") until activated with actual params.
 */
export class SongRequestWorkflow extends WorkflowEntrypoint<Env, SongRequestParams | undefined> {
	override async run(
		event: WorkflowEvent<SongRequestParams | undefined>,
		workflowStep: WorkflowStep,
	): Promise<void> {
		// Wait for activation if this is a warm instance (undefined payload)
		// or use initial payload directly for cold starts
		// NOTE: Must use workflowStep (not RollbackContext) for waitForEvent
		const params = await waitForActivation(workflowStep, event.payload);

		const step = withRollback(workflowStep);
		const startTime = Date.now();

		// Track whether redemption was fulfilled (POINT OF NO RETURN)
		let fulfilled = false;
		let trackId: string | undefined;
		let trackName: string | undefined;

		try {
			// Step 1: Parse Spotify URL (validation, no rollback needed)
			trackId = await step.do("parse-spotify-url", async () => {
				const id = parseSpotifyUrl(params.user_input);
				if (!id) {
					throw new NonRetryableError(`Invalid Spotify URL: ${params.user_input}`);
				}
				logger.info("Parsed Spotify URL", { trackId: id, input: params.user_input });
				return id;
			});

			// Step 2: Get track info from Spotify (30s timeout)
			const trackInfo = await step.do(
				"get-track-info",
				{ timeout: "30 seconds", retries: { limit: 3, delay: "1 second", backoff: "exponential" } },
				async () => {
					const spotifyService = new SpotifyService(this.env);
					// trackId is guaranteed to be set after step 1
					const result = await spotifyService.getTrack(trackId as string);

					if (result.status === "error") {
						const err = result.error;
						// NonRetryableError for not-found
						if (err._tag === "SpotifyTrackNotFoundError") {
							throw new NonRetryableError(`Track not found: ${trackId}`);
						}
						throw new Error(err.message);
					}

					logger.info("Got track info", {
						trackId: result.value.id,
						name: result.value.name,
						artists: result.value.artists,
					});

					return result.value;
				},
			);

			// Capture track name for analytics
			trackName = trackInfo.name;

			// Step 3: Persist request in SongQueueDO (rollbackable)
			// Done BEFORE adding to Spotify so we can rollback cleanly if add fails
			await step.doWithRollback(
				"persist-request",
				{
					run: async () => {
						const stub = getStub("SONG_QUEUE_DO");
						const result = await stub.persistRequest({
							eventId: event.instanceId,
							trackId: trackInfo.id,
							trackName: trackInfo.name,
							artists: JSON.stringify(trackInfo.artists),
							album: trackInfo.album,
							albumCoverUrl: trackInfo.albumCoverUrl,
							requesterUserId: params.user_id,
							requesterDisplayName: params.user_name,
							requestedAt: new Date().toISOString(),
						});

						if (result.status === "error") {
							throw new Error(result.error.message);
						}

						logger.info("Persisted song request", { eventId: event.instanceId });
						return event.instanceId;
					},
					undo: async (_err, eventId) => {
						const stub = getStub("SONG_QUEUE_DO");
						const result = await stub.deleteRequest(eventId);
						if (result.status === "error") {
							logger.error("Failed to rollback song request", {
								eventId,
								error: result.error.message,
							});
						} else {
							logger.info("Rolled back song request", { eventId });
						}
					},
				},
				{ timeout: "10 seconds", retries: { limit: 2, delay: "1 second" } },
			);

			// Step 4: Add to Spotify queue (with rollback - skip if currently playing)
			// NOTE: Spotify API has no "remove from queue" endpoint. We can only skip
			// the track if it has already started playing. If it's queued but not
			// playing, it will remain in Spotify's queue on rollback.
			//
			// IDEMPOTENCY: Check if track already in queue before adding to handle
			// step retries after partial success (network failure after Spotify added
			// but before response received).
			await step.doWithRollback(
				"add-to-spotify-queue",
				{
					run: async () => {
						const spotifyService = new SpotifyService(this.env);

						// Check if track is already in queue (idempotency for retries)
						const queueResult = await spotifyService.getQueue();
						if (queueResult.status === "ok") {
							const alreadyQueued = queueResult.value.queue.some((t) => t.id === trackId);
							if (alreadyQueued) {
								logger.info("Track already in Spotify queue, skipping add", { trackId });
								return trackId;
							}
						}
						// If getQueue fails, proceed with add anyway (best effort idempotency)

						const result = await spotifyService.addToQueue(`spotify:track:${trackId}`);

						if (result.status === "error") {
							const err = result.error;
							// No active device is non-retryable
							if (err._tag === "SpotifyNoActiveDeviceError") {
								throw new NonRetryableError("No active Spotify device");
							}
							throw new Error(err.message);
						}

						logger.info("Added track to Spotify queue", { trackId });
						return trackId;
					},
					undo: async (_err, addedTrackId) => {
						// Try to skip if the track is currently playing
						// This is best-effort - if it's queued but not playing, we can't remove it
						const spotifyService = new SpotifyService(this.env);
						const currentResult = await spotifyService.getCurrentlyPlaying();

						if (currentResult.status === "error") {
							logger.warn("Could not check currently playing for rollback", {
								trackId: addedTrackId,
								error: currentResult.error.message,
							});
							return;
						}

						const currentTrack = currentResult.value;
						if (currentTrack && currentTrack.id === addedTrackId) {
							// Track is currently playing - skip it
							const skipResult = await spotifyService.skipTrack();
							if (skipResult.status === "error") {
								logger.warn("Failed to skip track during rollback", {
									trackId: addedTrackId,
									error: skipResult.error.message,
								});
							} else {
								logger.info("Skipped track during rollback", { trackId: addedTrackId });
							}
						} else {
							// Track is queued but not playing - can't remove from Spotify queue
							logger.warn("Track queued but not playing, cannot remove from Spotify queue", {
								trackId: addedTrackId,
								currentlyPlaying: currentTrack?.id ?? null,
							});
						}
					},
				},
				{
					timeout: "30 seconds",
					retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
				},
			);

			// Step 5: Write to request history (track is now in Spotify queue)
			await step.do(
				"write-history",
				{ timeout: "10 seconds", retries: { limit: 2, delay: "1 second" } },
				async () => {
					const stub = getStub("SONG_QUEUE_DO");
					const result = await stub.writeHistory(event.instanceId, new Date().toISOString());

					if (result.status === "error") {
						// Log but don't fail workflow - history is for analytics, not critical path
						logger.warn("Failed to write request history", {
							eventId: event.instanceId,
							error: result.error.message,
						});
					} else {
						logger.info("Wrote request to history", { eventId: event.instanceId });
					}
				},
			);

			// Step 6: Fulfill redemption (POINT OF NO RETURN)
			// After this, no refunds - user points are consumed
			await step.do(
				"fulfill-redemption",
				{ timeout: "30 seconds", retries: { limit: 3, delay: "1 second", backoff: "exponential" } },
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

					fulfilled = true;
					logger.info("Fulfilled redemption", {
						redemptionId: params.id,
						rewardId: params.reward.id,
					});
				},
			);

			// Step 7: Send chat confirmation (non-blocking, best effort)
			await step.do(
				"send-chat-confirmation",
				{ timeout: "10 seconds", retries: { limit: 2, delay: "1 second" } },
				async () => {
					const twitchService = new TwitchService(this.env);
					const artistStr = (trackInfo as TrackInfo).artists.join(", ");
					const message = `@${params.user_name} added "${(trackInfo as TrackInfo).name}" by ${artistStr} to the queue!`;

					const result = await twitchService.sendChatMessage(message);

					if (result.status === "error") {
						// Log but don't fail - chat message is best effort
						logger.warn("Failed to send chat confirmation", {
							error: result.error.message,
							user: params.user_name,
						});
					} else {
						logger.info("Sent chat confirmation", { user: params.user_name });
					}
				},
			);

			logger.info("Song request workflow completed successfully", {
				eventId: event.instanceId,
				trackId,
				requester: params.user_name,
			});

			// Write analytics metric for successful request
			writeSongRequestMetric(this.env.ANALYTICS, {
				requester: params.user_name,
				trackId: trackId ?? "unknown",
				trackName: trackName ?? "unknown",
				status: "fulfilled",
				latencyMs: Date.now() - startTime,
			});
		} catch (error) {
			logger.error("Song request workflow failed", {
				eventId: event.instanceId,
				error: error instanceof Error ? error.message : String(error),
				fulfilled,
			});

			// Write analytics metric for failed request
			writeSongRequestMetric(this.env.ANALYTICS, {
				requester: params.user_name,
				trackId: trackId ?? "unknown",
				trackName: trackName ?? "unknown",
				status: "failed",
				latencyMs: Date.now() - startTime,
			});

			// Rollback any completed steps that registered undo handlers
			await step.rollbackAll(error);

			// Only refund if we haven't fulfilled the redemption yet
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

				// Send chat message explaining the failure
				await step.do(
					"send-failure-chat",
					{ timeout: "10 seconds", retries: { limit: 2, delay: "1 second" } },
					async () => {
						const twitchService = new TwitchService(this.env);
						const message = `@${params.user_name} your song request was invalid and your points have been refunded. Did you use a valid Spotify track link?`;

						const result = await twitchService.sendChatMessage(message);
						if (result.status === "error") {
							logger.warn("Failed to send failure chat message", {
								error: result.error.message,
								user: params.user_name,
							});
						} else {
							logger.info("Sent failure chat message", { user: params.user_name });
						}
					},
				);
			}

			throw error;
		}
	}
}
