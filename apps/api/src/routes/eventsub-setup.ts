/**
 * EventSub Setup Routes
 *
 * Routes for setting up and managing Twitch EventSub subscriptions.
 * These are typically called once during initial setup or when adding new subscriptions.
 */

import { Hono } from "hono";

import { logger } from "../lib/logger";
import { TwitchService, type EventSubSubscriptionType } from "../services/twitch-service";

import type { Env } from "../index";

const eventsub = new Hono<{ Bindings: Env }>();

interface SubscriptionConfig {
	type: EventSubSubscriptionType;
	version: string;
	condition: Record<string, string>;
}

/**
 * POST /eventsub/setup
 *
 * Creates all required EventSub subscriptions for the application.
 * This should be called once during initial setup.
 *
 * Required subscriptions:
 * - stream.online
 * - stream.offline
 * - channel.channel_points_custom_reward_redemption.add
 * - channel.chat.message
 */
eventsub.post("/setup", async (c) => {
	const { TWITCH_EVENTSUB_SECRET, TWITCH_BROADCASTER_ID } = c.env;
	const twitchService = new TwitchService(c.env);

	// Get the callback URL from the request (should be the public worker URL)
	const url = new URL(c.req.url);
	const callbackUrl = `${url.protocol}//${url.host}/webhooks/twitch`;

	logger.info("Setting up EventSub subscriptions", {
		callbackUrl,
		broadcasterId: TWITCH_BROADCASTER_ID,
	});

	// Define all required subscriptions
	const subscriptions: SubscriptionConfig[] = [
		{
			type: "stream.online",
			version: "1",
			condition: {
				broadcaster_user_id: TWITCH_BROADCASTER_ID,
			},
		},
		{
			type: "stream.offline",
			version: "1",
			condition: {
				broadcaster_user_id: TWITCH_BROADCASTER_ID,
			},
		},
		{
			type: "channel.channel_points_custom_reward_redemption.add",
			version: "1",
			condition: {
				broadcaster_user_id: TWITCH_BROADCASTER_ID,
			},
		},
		{
			type: "channel.chat.message",
			version: "1",
			condition: {
				broadcaster_user_id: TWITCH_BROADCASTER_ID,
				user_id: TWITCH_BROADCASTER_ID, // Bot user ID (using broadcaster for now)
			},
		},
	];

	const results = [];
	const errors = [];

	// Create each subscription
	for (const config of subscriptions) {
		const result = await twitchService.createEventSubSubscription(
			config.type,
			config.version,
			config.condition,
			callbackUrl,
			TWITCH_EVENTSUB_SECRET,
		);

		if (result.status === "ok") {
			results.push(result.value);
			logger.info("Subscription created", {
				type: config.type,
				id: result.value.id,
				status: result.value.status,
			});
		} else {
			errors.push({
				type: config.type,
				error: result.error.message,
				code: result.error._tag,
			});
			logger.error("Failed to create subscription", {
				type: config.type,
				error: result.error.message,
			});
		}
	}

	if (errors.length > 0) {
		return c.json(
			{
				success: false,
				message: "Some subscriptions failed to create",
				created: results,
				errors,
			},
			500,
		);
	}

	return c.json({
		success: true,
		message: "All EventSub subscriptions created successfully",
		subscriptions: results,
	});
});

/**
 * GET /eventsub/list
 *
 * Lists all current EventSub subscriptions
 */
eventsub.get("/list", async (c) => {
	const twitchService = new TwitchService(c.env);

	const result = await twitchService.listEventSubSubscriptions();

	if (result.status === "error") {
		logger.error("Failed to list EventSub subscriptions", {
			error: result.error.message,
			code: result.error._tag,
		});
		return c.json(
			{
				error: result.error.message,
				code: result.error._tag,
			},
			500,
		);
	}

	return c.json({
		subscriptions: result.value,
		total: result.value.length,
	});
});

/**
 * DELETE /eventsub/:id
 *
 * Deletes a specific EventSub subscription
 */
eventsub.delete("/:id", async (c) => {
	const twitchService = new TwitchService(c.env);
	const subscriptionId = c.req.param("id");

	const result = await twitchService.deleteEventSubSubscription(subscriptionId);

	if (result.status === "error") {
		logger.error("Failed to delete EventSub subscription via API", {
			subscriptionId,
			error: result.error.message,
			code: result.error._tag,
		});
		return c.json(
			{
				success: false,
				message: result.error.message,
				code: result.error._tag,
			},
			500,
		);
	}

	return c.json({
		success: true,
		message: "Subscription deleted successfully",
	});
});

/**
 * POST /eventsub/cleanup
 *
 * Deletes all existing EventSub subscriptions
 * Useful for testing or resetting subscriptions
 */
eventsub.post("/cleanup", async (c) => {
	const twitchService = new TwitchService(c.env);

	const listResult = await twitchService.listEventSubSubscriptions();

	if (listResult.status === "error") {
		logger.error("Failed to list EventSub subscriptions for cleanup", {
			error: listResult.error.message,
			code: listResult.error._tag,
		});
		return c.json(
			{
				error: listResult.error.message,
				code: listResult.error._tag,
			},
			500,
		);
	}

	const subscriptions = listResult.value;

	logger.info("Cleaning up EventSub subscriptions", {
		count: subscriptions.length,
	});

	const results = {
		deleted: 0,
		failed: 0,
	};

	// AI: blocking await in for loop
	for (const sub of subscriptions) {
		const result = await twitchService.deleteEventSubSubscription(sub.id);
		if (result.status === "ok") {
			results.deleted++;
		} else {
			results.failed++;
			logger.error("Failed to delete subscription during cleanup", {
				subscriptionId: sub.id,
				type: sub.type,
				error: result.error.message,
			});
		}
	}

	return c.json({
		success: results.failed === 0,
		message: `Deleted ${results.deleted} subscriptions, ${results.failed} failed`,
		...results,
	});
});

export default eventsub;
