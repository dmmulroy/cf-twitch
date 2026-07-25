/**
 * TwitchService - Handles all Twitch API interactions
 *
 * All methods return Result types for type-safe error handling.
 * Uses Result.tryPromise with built-in retry for resilience.
 */

import { Result } from "better-result";
import { z } from "zod";

import { getStub } from "../lib/durable-objects";
import {
	TwitchChatDroppedError,
	TwitchChatSendError,
	TwitchNetworkError,
	TwitchNoSubscriptionReturnedError,
	TwitchParseError,
	TwitchRateLimitError,
	TwitchRedemptionUpdateError,
	TwitchShoutoutCreateError,
	TwitchSubscriptionCreateError,
	TwitchSubscriptionDeleteError,
	TwitchTokenExchangeError,
	TwitchUnauthorizedError,
	type TwitchApiError,
	type TokenError,
} from "../lib/errors";
import { logger } from "../lib/logger";
import { RedactedValue } from "../lib/redacted";

import type { Env } from "../index";

const DEFAULT_TWITCH_RETRY_AFTER_MS = 1_000;
const MAXIMUM_TWITCH_RETRY_AFTER_MS = 15 * 60 * 1_000;

function parseTwitchRetryAfterMs(response: Response): number {
	const rawSeconds = response.headers.get("Retry-After");
	if (rawSeconds === null) return DEFAULT_TWITCH_RETRY_AFTER_MS;
	const seconds = Number(rawSeconds);
	if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TWITCH_RETRY_AFTER_MS;
	return Math.min(Math.ceil(seconds * 1_000), MAXIMUM_TWITCH_RETRY_AFTER_MS);
}

function isRetryableTwitchTechnicalError(error: unknown): boolean {
	const parsed = z
		.object({ _tag: z.literal("TwitchNetworkError"), status: z.number() })
		.safeParse(error);
	return parsed.success && (parsed.data.status === 0 || parsed.data.status >= 500);
}

const TwitchServiceConfigSchema = z.object({
	TWITCH_CLIENT_ID: z.string().trim().min(1),
	TWITCH_CLIENT_SECRET: z.string().min(1),
	TWITCH_BROADCASTER_ID: z.string().trim().min(1),
});

// Zod schema for Twitch OAuth token response
const NonEmptyProviderStringSchema = z.string().trim().min(1);
const PositiveExpirySecondsSchema = z.number().int().positive().finite();

const TwitchTokenResponseSchema = z.object({
	access_token: NonEmptyProviderStringSchema,
	refresh_token: NonEmptyProviderStringSchema,
	token_type: NonEmptyProviderStringSchema,
	expires_in: PositiveExpirySecondsSchema,
	scope: z.array(NonEmptyProviderStringSchema),
});

const TwitchAppTokenResponseSchema = z.object({
	access_token: NonEmptyProviderStringSchema,
	token_type: NonEmptyProviderStringSchema,
	expires_in: PositiveExpirySecondsSchema,
});

const TwitchChatMessageSchema = z.string().min(1).max(500);
const TwitchChatResponseSchema = z.object({
	data: z
		.array(
			z.object({
				message_id: NonEmptyProviderStringSchema,
				is_sent: z.boolean(),
				drop_reason: z
					.object({
						code: NonEmptyProviderStringSchema,
						message: z.string(),
					})
					.nullable(),
			}),
		)
		.min(1),
});

const TwitchRedemptionUpdateResponseSchema = z.object({
	data: z.array(z.object({ id: NonEmptyProviderStringSchema.optional() })).min(1),
});

export type TwitchTokenResponse = z.infer<typeof TwitchTokenResponseSchema>;

// Zod schema for Twitch Helix /streams response
const TwitchStreamsResponseSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			user_id: z.string(),
			user_login: z.string(),
			user_name: z.string(),
			game_id: z.string(),
			game_name: z.string(),
			type: z.string(),
			title: z.string(),
			viewer_count: z.number(),
			started_at: z.string(), // ISO8601
			language: z.string(),
			thumbnail_url: z.string(),
			tag_ids: z.array(z.string()).optional(),
			tags: z.array(z.string()).optional(),
			is_mature: z.boolean(),
		}),
	),
});

