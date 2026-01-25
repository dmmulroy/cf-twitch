/**
 * SpotifyService - Handles all Spotify API interactions
 *
 * All methods return Result types for type-safe error handling.
 * Uses Result.tryPromise with built-in retry for resilience.
 */

import { Result } from "better-result";
import { z } from "zod";

import { getStub } from "../lib/durable-objects";
import {
	DurableObjectError,
	SpotifyNetworkError,
	SpotifyNoActiveDeviceError,
	SpotifyParseError,
	SpotifyRateLimitError,
	SpotifyTokenExchangeError,
	SpotifyTrackNotFoundError,
	SpotifyUnauthorizedError,
	type SpotifyApiError,
	type TokenError,
} from "../lib/errors";
import { logger } from "../lib/logger";

import type { Env } from "../index";

// Zod schema for Spotify OAuth token response
const SpotifyTokenResponseSchema = z.object({
	access_token: z.string(),
	token_type: z.string(),
	expires_in: z.number(),
	refresh_token: z.string().optional(),
	scope: z.string().optional(),
});

export type SpotifyTokenResponse = z.infer<typeof SpotifyTokenResponseSchema>;

// Zod schema for Spotify track response
const SpotifyTrackSchema = z.object({
	id: z.string(),
	name: z.string(),
	artists: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
		}),
	),
	album: z.object({
		name: z.string(),
		images: z.array(
			z.object({
				url: z.string(),
				height: z.number(),
				width: z.number(),
			}),
		),
	}),
});

export type SpotifyTrack = z.infer<typeof SpotifyTrackSchema>;

// Zod schema for currently playing response
const CurrentlyPlayingSchema = z.object({
	is_playing: z.boolean(),
	item: SpotifyTrackSchema.nullable(),
});

// Zod schema for queue response
const SpotifyQueueSchema = z.object({
	currently_playing: SpotifyTrackSchema.nullable(),
	queue: z.array(SpotifyTrackSchema),
});

export type SpotifyQueue = z.infer<typeof SpotifyQueueSchema>;

// Zod schema for device response
const SpotifyDeviceSchema = z.object({
	id: z.string(),
	is_active: z.boolean(),
	name: z.string(),
	type: z.string(),
});

const SpotifyDevicesResponseSchema = z.object({
	devices: z.array(SpotifyDeviceSchema),
});

export type SpotifyDevice = z.infer<typeof SpotifyDeviceSchema>;

// Zod schema for client token response (internal API)
const ClientTokenResponseSchema = z.object({
	granted_token: z.object({
		token: z.string(),
		expires_after_seconds: z.number(),
	}),
});

// Zod schema for connect state track (internal API)
const ConnectStateTrackSchema = z.object({
	uri: z.string(),
	uid: z.string(),
	metadata: z.record(z.string(), z.string()),
	provider: z.string(),
});

// Zod schema for connect state player (internal API)
const ConnectStatePlayerSchema = z.object({
	timestamp: z.string(),
	context_uri: z.string(),
	queue_revision: z.string(),
	next_tracks: z.array(ConnectStateTrackSchema),
	prev_tracks: z.array(ConnectStateTrackSchema),
});

const ConnectStateResponseSchema = z.object({
	player_state: ConnectStatePlayerSchema,
});

export type ConnectStateTrack = z.infer<typeof ConnectStateTrackSchema>;
export type ConnectStatePlayer = z.infer<typeof ConnectStatePlayerSchema>;

// Track info for return type
export interface TrackInfo {
	id: string;
	name: string;
	artists: string[];
	album: string;
	albumCoverUrl: string | null;
}

/** Errors that can occur during Spotify operations */
export type SpotifyError = SpotifyApiError | TokenError;

/**
 * SpotifyService - Spotify API operations
 */
export class SpotifyService {
	constructor(public env: Env) {}

