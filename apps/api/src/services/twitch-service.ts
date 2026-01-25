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
	TwitchChatSendError,
	TwitchNetworkError,
	TwitchNoSubscriptionReturnedError,
	TwitchParseError,
	TwitchRateLimitError,
	TwitchRedemptionUpdateError,
	TwitchSubscriptionCreateError,
	TwitchSubscriptionDeleteError,
	TwitchTokenExchangeError,
	TwitchUnauthorizedError,
	type TwitchApiError,
	type TokenError,
} from "../lib/errors";
import { logger } from "../lib/logger";

import type { Env } from "../index";

// Zod schema for Twitch OAuth token response
const TwitchTokenResponseSchema = z.object({
	access_token: z.string(),
	refresh_token: z.string(),
	token_type: z.string(),
	expires_in: z.number(),
	scope: z.array(z.string()),
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

// Zod schema for EventSub subscription response
const EventSubSubscriptionResponseSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			status: z.string(),
			type: z.string(),
			version: z.string(),
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
});

export type EventSubSubscriptionType =
	| "stream.online"
	| "stream.offline"
	| "channel.channel_points_custom_reward_redemption.add"
	| "channel.chat.message";

export interface EventSubSubscription {
	id: string;
	status: string;
	type: string;
	version: string;
	condition: Record<string, unknown>;
}

/** Errors that can occur during Twitch operations */
export type TwitchError = TwitchApiError | TokenError;

/**
 * TwitchService - Twitch API operations
 */
export class TwitchService {
	constructor(public env: Env) {}

	/**
	 * Exchange OAuth authorization code for access/refresh tokens
	 */
	async exchangeToken(
		code: string,
		redirectUri: string,
	): Promise<Result<TwitchTokenResponse, TwitchTokenExchangeError | TwitchParseError>> {
		logger.info("Exchanging Twitch authorization code for tokens");

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://id.twitch.tv/oauth2/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						client_id: this.env.TWITCH_CLIENT_ID,
						client_secret: this.env.TWITCH_CLIENT_SECRET,
						grant_type: "authorization_code",
						code,
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
			});
			return Result.err(
				new TwitchParseError({ context: "token exchange", parseError: parsed.error.message }),
			);
		}

		return Result.ok(parsed.data);
	}

	/**
	 * Get stream information for a user
	 * // AI: lets not return null, but instead lets return a StreamOffline Error and let handlers/callers recover/decide how to handle
	 * Returns Ok(null) if the stream is offline
	 */
	async getStreamInfo(userLogin: string) {
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const accessToken = tokenResult.value;

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
			return Result.ok(null);
		}

		const stream = parsed.data.data[0];
		if (!stream) {
			return Result.ok(null);
		}

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
		secret: string,
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
							secret,
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
		});
	}

	/**
	 * Get all EventSub subscriptions
	 * Uses app access token as required by Twitch API
	 */
	async listEventSubSubscriptions() {
		const tokenResult = await this.getAppToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const accessToken = tokenResult.value;

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
					headers: {
						"Client-ID": this.env.TWITCH_CLIENT_ID,
						Authorization: `Bearer ${accessToken}`,
					},
				}),
			catch: (cause) =>
				new TwitchNetworkError({
					status: 0,
					context: `listEventSubSubscriptions: ${String(cause)}`,
				}),
		});

		if (fetchResult.status === "error") {
			logger.error("Twitch listEventSubSubscriptions network error", {
				error: fetchResult.error.message,
			});
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		if (!response.ok) {
			logger.error("Failed to list EventSub subscriptions", {
				status: response.status,
			});
			return Result.err(
				new TwitchNetworkError({
					status: response.status,
					context: "listEventSubSubscriptions",
				}),
			);
		}

		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) =>
				new TwitchParseError({ context: "EventSub list", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			return Result.err(jsonResult.error);
		}

		const parsed = EventSubSubscriptionResponseSchema.safeParse(jsonResult.value);

		if (!parsed.success) {
			logger.error("Failed to parse EventSub subscriptions list", {
				error: parsed.error.message,
			});
			return Result.err(
				new TwitchParseError({ context: "EventSub list", parseError: parsed.error.message }),
			);
		}

		return Result.ok(
			parsed.data.data.map((sub) => ({
				id: sub.id,
				status: sub.status,
				type: sub.type,
				version: sub.version,
				condition: sub.condition,
			})),
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

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${subscriptionId}`, {
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
		return Result.ok(undefined);
	}

	/**
	 * Send a chat message to the broadcaster's channel
	 * Uses Result.tryPromise with automatic retry and rate limit handling
	 */
	async sendChatMessage(message: string) {
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") {
			return Result.err(tokenResult.error);
		}
		const accessToken = tokenResult.value;

		return Result.tryPromise(
			{
				try: async () => {
					const response = await fetch("https://api.twitch.tv/helix/chat/messages", {
						method: "POST",
						headers: {
							"Client-ID": this.env.TWITCH_CLIENT_ID,
							Authorization: `Bearer ${accessToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							broadcaster_id: this.env.TWITCH_BROADCASTER_ID,
							sender_id: this.env.TWITCH_BROADCASTER_ID,
							message,
						}),
					});

					if (response.ok) {
						logger.info("Chat message sent successfully", { message });
						return;
					}

					// Handle 429 rate limit - throw with retry info
					if (response.status === 429) {
						const retryAfter = response.headers.get("Retry-After");
						const retryAfterMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 1000;
						throw new TwitchRateLimitError({ retryAfterMs });
					}

					// 4xx errors (except 429) are not retryable
					if (response.status >= 400 && response.status < 500) {
						const errorBody = await response.text();
						logger.error("Chat message send failed", {
							status: response.status,
							body: errorBody,
							message,
						});
						throw new TwitchChatSendError({
							status: response.status,
							message: `Client error (${response.status}): ${errorBody}`,
						});
					}

					// 5xx errors are retryable
					throw new TwitchNetworkError({ status: response.status, context: "sendChatMessage" });
				},
				catch: (error) => {
					if (
						TwitchChatSendError.is(error) ||
						TwitchRateLimitError.is(error) ||
						TwitchNetworkError.is(error)
					) {
						return error;
					}
					return new TwitchNetworkError({
						status: 0,
						context: `sendChatMessage: ${String(error)}`,
					});
				},
			},
			{ retry: { times: 3, delayMs: 1000, backoff: "exponential" } },
		);
	}

	/**
	 * Update a channel points redemption status
	 * Uses Result.tryPromise with automatic retry and rate limit handling
	 */
	async updateRedemptionStatus(
		rewardId: string,
		redemptionId: string,
		status: "FULFILLED" | "CANCELED",
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
							headers: {
								"Client-ID": this.env.TWITCH_CLIENT_ID,
								Authorization: `Bearer ${accessToken}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({ status }),
						},
					);

					if (response.ok) {
						logger.info("Redemption status updated successfully", {
							rewardId,
							redemptionId,
							status,
						});
						return;
					}

					// Handle 429 rate limit
					if (response.status === 429) {
						const retryAfter = response.headers.get("Retry-After");
						const retryAfterMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 1000;
						throw new TwitchRateLimitError({ retryAfterMs });
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
			{ retry: { times: 3, delayMs: 1000, backoff: "exponential" } },
		);
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
						client_secret: this.env.TWITCH_CLIENT_SECRET,
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
			try: () => response.json() as Promise<{ access_token: string }>,
			catch: (cause) =>
				new TwitchParseError({ context: "client credentials", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			return Result.err(jsonResult.error);
		}

		return Result.ok(jsonResult.value.access_token);
	}
}