export interface StreamInfo {
	viewerCount: number;
	startedAt: string;
	gameName: string;
	title: string;
}

const EventSubSubscriptionStatusSchema = z.enum([
	"enabled",
	"webhook_callback_verification_pending",
	"webhook_callback_verification_failed",
	"notification_failures_exceeded",
	"authorization_revoked",
	"moderator_removed",
	"user_removed",
	"version_removed",
	"beta_maintenance",
	"websocket_disconnected",
	"websocket_failed_ping_pong",
	"websocket_received_inbound_traffic",
	"websocket_connection_unused",
	"websocket_internal_error",
	"websocket_network_timeout",
	"websocket_network_error",
]);

// Zod schema for EventSub subscription response
const EventSubSubscriptionResponseSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			status: EventSubSubscriptionStatusSchema,
			type: NonEmptyProviderStringSchema,
			version: NonEmptyProviderStringSchema,
			cost: z.number(),
			condition: z.record(z.string(), z.unknown()),
			transport: z.object({
				method: z.string(),
				callback: z.string().optional(),
			}),
			created_at: z.string(),
		}),
	),
	total: z.number(),
	total_cost: z.number(),
	max_total_cost: z.number(),
	pagination: z.object({ cursor: NonEmptyProviderStringSchema.optional() }).default({}),
});

export type EventSubSubscriptionType =
	| "stream.online"
	| "stream.offline"
	| "channel.channel_points_custom_reward_redemption.add"
	| "channel.chat.message"
	| "channel.raid";

/** Parsed Twitch EventSub lifecycle status, including callback verification pending. */
export type EventSubSubscriptionStatus = z.infer<typeof EventSubSubscriptionStatusSchema>;

/** Provider subscription evidence returned after complete EventSub pagination. */
export interface EventSubSubscription {
	id: string;
	status: EventSubSubscriptionStatus;
	type: string;
	version: string;
	condition: Record<string, unknown>;
	transport: {
		method: string;
		callback?: string;
	};
}

/** Errors that can occur during Twitch operations */
export type TwitchError = TwitchApiError | TokenError;

/**
 * TwitchService - Twitch API operations
 */
export class TwitchService {
	private readonly env: Pick<Env, "TWITCH_CLIENT_ID" | "TWITCH_BROADCASTER_ID">;
	private readonly twitchClientSecret: RedactedValue<string>;

	constructor(
		env: Pick<Env, "TWITCH_CLIENT_ID" | "TWITCH_CLIENT_SECRET" | "TWITCH_BROADCASTER_ID">,
	) {
		const parsedConfig = TwitchServiceConfigSchema.safeParse(env);
		if (!parsedConfig.success) {
			throw new Error("Twitch provider configuration is invalid");
		}
		this.env = {
			TWITCH_CLIENT_ID: parsedConfig.data.TWITCH_CLIENT_ID,
			TWITCH_BROADCASTER_ID: parsedConfig.data.TWITCH_BROADCASTER_ID,
		};
		this.twitchClientSecret = RedactedValue.fromSensitiveValue(
			parsedConfig.data.TWITCH_CLIENT_SECRET,
		);
	}

