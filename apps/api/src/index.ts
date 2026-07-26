/** Cloudflare Worker composition root for CF Twitch. */

import { DurableObjectSongQueue } from "./adapters/cloudflare/durable-object-song-queue";
import { createWorkerHttpApp } from "./adapters/http/worker-http-app";
import { logger } from "./lib/logger";
import { createRequestId, createTraceId } from "./lib/request-context";

/** Generated Cloudflare Worker binding contract. */
export type Env = Cloudflare.Env;

export default {
	async fetch(
		request: Request,
		env: Cloudflare.Env,
		executionContext: ExecutionContext,
	): Promise<Response> {
		const correlation = {
			requestId: createRequestId(),
			traceId: createTraceId(),
		};
		const invocationLogger = logger.child({
			component: "worker",
			request_id: correlation.requestId,
			trace_id: correlation.traceId,
		});
		const songQueue = new DurableObjectSongQueue(env.SONG_QUEUE_DO);
		const app = createWorkerHttpApp({ correlation, logger: invocationLogger, songQueue });
		return app.fetch(request, env, executionContext);
	},
} satisfies ExportedHandler<Cloudflare.Env>;

// Durable Object exports are runtime entrypoints required by Wrangler.
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
export { EventSubWebhookDO } from "./durable-objects/eventsub-webhook-do";
export { OAuthStateDO } from "./durable-objects/oauth-state-do";
