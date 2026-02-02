/**
 * Main entry point for cf-twitch-api Worker
 */

import { Hono } from "hono";

import { AchievementsDO as AchievementsDOBase } from "./durable-objects/achievements-do";
import { EventBusDO as EventBusDOBase } from "./durable-objects/event-bus-do";
import { KeyboardRaffleDO as KeyboardRaffleDOBase } from "./durable-objects/keyboard-raffle-do";
import { KeyboardRaffleSagaDO as KeyboardRaffleSagaDOBase } from "./durable-objects/keyboard-raffle-saga-do";
import { SongQueueDO as SongQueueDOBase } from "./durable-objects/song-queue-do";
import { SongRequestSagaDO as SongRequestSagaDOBase } from "./durable-objects/song-request-saga-do";
import { SpotifyTokenDO as SpotifyTokenDOBase } from "./durable-objects/spotify-token-do";
import { StreamLifecycleDO as StreamLifecycleDOBase } from "./durable-objects/stream-lifecycle-do";
import { TwitchTokenDO as TwitchTokenDOBase } from "./durable-objects/twitch-token-do";
import { withResultSerialization } from "./lib/durable-objects";
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

// Durable Object exports - wrapped with withResultSerialization for RPC Result serialization
// Explicit type annotations help TypeScript resolve import() types in generated wrangler types
export const SongQueueDO: typeof SongQueueDOBase = withResultSerialization(SongQueueDOBase);
export const SpotifyTokenDO: typeof SpotifyTokenDOBase =
	withResultSerialization(SpotifyTokenDOBase);
export const StreamLifecycleDO: typeof StreamLifecycleDOBase =
	withResultSerialization(StreamLifecycleDOBase);
export const TwitchTokenDO: typeof TwitchTokenDOBase = withResultSerialization(TwitchTokenDOBase);
export const KeyboardRaffleDO: typeof KeyboardRaffleDOBase =
	withResultSerialization(KeyboardRaffleDOBase);
export const AchievementsDO: typeof AchievementsDOBase =
	withResultSerialization(AchievementsDOBase);
export const SongRequestSagaDO: typeof SongRequestSagaDOBase =
	withResultSerialization(SongRequestSagaDOBase);
export const KeyboardRaffleSagaDO: typeof KeyboardRaffleSagaDOBase =
	withResultSerialization(KeyboardRaffleSagaDOBase);
export const EventBusDO: typeof EventBusDOBase = withResultSerialization(EventBusDOBase);

// Service exports
export { SpotifyService } from "./services/spotify-service";
export { TwitchService } from "./services/twitch-service";