	/**
	 * Exchange OAuth authorization code for access/refresh tokens
	 */
	async exchangeToken(
		code: RedactedValue<string>,
		redirectUri: string,
	): Promise<Result<TwitchTokenResponse, TwitchTokenExchangeError | TwitchParseError>> {
		logger.info("Exchanging Twitch authorization code for tokens", {
			redirect_uri: redirectUri,
			component: "service",
		});

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://id.twitch.tv/oauth2/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						client_id: this.env.TWITCH_CLIENT_ID,
						client_secret: this.twitchClientSecret.unsafeUnwrapForFinalIo(),
						grant_type: "authorization_code",
						code: code.unsafeUnwrapForFinalIo(),
						redirect_uri: redirectUri,
					}),
				}),
			catch: (cause) =>
				new TwitchTokenExchangeError({
					status: 0,
					message: `Network error: ${String(cause)}`,
				}),
		});

		if (fetchResult.status === "error") {
			logger.error("Twitch token exchange network error", { error: fetchResult.error.message });
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		if (!response.ok) {
			const errorText = await response.text();
			logger.error("Twitch token exchange failed", {
				status: response.status,
				error: errorText,
			});
			return Result.err(
				new TwitchTokenExchangeError({ status: response.status, message: errorText }),
			);
		}

		// Parse response with Zod
		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) =>
				new TwitchParseError({ context: "token exchange", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			return Result.err(jsonResult.error);
		}

		const parsed = TwitchTokenResponseSchema.safeParse(jsonResult.value);

		if (!parsed.success) {
			logger.error("Failed to parse Twitch token response", {
				error: parsed.error.message,
				component: "service",
			});
			return Result.err(
				new TwitchParseError({ context: "token exchange", parseError: parsed.error.message }),
			);
		}

		logger.info("Twitch token exchange succeeded", {
			event: "twitch.exchange_token.succeeded",
			component: "service",
			redirect_uri: redirectUri,
			expires_in: parsed.data.expires_in,
			scope_count: parsed.data.scope.length,
		});
		return Result.ok(parsed.data);
	}

	/**
	 * Get stream information for a user
	 * // AI: lets not return null, but instead lets return a StreamOffline Error and let handlers/callers recover/decide how to handle
	 * Returns Ok(null) if the stream is offline
	 */
	async getStreamInfo(userLogin: string) {
		// Use app access token so stream state reconciliation can work even when
		// user tokens are expired while stream lifecycle state is stale/offline.
		const tokenResult = await this.getAppToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const accessToken = tokenResult.value;

		logger.info("Twitch get stream info started", {
			event: "twitch.get_stream_info.started",
			component: "service",
			user_login: userLogin,
		});
		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch(`https://api.twitch.tv/helix/streams?user_login=${userLogin}`, {
					headers: {
						"Client-ID": this.env.TWITCH_CLIENT_ID,
						Authorization: `Bearer ${accessToken}`,
					},
				}),
			catch: (cause) =>
				new TwitchNetworkError({ status: 0, context: `getStreamInfo: ${String(cause)}` }),
		});

		if (fetchResult.status === "error") {
			logger.error("Twitch getStreamInfo network error", {
				userLogin,
				error: fetchResult.error.message,
			});
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		// Handle 401 (token refresh needed)
		if (response.status === 401) {
			logger.error("Twitch unauthorized for getStreamInfo", { userLogin });
			return Result.err(new TwitchUnauthorizedError());
		}

		if (!response.ok) {
			logger.error("Failed to fetch stream info from Twitch", {
				status: response.status,
			});
			return Result.err(
				new TwitchNetworkError({ status: response.status, context: "getStreamInfo" }),
			);
		}

		// Parse response with Zod
		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) => new TwitchParseError({ context: "stream info", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			return Result.err(jsonResult.error);
		}

		const parsed = TwitchStreamsResponseSchema.safeParse(jsonResult.value);

		if (!parsed.success) {
			logger.error("Failed to parse Twitch streams response", {
				error: parsed.error.message,
			});
			return Result.err(
				new TwitchParseError({ context: "stream info", parseError: parsed.error.message }),
			);
		}

		// If data array is empty, stream is offline
		if (parsed.data.data.length === 0) {
			logger.info("Twitch stream is offline", {
				event: "twitch.get_stream_info.offline",
				component: "service",
				user_login: userLogin,
			});
			return Result.ok(null);
		}

		const stream = parsed.data.data[0];
		if (!stream) {
			logger.info("Twitch stream is offline", {
				event: "twitch.get_stream_info.offline",
				component: "service",
				user_login: userLogin,
			});
			return Result.ok(null);
		}

		logger.info("Twitch get stream info succeeded", {
			event: "twitch.get_stream_info.succeeded",
			component: "service",
			user_login: userLogin,
			viewer_count: stream.viewer_count,
			started_at: stream.started_at,
			game_name: stream.game_name,
		});
		return Result.ok({
			viewerCount: stream.viewer_count,
			startedAt: stream.started_at,
			gameName: stream.game_name,
			title: stream.title,
		});
	}

	/**
	 * Create an EventSub subscription
	 * Uses app access token (client credentials) as required by Twitch API
	 */
	async createEventSubSubscription(
		type: EventSubSubscriptionType,
		version: string,
		condition: Record<string, string>,
		callbackUrl: string,
		secret: RedactedValue<string>,
	) {
		// EventSub webhooks require app access token, not user token
		const tokenResult = await this.getAppToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const accessToken = tokenResult.value;

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
					method: "POST",
					headers: {
						"Client-ID": this.env.TWITCH_CLIENT_ID,
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						type,
						version,
						condition,
						transport: {
							method: "webhook",
							callback: callbackUrl,
							secret: secret.unsafeUnwrapForFinalIo(),
						},
					}),
				}),
			catch: (cause) =>
				new TwitchSubscriptionCreateError({
					subscriptionType: type,
					status: 0,
					errorBody: `Network error: ${String(cause)}`,
				}),
		});

		if (fetchResult.status === "error") {
			logger.error("Twitch createEventSubSubscription network error", {
				type,
				error: fetchResult.error.message,
			});
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		if (!response.ok) {
			const errorText = await response.text();
			logger.error("Failed to create EventSub subscription", {
				status: response.status,
				type,
				error: errorText,
			});
			return Result.err(
				new TwitchSubscriptionCreateError({
					subscriptionType: type,
					status: response.status,
					errorBody: errorText,
				}),
			);
		}

		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) =>
				new TwitchParseError({ context: "EventSub subscription", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			return Result.err(jsonResult.error);
		}

		const parsed = EventSubSubscriptionResponseSchema.safeParse(jsonResult.value);

		if (!parsed.success) {
			logger.error("Failed to parse EventSub subscription response", {
				error: parsed.error.message,
			});
			return Result.err(
				new TwitchParseError({
					context: "EventSub subscription",
					parseError: parsed.error.message,
				}),
			);
		}

		const subscription = parsed.data.data[0];
		if (!subscription) {
			logger.error("No subscription returned in response");
			return Result.err(new TwitchNoSubscriptionReturnedError({ subscriptionType: type }));
		}

		logger.info("EventSub subscription created", {
			id: subscription.id,
			type: subscription.type,
			status: subscription.status,
		});

		return Result.ok({
			id: subscription.id,
			status: subscription.status,
			type: subscription.type,
			version: subscription.version,
			condition: subscription.condition,
			transport: subscription.transport,
		});
	}

	/**
	 * Get all EventSub subscriptions
	 * Uses app access token as required by Twitch API
	 */
	async listEventSubSubscriptions(): Promise<
		Result<EventSubSubscription[], TwitchNetworkError | TwitchParseError>
	> {
		const tokenResult = await this.getAppToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const accessToken = tokenResult.value;
		const subscriptions: EventSubSubscription[] = [];
		let cursor: string | undefined;
		const maximumPageCount = 100;

		for (let page = 1; page <= maximumPageCount; page++) {
			const url = new URL("https://api.twitch.tv/helix/eventsub/subscriptions");
			if (cursor !== undefined) url.searchParams.set("after", cursor);

			const fetchResult = await Result.tryPromise({
				try: () =>
					fetch(url, {
						headers: {
							"Client-ID": this.env.TWITCH_CLIENT_ID,
							Authorization: `Bearer ${accessToken}`,
						},
					}),
				catch: (cause) =>
					new TwitchNetworkError({
						status: 0,
						context: `listEventSubSubscriptions page ${page}: ${String(cause)}`,
					}),
			});
			if (fetchResult.status === "error") return Result.err(fetchResult.error);

			const response = fetchResult.value;
			if (!response.ok) {
				return Result.err(
					new TwitchNetworkError({
						status: response.status,
						context: `listEventSubSubscriptions page ${page}`,
					}),
				);
			}

			const jsonResult = await Result.tryPromise({
				try: () => response.json(),
				catch: (cause) =>
					new TwitchParseError({
						context: `EventSub list page ${page}`,
						parseError: String(cause),
					}),
			});
			if (jsonResult.status === "error") return Result.err(jsonResult.error);

			const parsed = EventSubSubscriptionResponseSchema.safeParse(jsonResult.value);
			if (!parsed.success) {
				return Result.err(
					new TwitchParseError({
						context: `EventSub list page ${page}`,
						parseError: parsed.error.message,
					}),
				);
			}

			subscriptions.push(
				...parsed.data.data.map((sub) => ({
					id: sub.id,
					status: sub.status,
					type: sub.type,
					version: sub.version,
					condition: sub.condition,
					transport: sub.transport,
				})),
			);

			cursor = parsed.data.pagination.cursor;
			if (cursor === undefined) return Result.ok(subscriptions);
		}

		return Result.err(
			new TwitchParseError({
				context: "EventSub list pagination",
				parseError: `Exceeded defensive page limit of ${maximumPageCount}`,
			}),
		);
	}

	/**
	 * Delete an EventSub subscription by ID
	 * Uses app access token as required by Twitch API
	 */
	async deleteEventSubSubscription(subscriptionId: string) {
		const tokenResult = await this.getAppToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const accessToken = tokenResult.value;

		const url = new URL("https://api.twitch.tv/helix/eventsub/subscriptions");
		url.searchParams.set("id", subscriptionId);
		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch(url, {
					method: "DELETE",
					headers: {
						"Client-ID": this.env.TWITCH_CLIENT_ID,
						Authorization: `Bearer ${accessToken}`,
					},
				}),
			catch: (cause) =>
				new TwitchNetworkError({
					status: 0,
					context: `deleteEventSubSubscription: ${String(cause)}`,
				}),
		});

		if (fetchResult.status === "error") {
			logger.error("Twitch deleteEventSubSubscription network error", {
				subscriptionId,
				error: fetchResult.error.message,
			});
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		if (!response.ok) {
			logger.error("Failed to delete EventSub subscription", {
				status: response.status,
				subscriptionId,
			});
			return Result.err(
				new TwitchSubscriptionDeleteError({ subscriptionId, status: response.status }),
			);
		}

		logger.info("EventSub subscription deleted", { subscriptionId });
		return Result.ok();
	}

	/**
	 * Send a chat message to the broadcaster's channel
	 * Uses Result.tryPromise with automatic retry and rate limit handling
	 */
	async sendChatMessage(message: string, options: { readonly signal?: AbortSignal } = {}) {
		const parsedMessage = TwitchChatMessageSchema.safeParse(message);
		if (!parsedMessage.success) {
			return Result.err(
				new TwitchChatSendError({
					status: 0,
					message: "Twitch chat message violates the 1 to 500 character limit",
				}),
			);
		}

		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") return Result.err(tokenResult.error);
		const accessToken = tokenResult.value;

		return Result.tryPromise(
			{
				try: async () => {
					const response = await fetch("https://api.twitch.tv/helix/chat/messages", {
						method: "POST",
						signal: options.signal,
						headers: this.userTokenHeaders(accessToken, {
							"Content-Type": "application/json",
						}),
						body: JSON.stringify({
							broadcaster_id: this.env.TWITCH_BROADCASTER_ID,
							sender_id: this.env.TWITCH_BROADCASTER_ID,
							message: parsedMessage.data,
						}),
					});

					if (response.status === 429) {
						throw new TwitchRateLimitError({ retryAfterMs: parseTwitchRetryAfterMs(response) });
					}
					if (!response.ok) {
						if (response.status >= 400 && response.status < 500) {
							logger.error("Twitch chat send rejected", {
								event: "twitch.chat.send.rejected",
								status: response.status,
								message_length: parsedMessage.data.length,
							});
							throw new TwitchChatSendError({ status: response.status });
						}
						throw new TwitchNetworkError({ status: response.status, context: "sendChatMessage" });
					}

					const responseJson = await response.json().catch((cause: unknown) => {
						throw new TwitchParseError({
							context: "chat message delivery JSON",
							parseError: String(cause),
						});
					});
					const parsedResponse = TwitchChatResponseSchema.safeParse(responseJson);
					if (!parsedResponse.success) {
						throw new TwitchParseError({
							context: "chat message delivery",
							parseError: parsedResponse.error.message,
						});
					}
					const delivery = parsedResponse.data.data[0];
					if (delivery === undefined) {
						throw new TwitchParseError({
							context: "chat message delivery",
							parseError: "Response did not contain delivery evidence",
						});
					}
					if (!delivery.is_sent) {
						throw new TwitchChatDroppedError({
							dropCode: delivery.drop_reason?.code ?? "unknown",
						});
					}

					logger.info("Twitch chat message delivered", {
						event: "twitch.chat.send.delivered",
						message_length: parsedMessage.data.length,
					});
				},
				catch: (error) => {
					if (
						TwitchChatDroppedError.is(error) ||
						TwitchChatSendError.is(error) ||
						TwitchParseError.is(error) ||
						TwitchRateLimitError.is(error) ||
						TwitchNetworkError.is(error)
					)
						return error;
					return new TwitchNetworkError({
						status: 0,
						context: `sendChatMessage: ${String(error)}`,
					});
				},
			},
			{
				retry: {
					times: 3,
					delayMs: 1000,
					backoff: "exponential",
					shouldRetry: (error) =>
						options.signal?.aborted !== true && isRetryableTwitchTechnicalError(error),
				},
			},
		);
	}

	/**
	 * Create a native Twitch shoutout from the broadcaster chat context.
	 * Uses Result.tryPromise with automatic retry and rate limit handling.
	 */
	async createShoutout(toBroadcasterId: string, options: { readonly signal?: AbortSignal } = {}) {
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const accessToken = tokenResult.value;

		return Result.tryPromise(
			{
				try: async () => {
					const url = new URL("https://api.twitch.tv/helix/chat/shoutouts");
					url.searchParams.set("from_broadcaster_id", this.env.TWITCH_BROADCASTER_ID);
					url.searchParams.set("to_broadcaster_id", toBroadcasterId);
					url.searchParams.set("moderator_id", this.env.TWITCH_BROADCASTER_ID);

					const response = await fetch(url, {
						method: "POST",
						headers: this.userTokenHeaders(accessToken),
						signal: options.signal,
					});

					if (response.status === 204) return;

					if (response.status === 429) {
						throw new TwitchRateLimitError({ retryAfterMs: parseTwitchRetryAfterMs(response) });
					}

					const errorBody = await response.text();

					if (response.status >= 400 && response.status < 500) {
						throw new TwitchShoutoutCreateError({
							status: response.status,
							toBroadcasterId,
							errorBody,
						});
					}

					throw new TwitchNetworkError({
						status: response.status,
						context: "createShoutout",
					});
				},
				catch: (cause) => {
					if (
						TwitchRateLimitError.is(cause) ||
						TwitchShoutoutCreateError.is(cause) ||
						TwitchNetworkError.is(cause)
					) {
						return cause;
					}

					return new TwitchNetworkError({
						status: 0,
						context: `createShoutout: ${String(cause)}`,
					});
				},
			},
			{
				retry: {
					times: 3,
					delayMs: 1000,
					backoff: "exponential",
					shouldRetry: (error) =>
						options.signal?.aborted !== true && isRetryableTwitchTechnicalError(error),
				},
			},
		);
	}

	async updateRedemptionStatus(
		rewardId: string,
		redemptionId: string,
		status: "FULFILLED" | "CANCELED",
		options: { readonly signal?: AbortSignal } = {},
	) {
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const accessToken = tokenResult.value;

		return Result.tryPromise(
			{
				try: async () => {
					const response = await fetch(
						`https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${this.env.TWITCH_BROADCASTER_ID}&reward_id=${rewardId}&id=${redemptionId}`,
						{
							method: "PATCH",
							signal: options.signal,
							headers: this.userTokenHeaders(accessToken, {
								"Content-Type": "application/json",
							}),
							body: JSON.stringify({ status }),
						},
					);

					if (response.ok) {
						const responseJson = await response.json().catch((cause: unknown) => {
							throw new TwitchParseError({
								context: "redemption status update JSON",
								parseError: String(cause),
							});
						});
						const parsedResponse = TwitchRedemptionUpdateResponseSchema.safeParse(responseJson);
						if (!parsedResponse.success) {
							throw new TwitchParseError({
								context: "redemption status update",
								parseError: parsedResponse.error.message,
							});
						}
						logger.info("Redemption status updated successfully", {
							rewardId,
							redemptionId,
							status,
						});
						return;
					}

					if (response.status === 429) {
						throw new TwitchRateLimitError({ retryAfterMs: parseTwitchRetryAfterMs(response) });
					}

					// 4xx errors (except 429) are not retryable
					if (response.status >= 400 && response.status < 500) {
						throw new TwitchRedemptionUpdateError({
							rewardId,
							redemptionId,
							status: response.status,
						});
					}

					// 5xx errors are retryable
					throw new TwitchNetworkError({
						status: response.status,
						context: "updateRedemptionStatus",
					});
				},
				catch: (error) => {
					if (
						TwitchRedemptionUpdateError.is(error) ||
						TwitchParseError.is(error) ||
						TwitchRateLimitError.is(error) ||
						TwitchNetworkError.is(error)
					) {
						return error;
					}
					return new TwitchNetworkError({
						status: 0,
						context: `updateRedemptionStatus: ${String(error)}`,
					});
				},
			},
			{
				retry: {
					times: 3,
					delayMs: 1000,
					backoff: "exponential",
					shouldRetry: (error) =>
						options.signal?.aborted !== true && isRetryableTwitchTechnicalError(error),
				},
			},
		);
	}

	/**
	 * Build shared auth headers for Twitch Helix endpoints that use the broadcaster user token.
	 * Chat messages, native shoutouts, and redemption updates all require this same auth context.
	 */
	private userTokenHeaders(accessToken: string, headers?: HeadersInit): Headers {
		const result = new Headers(headers);
		result.set("Client-ID", this.env.TWITCH_CLIENT_ID);
		result.set("Authorization", `Bearer ${accessToken}`);
		return result;
	}

	/**
	 * Get valid token from TwitchTokenDO
	 * Type-safe: DurableObjectStub<TwitchTokenDO> exposes RPC methods directly
	 */
	private async getToken() {
		const stub = getStub("TWITCH_TOKEN_DO");
		return stub.getValidToken();
	}

	/**
	 * Get app access token via client credentials flow.
	 * Required for EventSub webhook subscriptions.
	 */
	private async getAppToken(): Promise<Result<string, TwitchNetworkError | TwitchParseError>> {
		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://id.twitch.tv/oauth2/token", {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: this.env.TWITCH_CLIENT_ID,
						client_secret: this.twitchClientSecret.unsafeUnwrapForFinalIo(),
						grant_type: "client_credentials",
					}),
				}),
			catch: (cause) =>
				new TwitchNetworkError({ status: 0, context: `client credentials: ${String(cause)}` }),
		});

		if (fetchResult.status === "error") {
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;
		if (!response.ok) {
			return Result.err(
				new TwitchNetworkError({ status: response.status, context: "client credentials" }),
			);
		}

		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) =>
				new TwitchParseError({ context: "client credentials JSON", parseError: String(cause) }),
		});
		if (jsonResult.status === "error") return Result.err(jsonResult.error);

		const parsed = TwitchAppTokenResponseSchema.safeParse(jsonResult.value);
		if (!parsed.success) {
			return Result.err(
				new TwitchParseError({
					context: "client credentials",
					parseError: parsed.error.message,
				}),
			);
		}

		return Result.ok(parsed.data.access_token);
	}
}