	/**
	 * Exchange OAuth authorization code for access/refresh tokens
	 */
	async exchangeToken(
		code: string,
		redirectUri: string,
	): Promise<Result<SpotifyTokenResponse, SpotifyTokenExchangeError | SpotifyParseError>> {
		logger.info("Exchanging Spotify authorization code for tokens");

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://accounts.spotify.com/api/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						Authorization: `Basic ${btoa(`${this.env.SPOTIFY_CLIENT_ID}:${this.env.SPOTIFY_CLIENT_SECRET}`)}`,
					},
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code,
						redirect_uri: redirectUri,
					}),
				}),
			catch: (cause) =>
				new SpotifyTokenExchangeError({
					status: 0,
					message: `Network error: ${String(cause)}`,
				}),
		});

		if (fetchResult.status === "error") {
			logger.error("Spotify token exchange network error", { error: fetchResult.error.message });
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		if (!response.ok) {
			const errorText = await response.text();
			logger.error("Spotify token exchange failed", {
				status: response.status,
				error: errorText,
			});
			return Result.err(
				new SpotifyTokenExchangeError({ status: response.status, message: errorText }),
			);
		}

		// Parse response with Zod
		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) =>
				new SpotifyParseError({ context: "token exchange", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			return Result.err(jsonResult.error);
		}

		const parsed = SpotifyTokenResponseSchema.safeParse(jsonResult.value);

		if (!parsed.success) {
			logger.error("Failed to parse Spotify token response", {
				error: parsed.error.message,
			});
			return Result.err(
				new SpotifyParseError({ context: "token exchange", parseError: parsed.error.message }),
			);
		}

		return Result.ok(parsed.data);
	}

	/**
	 * Get track info by ID
	 */
	async getTrack(
		trackId: string,
	): Promise<
		Result<
			TrackInfo,
			| DurableObjectError
			| SpotifyTrackNotFoundError
			| SpotifyRateLimitError
			| SpotifyUnauthorizedError
			| SpotifyNetworkError
			| SpotifyParseError
			| TokenError
		>
	> {
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const token = tokenResult.value;

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
					headers: {
						Authorization: `Bearer ${token}`,
					},
				}),
			catch: (cause) =>
				new SpotifyNetworkError({ status: 0, context: `getTrack: ${String(cause)}` }),
		});

		if (fetchResult.status === "error") {
			logger.error("Spotify getTrack network error", { trackId, error: fetchResult.error.message });
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		// Handle 404 - track not found
		if (response.status === 404) {
			logger.warn("Spotify track not found", { trackId });
			return Result.err(new SpotifyTrackNotFoundError({ trackId }));
		}

		// Handle 429 - rate limited
		if (response.status === 429) {
			const retryAfter = response.headers.get("Retry-After");
			const retryAfterMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 1000;
			logger.warn("Spotify rate limited", { trackId, retryAfterMs });
			return Result.err(new SpotifyRateLimitError({ retryAfterMs }));
		}

		// Handle 401 - unauthorized
		if (response.status === 401) {
			logger.error("Spotify unauthorized for getTrack", { trackId });
			return Result.err(new SpotifyUnauthorizedError());
		}

		// Handle other errors
		if (!response.ok) {
			logger.error("Spotify getTrack failed", {
				status: response.status,
				trackId,
			});
			return Result.err(new SpotifyNetworkError({ status: response.status, context: "getTrack" }));
		}

		// Parse response with Zod
		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) => new SpotifyParseError({ context: "track", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			logger.error("Failed to parse Spotify track JSON", {
				trackId,
				error: jsonResult.error.message,
			});
			return Result.err(jsonResult.error);
		}

		const parsed = SpotifyTrackSchema.safeParse(jsonResult.value);

		if (!parsed.success) {
			logger.error("Failed to parse Spotify track response", {
				trackId,
				error: parsed.error.message,
			});
			return Result.err(
				new SpotifyParseError({ context: "track", parseError: parsed.error.message }),
			);
		}

		const track = parsed.data;

		// Find the smallest album cover (prefer 64x64 or smallest available)
		const albumCover = track.album.images.sort((a, b) => a.height - b.height)[0];

		return Result.ok({
			id: track.id,
			name: track.name,
			artists: track.artists.map((a) => a.name),
			album: track.album.name,
			albumCoverUrl: albumCover?.url ?? null,
		});
	}

	/**
	 * Add track to Spotify queue (no internal retry - workflow step handles retries)
	 *
	 * IMPORTANT: This operation is NOT idempotent. Each successful call adds the track
	 * again. Retries must be handled at the workflow step level where idempotency is
	 * guaranteed via step ID.
	 */
	async addToQueue(
		trackUri: string,
	): Promise<
		Result<
			void,
			| DurableObjectError
			| SpotifyNoActiveDeviceError
			| SpotifyRateLimitError
			| SpotifyUnauthorizedError
			| SpotifyNetworkError
			| TokenError
		>
	> {
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const token = tokenResult.value;

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch(`https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
					},
				}),
			catch: (cause) =>
				new SpotifyNetworkError({ status: 0, context: `addToQueue: ${String(cause)}` }),
		});

		if (fetchResult.status === "error") {
			logger.error("Spotify addToQueue network error", {
				trackUri,
				error: fetchResult.error.message,
			});
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		// 200 or 204 = success (Spotify docs say 204, but sometimes returns 200)
		if (response.status === 200 || response.status === 204) {
			return Result.ok();
		}

		// Handle 404 - no active device
		if (response.status === 404) {
			logger.warn("Spotify addToQueue: no active device", { trackUri });
			return Result.err(new SpotifyNoActiveDeviceError());
		}

		// Handle 429 - rate limited
		if (response.status === 429) {
			const retryAfter = response.headers.get("Retry-After");
			const retryAfterMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 1000;
			logger.warn("Spotify rate limited", { trackUri, retryAfterMs });
			return Result.err(new SpotifyRateLimitError({ retryAfterMs }));
		}

		// Handle 401 - unauthorized
		if (response.status === 401) {
			logger.error("Spotify unauthorized for addToQueue", { trackUri });
			return Result.err(new SpotifyUnauthorizedError());
		}

		// Other errors
		logger.error("Spotify addToQueue failed", { trackUri, status: response.status });
		return Result.err(new SpotifyNetworkError({ status: response.status, context: "addToQueue" }));
	}

	/**
	 * Get currently playing track
	 */
	async getCurrentlyPlaying(): Promise<
		Result<
			TrackInfo | null,
			| DurableObjectError
			| SpotifyUnauthorizedError
			| SpotifyNetworkError
			| SpotifyParseError
			| TokenError
		>
	> {
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const token = tokenResult.value;

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://api.spotify.com/v1/me/player/currently-playing", {
					headers: {
						Authorization: `Bearer ${token}`,
					},
				}),
			catch: (cause) =>
				new SpotifyNetworkError({ status: 0, context: `getCurrentlyPlaying: ${String(cause)}` }),
		});

		if (fetchResult.status === "error") {
			logger.error("Spotify getCurrentlyPlaying network error", {
				error: fetchResult.error.message,
			});
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		// 204 = nothing playing
		if (response.status === 204) {
			return Result.ok(null);
		}

		// Handle 401 - unauthorized
		if (response.status === 401) {
			logger.error("Spotify unauthorized for getCurrentlyPlaying");
			return Result.err(new SpotifyUnauthorizedError());
		}

		// Handle other errors
		if (!response.ok) {
			logger.error("Spotify getCurrentlyPlaying failed", {
				status: response.status,
			});
			return Result.err(
				new SpotifyNetworkError({ status: response.status, context: "getCurrentlyPlaying" }),
			);
		}

		// Parse response with Zod
		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) =>
				new SpotifyParseError({ context: "currently playing", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			logger.error("Failed to parse Spotify currently playing JSON", {
				error: jsonResult.error.message,
			});
			return Result.err(jsonResult.error);
		}

		const parsed = CurrentlyPlayingSchema.safeParse(jsonResult.value);

		if (!parsed.success) {
			logger.error("Failed to parse currently playing response", {
				error: parsed.error.message,
			});
			return Result.err(
				new SpotifyParseError({ context: "currently playing", parseError: parsed.error.message }),
			);
		}

		// Not playing or no item
		if (!parsed.data.is_playing || !parsed.data.item) {
			return Result.ok(null);
		}

		const track = parsed.data.item;
		const albumCover = track.album.images.sort((a, b) => a.height - b.height)[0];

		return Result.ok({
			id: track.id,
			name: track.name,
			artists: track.artists.map((a) => a.name),
			album: track.album.name,
			albumCoverUrl: albumCover?.url ?? null,
		});
	}

	/**
	 * Get user's queue
	 */
	async getQueue(): Promise<
		Result<
			SpotifyQueue,
			| DurableObjectError
			| SpotifyUnauthorizedError
			| SpotifyNetworkError
			| SpotifyParseError
			| TokenError
		>
	> {
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const token = tokenResult.value;

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://api.spotify.com/v1/me/player/queue", {
					headers: {
						Authorization: `Bearer ${token}`,
					},
				}),
			catch: (cause) =>
				new SpotifyNetworkError({ status: 0, context: `getQueue: ${String(cause)}` }),
		});

		if (fetchResult.status === "error") {
			logger.error("Spotify getQueue network error", { error: fetchResult.error.message });
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		// Handle 401 - unauthorized
		if (response.status === 401) {
			logger.error("Spotify unauthorized for getQueue");
			return Result.err(new SpotifyUnauthorizedError());
		}

		// Handle other errors
		if (!response.ok) {
			logger.error("Spotify getQueue failed", {
				status: response.status,
			});
			return Result.err(new SpotifyNetworkError({ status: response.status, context: "getQueue" }));
		}

		// Parse response with Zod
		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) => new SpotifyParseError({ context: "queue", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			logger.error("Failed to parse Spotify queue JSON", { error: jsonResult.error.message });
			return Result.err(jsonResult.error);
		}

		const parsed = SpotifyQueueSchema.safeParse(jsonResult.value);

		if (!parsed.success) {
			logger.error("Failed to parse Spotify queue response", {
				error: parsed.error.message,
			});
			return Result.err(
				new SpotifyParseError({ context: "queue", parseError: parsed.error.message }),
			);
		}

		return Result.ok(parsed.data);
	}

	/**
	 * Skip to the next track in playback
	 * Used for rollback when a queued track needs to be removed but is now playing
	 */
	async skipTrack(): Promise<
		Result<
			void,
			| DurableObjectError
			| SpotifyNoActiveDeviceError
			| SpotifyUnauthorizedError
			| SpotifyNetworkError
			| TokenError
		>
	> {
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const token = tokenResult.value;

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://api.spotify.com/v1/me/player/next", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
					},
				}),
			catch: (cause) =>
				new SpotifyNetworkError({ status: 0, context: `skipTrack: ${String(cause)}` }),
		});

		if (fetchResult.status === "error") {
			logger.error("Spotify skipTrack network error", { error: fetchResult.error.message });
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		// 204 = success
		if (response.status === 204) {
			return Result.ok();
		}

		// 404 = no active device
		if (response.status === 404) {
			logger.warn("Spotify skipTrack: no active device");
			return Result.err(new SpotifyNoActiveDeviceError());
		}

		// 401 = unauthorized
		if (response.status === 401) {
			logger.error("Spotify unauthorized for skipTrack");
			return Result.err(new SpotifyUnauthorizedError());
		}

		logger.error("Spotify skipTrack failed", { status: response.status });
		return Result.err(new SpotifyNetworkError({ status: response.status, context: "skipTrack" }));
	}

	// =============================================================================
	// Internal Connect State API (undocumented - use at your own risk)
	// These methods use Spotify's internal APIs that are not officially supported.
	// They may break at any time without notice.
	// =============================================================================

	/**
	 * Get active device ID using official API
	 */
	async getActiveDevice(): Promise<
		Result<
			SpotifyDevice | null,
			| DurableObjectError
			| SpotifyUnauthorizedError
			| SpotifyNetworkError
			| SpotifyParseError
			| TokenError
		>
	> {
		return Result.gen(async function* (this: SpotifyService) {
			const token = yield* Result.await(this.getToken());

			const response = yield* Result.await(
				Result.tryPromise({
					try: () =>
						fetch("https://api.spotify.com/v1/me/player/devices", {
							headers: { Authorization: `Bearer ${token}` },
						}),
					catch: (cause) =>
						new SpotifyNetworkError({ status: 0, context: `getActiveDevice: ${String(cause)}` }),
				}),
			);

			if (response.status === 401) {
				logger.error("Spotify unauthorized for getActiveDevice");
				return Result.err(new SpotifyUnauthorizedError());
			}

			if (!response.ok) {
				logger.error("Spotify getActiveDevice failed", { status: response.status });
				return Result.err(
					new SpotifyNetworkError({ status: response.status, context: "getActiveDevice" }),
				);
			}

			const json = yield* Result.await(
				Result.tryPromise({
					try: () => response.json(),
					catch: (cause) =>
						new SpotifyParseError({ context: "devices", parseError: String(cause) }),
				}),
			);

			const parsed = SpotifyDevicesResponseSchema.safeParse(json);
			if (!parsed.success) {
				return Result.err(
					new SpotifyParseError({ context: "devices", parseError: parsed.error.message }),
				);
			}

			const activeDevice = parsed.data.devices.find((d) => d.is_active) ?? null;
			return Result.ok(activeDevice);
		}, this);
	}

	/**
	 * INTERNAL API: Get client token for connect-state API
	 * Uses undocumented Spotify endpoint
	 */
	private async getClientToken(): Promise<Result<string, SpotifyNetworkError | SpotifyParseError>> {
		return Result.gen(async function* (this: SpotifyService) {
			const response = yield* Result.await(
				Result.tryPromise({
					try: () =>
						fetch("https://clienttoken.spotify.com/v1/clienttoken", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								client_data: {
									client_version: "1.2.52.442",
									client_id: this.env.SPOTIFY_CLIENT_ID,
									js_sdk_data: {
										device_brand: "unknown",
										device_model: "desktop",
										os: "Linux",
										os_version: "unknown",
										device_id: crypto.randomUUID(),
										device_type: "computer",
									},
								},
							}),
						}),
					catch: (cause) =>
						new SpotifyNetworkError({ status: 0, context: `getClientToken: ${String(cause)}` }),
				}),
			);

			if (!response.ok) {
				logger.error("Spotify getClientToken failed", { status: response.status });
				return Result.err(
					new SpotifyNetworkError({ status: response.status, context: "getClientToken" }),
				);
			}

			const json = yield* Result.await(
				Result.tryPromise({
					try: () => response.json(),
					catch: (cause) =>
						new SpotifyParseError({ context: "client token", parseError: String(cause) }),
				}),
			);

			const parsed = ClientTokenResponseSchema.safeParse(json);
			if (!parsed.success) {
				logger.error("Failed to parse Spotify client token response", {
					error: parsed.error.message,
				});
				return Result.err(
					new SpotifyParseError({ context: "client token", parseError: parsed.error.message }),
				);
			}

			return Result.ok(parsed.data.granted_token.token);
		}, this);
	}

	/**
	 * INTERNAL API: Get connect state including full queue with metadata
	 * Uses Spotify's internal spclient API
	 */
	async getConnectState(
		deviceId: string,
	): Promise<
		Result<
			ConnectStatePlayer,
			DurableObjectError | SpotifyNetworkError | SpotifyParseError | TokenError
		>
	> {
		return Result.gen(async function* (this: SpotifyService) {
			const token = yield* Result.await(this.getToken());
			const clientToken = yield* Result.await(this.getClientToken());

			const response = yield* Result.await(
				Result.tryPromise({
					try: () =>
						fetch(`https://gue1-spclient.spotify.com/connect-state/v1/devices/hobs_${deviceId}`, {
							method: "PUT",
							headers: {
								Authorization: `Bearer ${token}`,
								"client-token": clientToken,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								member_type: "CONNECT_STATE",
								device: { device_info: { capabilities: { can_be_player: false } } },
							}),
						}),
					catch: (cause) =>
						new SpotifyNetworkError({ status: 0, context: `getConnectState: ${String(cause)}` }),
				}),
			);

			if (!response.ok) {
				logger.error("Spotify getConnectState failed", { status: response.status, deviceId });
				return Result.err(
					new SpotifyNetworkError({ status: response.status, context: "getConnectState" }),
				);
			}

			const json = yield* Result.await(
				Result.tryPromise({
					try: () => response.json(),
					catch: (cause) =>
						new SpotifyParseError({ context: "connect state", parseError: String(cause) }),
				}),
			);

			const parsed = ConnectStateResponseSchema.safeParse(json);
			if (!parsed.success) {
				logger.error("Failed to parse Spotify connect state response", {
					error: parsed.error.message,
				});
				return Result.err(
					new SpotifyParseError({ context: "connect state", parseError: parsed.error.message }),
				);
			}

			return Result.ok(parsed.data.player_state);
		}, this);
	}

	/**
	 * INTERNAL API: Remove a track from the queue by URI
	 * Uses Spotify's internal connect-state set_queue command
	 *
	 * @param trackUri - The Spotify URI of the track to remove (e.g., "spotify:track:xxx")
	 * @returns Result indicating success or failure
	 */
	async removeFromQueue(
		trackUri: string,
	): Promise<
		Result<
			boolean,
			| DurableObjectError
			| SpotifyNoActiveDeviceError
			| SpotifyNetworkError
			| SpotifyParseError
			| SpotifyUnauthorizedError
			| TokenError
		>
	> {
		logger.info("Attempting to remove track from queue via internal API", { trackUri });

		// Step 1: Get active device
		const deviceResult = await this.getActiveDevice();
		if (deviceResult.status === "error") {
			return Result.err(deviceResult.error);
		}

		const device = deviceResult.value;
		if (!device) {
			return Result.err(new SpotifyNoActiveDeviceError());
		}

		// Step 2: Get connect state for full queue
		const stateResult = await this.getConnectState(device.id);
		if (stateResult.status === "error") {
			logger.warn("Failed to get connect state, falling back to skip-if-playing", {
				error: stateResult.error.message,
			});
			return Result.ok(false); // Indicate internal API failed
		}

		const state = stateResult.value;

		// Step 3: Check if track is in queue
		const trackIndex = state.next_tracks.findIndex((t) => t.uri === trackUri);
		if (trackIndex === -1) {
			logger.info("Track not found in queue, may have already been removed or played", {
				trackUri,
			});
			return Result.ok(true);
		}

		// Step 4: Filter out the track
		const newNextTracks = state.next_tracks.filter((t) => t.uri !== trackUri);

		// Step 5: Get tokens
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const token = tokenResult.value;

		const clientTokenResult = await this.getClientToken();
		if (clientTokenResult.status === "error") {
			return Result.err(clientTokenResult.error);
		}
		const clientToken = clientTokenResult.value;

		// Step 6: Send set_queue command
		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch(
					`https://gue1-spclient.spotify.com/connect-state/v1/player/command/from/${device.id}/to/${device.id}`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"client-token": clientToken,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							command: {
								next_tracks: newNextTracks,
								prev_tracks: state.prev_tracks,
								queue_revision: state.queue_revision,
								endpoint: "set_queue",
								logging_params: {
									command_id: crypto.randomUUID().replace(/-/g, ""),
								},
							},
						}),
					},
				),
			catch: (cause) =>
				new SpotifyNetworkError({ status: 0, context: `removeFromQueue: ${String(cause)}` }),
		});

		if (fetchResult.status === "error") {
			logger.error("Spotify removeFromQueue network error", {
				trackUri,
				error: fetchResult.error.message,
			});
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		if (!response.ok) {
			logger.warn("Spotify removeFromQueue set_queue command failed", {
				trackUri,
				status: response.status,
			});
			return Result.ok(false); // Indicate internal API failed, caller should fallback
		}

		logger.info("Successfully removed track from queue via internal API", { trackUri });
		return Result.ok(true);
	}

	/**
	 * Get valid token from SpotifyTokenDO
	 * Type-safe: DurableObjectStub<SpotifyTokenDO> exposes RPC methods directly
	 */
	private async getToken(): Promise<Result<string, TokenError | DurableObjectError>> {
		const stub = getStub("SPOTIFY_TOKEN_DO");
		return stub.getValidToken();
	}
}
