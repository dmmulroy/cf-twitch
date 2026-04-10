/**
 * EventSub Setup Routes
 *
 * Routes for setting up and managing Twitch EventSub subscriptions.
 * These are typically called once during initial setup or when adding new subscriptions.
 */

import { Hono } from "hono";

import { type AppRouteEnv, getRequestLogger } from "../lib/request-context";
import { TwitchService, type EventSubSubscriptionType } from "../services/twitch-service";

import type { Env } from "../index";

const eventsub = new Hono<AppRouteEnv<Env>>();

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
	const routeLogger = getRequestLogger(c).child({ route: "/eventsub/setup", component: "route" });
	const { TWITCH_EVENTSUB_SECRET, TWITCH_BROADCASTER_ID } = c.env;
	const twitchService = new TwitchService(c.env);

	const url = new URL(c.req.url);
	const callbackUrl = `${url.protocol}//${url.host}/webhooks/twitch`;

	routeLogger.info("Setting up EventSub subscriptions", {
		event: "eventsub.setup.started",
		callback_url: callbackUrl,
		broadcaster_id: TWITCH_BROADCASTER_ID,
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
		routeLogger.info("Creating EventSub subscription", {
			event: "eventsub.subscription.create.started",
			subscription_type: config.type,
			version: config.version,
			callback_url: callbackUrl,
		});
		const result = await twitchService.createEventSubSubscription(
			config.type,
			config.version,
			config.condition,
			callbackUrl,
			TWITCH_EVENTSUB_SECRET,
		);

		if (result.status === "ok") {
			results.push(result.value);
			routeLogger.info("Created EventSub subscription", {
				event: "eventsub.subscription.create.succeeded",
				subscription_type: config.type,
				version: config.version,
				subscription_id: result.value.id,
				status: result.value.status,
			});
		} else {
			errors.push({
				type: config.type,
				error: result.error.message,
				code: result.error._tag,
			});
			routeLogger.error("Failed to create EventSub subscription", {
				event: "eventsub.subscription.create.failed",
				subscription_type: config.type,
				version: config.version,
				...result.error,
			});
		}
	}

	routeLogger.info("EventSub setup completed", {
		event: "eventsub.setup.completed",
		callback_url: callbackUrl,
		subscription_count: subscriptions.length,
		created_count: results.length,
		failed_count: errors.length,
	});

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
	const routeLogger = getRequestLogger(c).child({ route: "/eventsub/list", component: "route" });
	const twitchService = new TwitchService(c.env);
	routeLogger.info("Listing EventSub subscriptions", {
		event: "eventsub.list.started",
	});

	const result = await twitchService.listEventSubSubscriptions();

	if (result.status === "error") {
		routeLogger.error("Failed to list EventSub subscriptions", {
			event: "eventsub.list.failed",
			...result.error,
		});
		return c.json(
			{
				error: result.error.message,
				code: result.error._tag,
			},
			500,
		);
	}

	routeLogger.info("Listed EventSub subscriptions", {
		event: "eventsub.list.succeeded",
		count: result.value.length,
	});
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
	const routeLogger = getRequestLogger(c).child({ route: "/eventsub/:id", component: "route" });
	const twitchService = new TwitchService(c.env);
	const subscriptionId = c.req.param("id");
	routeLogger.info("Deleting EventSub subscription", {
		event: "eventsub.delete.started",
		subscription_id: subscriptionId,
	});

	const result = await twitchService.deleteEventSubSubscription(subscriptionId);

	if (result.status === "error") {
		routeLogger.error("Failed to delete EventSub subscription", {
			event: "eventsub.delete.failed",
			subscription_id: subscriptionId,
			...result.error,
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

	routeLogger.info("Deleted EventSub subscription", {
		event: "eventsub.delete.succeeded",
		subscription_id: subscriptionId,
	});
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
	const routeLogger = getRequestLogger(c).child({ route: "/eventsub/cleanup", component: "route" });
	const twitchService = new TwitchService(c.env);
	routeLogger.info("Cleaning up EventSub subscriptions", {
		event: "eventsub.cleanup.started",
	});

	const listResult = await twitchService.listEventSubSubscriptions();

	if (listResult.status === "error") {
		routeLogger.error("Failed to list EventSub subscriptions for cleanup", {
			event: "eventsub.cleanup.list_failed",
			...listResult.error,
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
	const results = {
		deleted: 0,
		failed: 0,
	};

	for (const sub of subscriptions) {
		const result = await twitchService.deleteEventSubSubscription(sub.id);
		if (result.status === "ok") {
			results.deleted++;
		} else {
			results.failed++;
			routeLogger.error("Failed to delete subscription during cleanup", {
				event: "eventsub.cleanup.subscription_delete_failed",
				subscription_id: sub.id,
				subscription_type: sub.type,
				...result.error,
			});
		}
	}

	routeLogger.info("EventSub cleanup completed", {
		event: "eventsub.cleanup.completed",
		deleted_count: results.deleted,
		failed_count: results.failed,
	});
	return c.json({
		success: results.failed === 0,
		message: `Deleted ${results.deleted} subscriptions, ${results.failed} failed`,
		...results,
	});
});

export default eventsub;
