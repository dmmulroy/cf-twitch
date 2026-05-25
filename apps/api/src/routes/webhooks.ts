/**
 * Twitch EventSub Webhook Handler
 *
 * Receives and verifies EventSub webhook events from Twitch.
 * Handles challenge verification, signature validation, and event routing.
 */

import { Result } from "better-result";
import { Hono } from "hono";
import { z } from "zod";

import {
	parseKnownRewardRedemption,
	type RewardRoutingConfig,
} from "../lib/channel-point-redemptions";
import { makeChatCommandExecutor } from "../lib/chat-command";
import { getStub } from "../lib/durable-objects";
import { RewardRoutingConfigError, UnknownRewardError } from "../lib/errors";
import { normalizeError, withLogContext } from "../lib/logger";
import { getUserPermission } from "../lib/permissions";
import { type AppRouteEnv, getRequestLogger } from "../lib/request-context";

import type { Env } from "../index";

const webhooks = new Hono<AppRouteEnv<Env>>();

// Zod schemas for EventSub webhook payloads
const EventSubHeadersSchema = z.object({
	"twitch-eventsub-message-id": z.string(),
	"twitch-eventsub-message-retry": z.string(),
	"twitch-eventsub-message-type": z.string(),
	"twitch-eventsub-message-signature": z.string(),
	"twitch-eventsub-message-timestamp": z.string(),
	"twitch-eventsub-subscription-type": z.string(),
	"twitch-eventsub-subscription-version": z.string(),
});

const EventSubChallengeSchema = z.object({
	subscription: z.object({
		id: z.string(),
		type: z.string(),
		version: z.string(),
		status: z.string(),
		cost: z.number(),
		condition: z.record(z.string(), z.unknown()),
		transport: z.object({
			method: z.string(),
			callback: z.string(),
		}),
		created_at: z.string(),
	}),
	challenge: z.string(),
});

// Redemption event schema for channel point rewards
const RedemptionEventSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	user_login: z.string(),
	user_name: z.string(),
	broadcaster_user_id: z.string(),
	broadcaster_user_login: z.string(),
	broadcaster_user_name: z.string(),
	reward: z.object({
		id: z.string(),
		title: z.string(),
		cost: z.number(),
		prompt: z.string(),
	}),
	user_input: z.string(),
	status: z.string(),
	redeemed_at: z.string(),
});

// Chat badge schema (Twitch EventSub format)
const ChatBadgeSchema = z.object({
	set_id: z.string(),
	id: z.string(),
	info: z.string(),
});

// Chat message event schema
const ChatMessageEventSchema = z.object({
	broadcaster_user_id: z.string(),
	broadcaster_user_login: z.string(),
	broadcaster_user_name: z.string(),
	chatter_user_id: z.string(),
	chatter_user_login: z.string(),
	chatter_user_name: z.string(),
	message_id: z.string(),
	message: z.object({
		text: z.string(),
		fragments: z.array(z.unknown()),
	}),
	badges: z.array(ChatBadgeSchema),
});

const RaidEventSchema = z.object({
	from_broadcaster_user_id: z.string(),
	from_broadcaster_user_login: z.string(),
	from_broadcaster_user_name: z.string(),
	to_broadcaster_user_id: z.string(),
	to_broadcaster_user_login: z.string(),
	to_broadcaster_user_name: z.string(),
	viewers: z.number(),
});

const EventSubNotificationSchema = z.object({
	subscription: z.object({
		id: z.string(),
		type: z.string(),
		version: z.string(),
		status: z.string(),
		cost: z.number(),
		condition: z.record(z.string(), z.unknown()),
		transport: z.object({
			method: z.string(),
			callback: z.string().optional(),
		}),
		created_at: z.string(),
	}),
	event: z.record(z.string(), z.unknown()),
});

/**
 * Verify the HMAC-SHA256 signature of the webhook request
 */
async function verifySignature(
	secret: string,
	messageId: string,
	timestamp: string,
	body: string,
	signature: string,
): Promise<boolean> {
	// Construct the message to verify
	const message = messageId + timestamp + body;

	// Import the secret key
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	// Sign the message
	const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

	// Convert to hex string
	const hexSignature = Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	// Compare signatures (signature from header is in format "sha256=...")
	const expectedSignature = `sha256=${hexSignature}`;

	return expectedSignature === signature;
}

/**
 * Check if the timestamp is within 10 minutes
 */
function isTimestampValid(timestamp: string): boolean {
	const messageTime = new Date(timestamp).getTime();
	const now = Date.now();
	const tenMinutes = 10 * 60 * 1000;

	return Math.abs(now - messageTime) < tenMinutes;
}

/**
 * POST /webhooks/twitch
 *
 * Receives EventSub webhook events from Twitch.
 * Handles:
 * - Challenge verification (webhook_callback_verification)
 * - Event notifications (notification)
 * - Revocation notifications (revocation)
 */
