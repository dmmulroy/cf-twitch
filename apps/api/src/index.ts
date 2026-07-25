/**
 * Main entry point for cf-twitch-api Worker
 */

import { Hono } from "hono";

import { logger, normalizeError, startTimer, withLogContext } from "./lib/logger";
import admin from "./routes/admin";
import api from "./routes/api";
import eventsub from "./routes/eventsub-setup";
import oauth from "./routes/oauth";
import overlay from "./routes/overlay";
import stats from "./routes/stats";
import webhooks from "./routes/webhooks";

import type { AppRouteEnv } from "./lib/request-context";

/**
 * Re-export Env from generated Cloudflare.Env.
 * wrangler types generates typed DO namespaces when script_name is omitted.
 */
export type Env = Cloudflare.Env;

const app = new Hono<AppRouteEnv<Env>>();

app.use("*", async (c, next) => {
	// Request and trace IDs are server-owned so untrusted callers cannot create
	// collisions in operational correlation data.
	const requestId = crypto.randomUUID();
	const traceId = crypto.randomUUID();
	const queryKeys = [...new URL(c.req.url).searchParams.keys()].sort();
	const requestTimer = startTimer();
	const requestLogger = logger.child({
		component: "route",
		request_id: requestId,
		trace_id: traceId,
		method: c.req.method,
		path: c.req.path,
		route: c.req.path,
	});

	c.set("logger", requestLogger);
	c.set("requestId", requestId);
	c.set("traceId", traceId);

	requestLogger.info("HTTP request received", {
		event: "http.request.received",
		query_keys: queryKeys,
		cf_ray: c.req.header("cf-ray"),
	});

	try {
		await withLogContext(
			{
				request_id: requestId,
				trace_id: traceId,
				method: c.req.method,
				path: c.req.path,
				route: c.req.path,
			},
			() => next(),
		);
		requestLogger.info("HTTP request completed", {
			event: "http.request.completed",
			status_code: c.res.status,
			duration_ms: requestTimer(),
		});
	} catch (error) {
		requestLogger.error("HTTP request failed", {
			event: "http.request.failed",
			status_code: 500,
			duration_ms: requestTimer(),
			...normalizeError(error),
		});
		c.res = c.json({ error: "Internal server error" }, 500);
	} finally {
		// Cache API and redirect responses may expose immutable headers. Cloning gives
		// this Worker middleware ownership of the final response header list.
		c.res = new Response(c.res.body, c.res);
		c.res.headers.set("x-request-id", requestId);
		c.res.headers.set("x-trace-id", traceId);
	}

	return c.res;
});

// Mount OAuth routes
app.route("/oauth", oauth);

// Mount EventSub setup routes
app.route("/eventsub", eventsub);

// Mount webhook routes
app.route("/webhooks", webhooks);

// Mount API routes
app.route("/api", api);

// Mount stats routes
app.route("/api/stats", stats);

// Mount admin routes
app.route("/api/admin", admin);

// Mount overlay routes
app.route("/overlay", overlay);

// Health check
app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;

// Durable Object exports
export { SongQueueDO } from "./durable-objects/song-queue-do";
export { SpotifyTokenDO } from "./durable-objects/spotify-token-do";
export { StreamLifecycleDO } from "./durable-objects/stream-lifecycle-do";
export { TwitchTokenDO } from "./durable-objects/twitch-token-do";
export { KeyboardRaffleDO } from "./durable-objects/keyboard-raffle-do";
export { AchievementsDO } from "./durable-objects/achievements-do";
export { SongRequestSagaDO } from "./durable-objects/song-request-saga-do";
export { KeyboardRaffleSagaDO } from "./durable-objects/keyboard-raffle-saga-do";
export { EventBusDO } from "./durable-objects/event-bus-do";
export { CommandsDO } from "./durable-objects/commands-do";
export { RaidShoutoutSagaDO } from "./durable-objects/raid-shoutout-saga-do";
export { OAuthStateDO } from "./durable-objects/oauth-state-do";

// Service exports
export { SpotifyService } from "./services/spotify-service";
export { TwitchService } from "./services/twitch-service";
