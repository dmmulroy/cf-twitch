/**
 * Twitch EventSub Webhook Handler
 *
 * Receives and verifies EventSub webhook events from Twitch.
 * Handles challenge verification, signature validation, and event routing.
 */

import { Result } from "better-result";
import { Hono } from "hono";
import { z } from "zod";

import { getStub } from "../lib/durable-objects";
import { logger } from "../lib/logger";
import { triggerWarmWorkflow } from "../lib/warm-workflow";

import type { Env } from "../index";

/**
 * Sanitize event ID for use as workflow instance ID.
 * Workflow IDs can only contain alphanumeric, hyphens, underscores.
 */
function sanitizeWorkflowId(eventId: string): string {
	return eventId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const webhooks = new Hono<{ Bindings: Env }>();

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
	const headers = c.req.header();

	// Parse and validate EventSub headers
	const headersParsed = EventSubHeadersSchema.safeParse(headers);
	if (!headersParsed.success) {
		logger.error("Invalid EventSub headers", {
			error: headersParsed.error.message,
		});
		return c.json({ error: "Invalid headers" }, 400);
	}

	const {
		"twitch-eventsub-message-id": messageId,
		"twitch-eventsub-message-type": messageType,
		"twitch-eventsub-message-signature": signature,
		"twitch-eventsub-message-timestamp": timestamp,
		"twitch-eventsub-subscription-type": subscriptionType,
	} = headersParsed.data;

	// Verify timestamp (reject messages older than 10 minutes)
	if (!isTimestampValid(timestamp)) {
		logger.error("EventSub message timestamp too old", {
			timestamp,
			messageId,
		});
		return c.json({ error: "Message too old" }, 403);
	}

	// Get raw body for signature verification
	const rawBody = await c.req.text();

	// Verify signature
	const isValid = await verifySignature(
		c.env.TWITCH_EVENTSUB_SECRET,
		messageId,
		timestamp,
		rawBody,
		signature,
	);

	if (!isValid) {
		logger.error("EventSub signature verification failed", {
			messageId,
			subscriptionType,
		});
		return c.json({ error: "Invalid signature" }, 403);
	}

	// Parse body
	const bodyResult = Result.try({
		try: () => JSON.parse(rawBody) as unknown,
		catch: (e) => new Error(`Invalid JSON: ${String(e)}`),
	});

	if (bodyResult.status === "error") {
		logger.error("Failed to parse webhook body", { error: bodyResult.error.message });
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const body = bodyResult.value;

	// Handle challenge verification
	if (messageType === "webhook_callback_verification") {
		const parsed = EventSubChallengeSchema.safeParse(body);
		if (!parsed.success) {
			logger.error("Invalid challenge payload", {
				error: parsed.error.message,
			});
			return c.json({ error: "Invalid payload" }, 400);
		}

		logger.info("EventSub challenge received", {
			subscriptionId: parsed.data.subscription.id,
			type: parsed.data.subscription.type,
		});

		// Return the challenge
		return c.text(parsed.data.challenge, 200);
	}

	// Handle revocation
	if (messageType === "revocation") {
		logger.warn("EventSub subscription revoked", {
			subscriptionType,
			messageId,
		});
		return c.json({ success: true }, 200);
	}

	// Handle notification
	if (messageType === "notification") {
		const parsed = EventSubNotificationSchema.safeParse(body);
		if (!parsed.success) {
			logger.error("Invalid notification payload", {
				error: parsed.error.message,
			});
			return c.json({ error: "Invalid payload" }, 400);
		}

		const { subscription, event } = parsed.data;

		logger.info("EventSub notification received", {
			type: subscription.type,
			subscriptionId: subscription.id,
		});

		// Route events based on subscription type
		// AI: create smaller handler functions for handling each subscription type
		try {
			switch (subscription.type) {
				case "stream.online": {
					// Signal StreamLifecycleDO via RPC
					const stub = getStub("STREAM_LIFECYCLE_DO");
					await stub.onStreamOnline();
					logger.info("Stream online event processed");
					break;
				}

				case "stream.offline": {
					// Signal StreamLifecycleDO via RPC
					const stub = getStub("STREAM_LIFECYCLE_DO");
					await stub.onStreamOffline();
					logger.info("Stream offline event processed");
					break;
				}

				case "channel.channel_points_custom_reward_redemption.add": {
					// Parse and validate redemption event
					const redemptionResult = RedemptionEventSchema.safeParse(event);
					if (!redemptionResult.success) {
						logger.error("Invalid redemption event payload", {
							error: redemptionResult.error.message,
							messageId,
						});
						break;
					}
					const redemption = redemptionResult.data;

					// Trigger workflow via warm pool (falls back to cold start)
					const rewardId = redemption.reward.id;
					const workflowId = sanitizeWorkflowId(messageId);

					if (c.env.SONG_REQUEST_REWARD_ID && rewardId === c.env.SONG_REQUEST_REWARD_ID) {
						await triggerWarmWorkflow({
							workflow: c.env.SONG_REQUEST_WF,
							workflowType: "song-request",
							instanceId: workflowId,
							params: redemption,
						});
					} else if (
						c.env.KEYBOARD_RAFFLE_REWARD_ID &&
						rewardId === c.env.KEYBOARD_RAFFLE_REWARD_ID
					) {
						await triggerWarmWorkflow({
							workflow: c.env.KEYBOARD_RAFFLE_WF,
							workflowType: "keyboard-raffle",
							instanceId: workflowId,
							params: redemption,
						});
					} else {
						logger.warn("Unknown reward ID, skipping redemption", {
							rewardId,
							rewardTitle: redemption.reward.title,
							messageId,
						});
					}
					break;
				}

				case "channel.chat.message": {
					// Parse and validate chat message event
					const chatResult = ChatMessageEventSchema.safeParse(event);
					if (!chatResult.success) {
						logger.error("Invalid chat message event payload", {
							error: chatResult.error.message,
							messageId,
						});
						break;
					}
					const chatMessage = chatResult.data;

					// Only process commands starting with !song or !queue
					const messageText = chatMessage.message.text.trim().toLowerCase();
					if (messageText.startsWith("!song") || messageText.startsWith("!queue")) {
						const workflowId = sanitizeWorkflowId(messageId);
						await triggerWarmWorkflow({
							workflow: c.env.CHAT_COMMAND_WF,
							workflowType: "chat-command",
							instanceId: workflowId,
							params: chatMessage,
						});
					}
					// Ignore other chat messages silently
					break;
				}

				default: {
					logger.warn("Unhandled EventSub subscription type", {
						type: subscription.type,
					});
				}
			}
		} catch (error) {
			logger.error("Error processing EventSub notification", {
				type: subscription.type,
				error: error instanceof Error ? error.message : String(error),
			});
			// Still return 200 to avoid retries for transient errors
		}

		// Return 200 to acknowledge receipt
		return c.json({ success: true }, 200);
	}

	// Unknown message type
	logger.warn("Unknown EventSub message type", {
		messageType,
		messageId,
	});
	return c.json({ error: "Unknown message type" }, 400);
});

export default webhooks;