// AI: create hono middleware for handling the header validation
webhooks.post("/twitch", async (c) => {
	const routeLogger = getRequestLogger(c).child({ route: "/webhooks/twitch", component: "route" });
	const headers = c.req.header();
	const headersParsed = EventSubHeadersSchema.safeParse(headers);
	if (!headersParsed.success) {
		routeLogger.error("Invalid EventSub headers", {
			event: "webhook.twitch.headers_invalid",
			error: headersParsed.error,
		});
		return c.json({ error: "Invalid headers" }, 400);
	}

	const {
		"twitch-eventsub-message-id": messageId,
		"twitch-eventsub-message-retry": retryCount,
		"twitch-eventsub-message-type": messageType,
		"twitch-eventsub-message-signature": signature,
		"twitch-eventsub-message-timestamp": timestamp,
		"twitch-eventsub-subscription-type": subscriptionType,
	} = headersParsed.data;

	return withLogContext(
		{
			trace_id: messageId,
			message_id: messageId,
			subscription_type: subscriptionType,
		},
		async () => {
			const webhookLogger = routeLogger.child({
				trace_id: messageId,
				message_id: messageId,
				subscription_type: subscriptionType,
			});
			const rawBody = await c.req.text();
			webhookLogger.info("Twitch webhook received", {
				event: "webhook.twitch.received",
				message_id: messageId,
				message_type: messageType,
				subscription_type: subscriptionType,
				retry_count: Number(retryCount),
				timestamp,
				body_size_bytes: rawBody.length,
			});

			if (!isTimestampValid(timestamp)) {
				webhookLogger.warn("EventSub message timestamp too old", {
					event: "webhook.twitch.timestamp_invalid",
					message_id: messageId,
					timestamp,
				});
				return c.json({ error: "Message too old" }, 403);
			}

			const isValid = await verifySignature(
				c.env.TWITCH_EVENTSUB_SECRET,
				messageId,
				timestamp,
				rawBody,
				signature,
			);

			if (!isValid) {
				webhookLogger.warn("EventSub signature verification failed", {
					event: "webhook.twitch.signature_invalid",
					message_id: messageId,
					subscription_type: subscriptionType,
				});
				return c.json({ error: "Invalid signature" }, 403);
			}

			const bodyResult = Result.try({
				try: () => JSON.parse(rawBody) as unknown,
				catch: (e) => new Error(`Invalid JSON: ${String(e)}`),
			});

			if (bodyResult.status === "error") {
				webhookLogger.error("Failed to parse webhook body", {
					event: "webhook.twitch.body_parse_failed",
					message_id: messageId,
					body_size_bytes: rawBody.length,
					...normalizeError(bodyResult.error),
				});
				return c.json({ error: "Invalid JSON body" }, 400);
			}

			const body = bodyResult.value;

			if (messageType === "webhook_callback_verification") {
				const parsed = EventSubChallengeSchema.safeParse(body);
				if (!parsed.success) {
					webhookLogger.error("Invalid challenge payload", {
						event: "webhook.twitch.body_parse_failed",
						message_id: messageId,
						error: parsed.error,
					});
					return c.json({ error: "Invalid payload" }, 400);
				}

				webhookLogger.info("EventSub challenge received", {
					event: "webhook.twitch.challenge.received",
					subscription_id: parsed.data.subscription.id,
					subscription_type: parsed.data.subscription.type,
				});
				webhookLogger.info("Responding to EventSub challenge", {
					event: "webhook.twitch.challenge.responded",
					subscription_id: parsed.data.subscription.id,
					subscription_type: parsed.data.subscription.type,
				});
				return c.text(parsed.data.challenge, 200);
			}

			if (messageType === "revocation") {
				webhookLogger.warn("EventSub subscription revoked", {
					event: "webhook.twitch.revocation.received",
					message_id: messageId,
					subscription_type: subscriptionType,
				});
				return c.json({ success: true }, 200);
			}

			if (messageType === "notification") {
				const parsed = EventSubNotificationSchema.safeParse(body);
				if (!parsed.success) {
					webhookLogger.error("Invalid notification payload", {
						event: "webhook.twitch.body_parse_failed",
						message_id: messageId,
						error: parsed.error,
					});
					return c.json({ error: "Invalid payload" }, 400);
				}

				const { subscription, event } = parsed.data;
				webhookLogger.info("EventSub notification received", {
					event: "webhook.twitch.notification.received",
					message_id: messageId,
					subscription_id: subscription.id,
					subscription_type: subscription.type,
					event_timestamp:
						typeof event["redeemed_at"] === "string"
							? event["redeemed_at"]
							: typeof event["started_at"] === "string"
								? event["started_at"]
								: timestamp,
				});

				try {
					switch (subscription.type) {
						case "stream.online": {
							webhookLogger.info("Routing stream online event", {
								event: "webhook.twitch.stream_online.routed",
								message_id: messageId,
								event_timestamp: timestamp,
							});
							const stub = getStub("STREAM_LIFECYCLE_DO");
							const result = await stub.onStreamOnline(timestamp);
							if (result.status === "error") {
								webhookLogger.error("Stream online event failed", {
									event: "webhook.twitch.stream_online.failed",
									message_id: messageId,
									event_timestamp: timestamp,
									...result.error,
								});
							} else {
								webhookLogger.info("Stream online event processed", {
									event: "webhook.twitch.stream_online.processed",
									message_id: messageId,
									event_timestamp: timestamp,
								});
							}
							break;
						}

						case "stream.offline": {
							webhookLogger.info("Routing stream offline event", {
								event: "webhook.twitch.stream_offline.routed",
								message_id: messageId,
								event_timestamp: timestamp,
							});
							const stub = getStub("STREAM_LIFECYCLE_DO");
							const result = await stub.onStreamOffline(timestamp);
							if (result.status === "error") {
								webhookLogger.error("Stream offline event failed", {
									event: "webhook.twitch.stream_offline.failed",
									message_id: messageId,
									event_timestamp: timestamp,
									...result.error,
								});
							} else {
								webhookLogger.info("Stream offline event processed", {
									event: "webhook.twitch.stream_offline.processed",
									message_id: messageId,
									event_timestamp: timestamp,
								});
							}
							break;
						}

						case "channel.channel_points_custom_reward_redemption.add": {
							const redemptionResult = RedemptionEventSchema.safeParse(event);
							if (!redemptionResult.success) {
								webhookLogger.error("Invalid redemption event payload", {
									event: "webhook.twitch.redemption.payload_invalid",
									message_id: messageId,
									error: redemptionResult.error,
								});
								break;
							}
							const redemption = redemptionResult.data;
							const rewardId = redemption.reward.id;
							webhookLogger.info("Redemption received", {
								event: "webhook.twitch.redemption.received",
								redemption_id: redemption.id,
								reward_id: rewardId,
								reward_title: redemption.reward.title,
								user_id: redemption.user_id,
								user_display_name: redemption.user_name,
								input_length: redemption.user_input.length,
							});

							const routingConfig: RewardRoutingConfig = {
								songRequestRewardId: c.env.SONG_REQUEST_REWARD_ID,
								keyboardRaffleRewardId: c.env.KEYBOARD_RAFFLE_REWARD_ID,
							};
							const knownRedemptionResult = parseKnownRewardRedemption(redemption, routingConfig);

							if (knownRedemptionResult.status === "error") {
								if (UnknownRewardError.is(knownRedemptionResult.error)) {
									webhookLogger.warn("Unknown reward ID, skipping redemption", {
										event: "webhook.twitch.redemption.unknown_reward",
										redemption_id: redemption.id,
										reward_id: rewardId,
										reward_title: redemption.reward.title,
										user_id: redemption.user_id,
										user_display_name: redemption.user_name,
									});
								} else if (RewardRoutingConfigError.is(knownRedemptionResult.error)) {
									webhookLogger.error("Reward routing config invalid", {
										event: "webhook.twitch.redemption.routing_config_invalid",
										redemption_id: redemption.id,
										reward_id: rewardId,
										config_key: knownRedemptionResult.error.configKey,
										error_message: knownRedemptionResult.error.message,
									});
								}
								break;
							}

							const knownRedemption = knownRedemptionResult.value;
							switch (knownRedemption._tag) {
								case "SongRequestRedemption": {
									webhookLogger.info("Song request route selected", {
										event: "webhook.twitch.redemption.route_selected",
										redemption_id: redemption.id,
										reward_id: rewardId,
										saga_id: redemption.id,
										outcome: "song_request",
									});
									const stub = getStub("SONG_REQUEST_SAGA_DO", redemption.id);
									const result = await stub.start(knownRedemption);
									if (result.status === "error") {
										webhookLogger.error("Song request saga failed to start", {
											event: "webhook.twitch.redemption.song_request_saga_failed",
											redemption_id: redemption.id,
											reward_id: rewardId,
											saga_id: redemption.id,
											...result.error,
										});
									} else {
										webhookLogger.info("Song request saga started", {
											event: "webhook.twitch.redemption.song_request_saga_started",
											redemption_id: redemption.id,
											reward_id: rewardId,
											saga_id: redemption.id,
											user_id: redemption.user_id,
											user_display_name: redemption.user_name,
										});
									}
									break;
								}

								case "KeyboardRaffleRedemption": {
									webhookLogger.info("Keyboard raffle route selected", {
										event: "webhook.twitch.redemption.route_selected",
										redemption_id: redemption.id,
										reward_id: rewardId,
										saga_id: redemption.id,
										outcome: "keyboard_raffle",
									});
									const stub = getStub("KEYBOARD_RAFFLE_SAGA_DO", redemption.id);
									const result = await stub.start(knownRedemption);
									if (result.status === "error") {
										webhookLogger.error("Keyboard raffle saga failed to start", {
											event: "webhook.twitch.redemption.keyboard_raffle_saga_failed",
											redemption_id: redemption.id,
											reward_id: rewardId,
											saga_id: redemption.id,
											...result.error,
										});
									} else {
										webhookLogger.info("Keyboard raffle saga started", {
											event: "webhook.twitch.redemption.keyboard_raffle_saga_started",
											redemption_id: redemption.id,
											reward_id: rewardId,
											saga_id: redemption.id,
											user_id: redemption.user_id,
											user_display_name: redemption.user_name,
										});
									}
									break;
								}
							}
							break;
						}

						case "channel.raid": {
							const raidResult = RaidEventSchema.safeParse(event);
							if (!raidResult.success) {
								webhookLogger.error("Invalid raid event payload", {
									event: "webhook.twitch.raid.payload_invalid",
									message_id: messageId,
									error: raidResult.error,
								});
								break;
							}

							const raid = raidResult.data;
							webhookLogger.info("Raid received", {
								event: "webhook.twitch.raid.received",
								message_id: messageId,
								from_broadcaster_user_id: raid.from_broadcaster_user_id,
								from_broadcaster_user_login: raid.from_broadcaster_user_login,
								from_broadcaster_user_name: raid.from_broadcaster_user_name,
								viewers: raid.viewers,
							});

							const stub = getStub("RAID_SHOUTOUT_SAGA_DO", messageId);
							const result = await stub.start({
								messageId,
								receivedAt: timestamp,
								raider: {
									userId: raid.from_broadcaster_user_id,
									login: raid.from_broadcaster_user_login,
									displayName: raid.from_broadcaster_user_name,
								},
								viewers: raid.viewers,
							});

							if (result.status === "error") {
								webhookLogger.error("Raid shoutout saga failed", {
									event: "webhook.twitch.raid.shoutout_saga_failed",
									message_id: messageId,
									error_tag: result.error._tag,
									error_message: result.error.message,
								});
							}

							break;
						}

						case "channel.chat.message": {
							const chatResult = ChatMessageEventSchema.safeParse(event);
							if (!chatResult.success) {
								webhookLogger.error("Invalid chat message event payload", {
									event: "webhook.twitch.chat_message.payload_invalid",
									message_id: messageId,
									error: chatResult.error,
								});
								break;
							}

							const chatMessage = chatResult.data;
							const userPermission = getUserPermission(chatMessage.badges);
							webhookLogger.info("Chat message received", {
								event: "webhook.twitch.chat_message.received",
								message_id: chatMessage.message_id,
								chatter_user_id: chatMessage.chatter_user_id,
								chatter_user_name: chatMessage.chatter_user_name,
								badges_count: chatMessage.badges.length,
								message_length: chatMessage.message.text.length,
								user_permission: userPermission,
							});

							const executor = makeChatCommandExecutor(c.env);
							const result = await executor.execute({
								messageId: chatMessage.message_id,
								text: chatMessage.message.text.trim().toLowerCase(),
								receivedAt: timestamp,
								viewer: {
									userId: chatMessage.chatter_user_id,
									displayName: chatMessage.chatter_user_name,
									permission: userPermission,
								},
							});

							if (result.status === "error") {
								webhookLogger.warn("Chat Command execution failed", {
									event: "webhook.twitch.chat_message.command_failed",
									message_id: chatMessage.message_id,
									error_tag: result.error._tag,
									error_message: result.error.message,
								});
							}
							break;
						}

						default: {
							webhookLogger.warn("Unhandled EventSub subscription type", {
								event: "webhook.twitch.notification.received",
								outcome: "unhandled_subscription_type",
								subscription_type: subscription.type,
							});
						}
					}
				} catch (error) {
					webhookLogger.error("Error processing EventSub notification", {
						event: "webhook.twitch.body_parse_failed",
						subscription_type: subscription.type,
						...normalizeError(error),
					});
				}

				return c.json({ success: true }, 200);
			}

			webhookLogger.warn("Unknown EventSub message type", {
				event: "webhook.twitch.headers_invalid",
				message_type: messageType,
				message_id: messageId,
			});
			return c.json({ error: "Unknown message type" }, 400);
		},
	);
});

/**
 * Hono router for external webhook endpoints.
 *
 * @returns A configured webhook router used by the worker application.
 */
export default webhooks;
