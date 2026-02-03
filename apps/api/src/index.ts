/**
 * Main entry point for cf-twitch-api Worker
 */

import { Hono } from "hono";

import admin from "./routes/admin";
import api from "./routes/api";
import eventsub from "./routes/eventsub-setup";
import oauth from "./routes/oauth";
import overlay from "./routes/overlay";
import stats from "./routes/stats";
import webhooks from "./routes/webhooks";

/**
 * Re-export Env from generated Cloudflare.Env.
 * wrangler types generates typed DO namespaces when script_name is omitted.
 *
 * ADMIN_SECRET is optional - set via `wrangler secret put ADMIN_SECRET`
 */
export interface Env extends Cloudflare.Env {
	ADMIN_SECRET?: string;
}

const app = new Hono<{ Bindings: Env }>();

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

// Service exports
export { SpotifyService } from "./services/spotify-service";
export { TwitchService } from "./services/twitch-service";
