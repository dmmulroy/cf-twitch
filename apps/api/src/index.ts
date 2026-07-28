/** Cloudflare Worker composition root for CF Twitch. */

import { CloudflareEdgeResponseCache } from "./adapters/cloudflare/cloudflare-edge-response-cache";
import {
	DurableObjectSpotifyAccessTokens,
	DurableObjectTwitchAccessTokens,
} from "./adapters/cloudflare/durable-object-access-tokens";
import { DurableObjectChatCommands } from "./adapters/cloudflare/durable-object-chat-commands";
import { DurableObjectEventBusAdministration } from "./adapters/cloudflare/durable-object-event-bus-administration";
import { DurableObjectEventSubReceiptAcceptor } from "./adapters/cloudflare/durable-object-eventsub-receipts";
import {
	DurableObjectAchievementReader,
	DurableObjectStreamLifecycle,
} from "./adapters/cloudflare/durable-object-http-state";
import { DurableObjectOAuthAuthorizationState } from "./adapters/cloudflare/durable-object-oauth-authorization-state";
import { DurableObjectRaffleStatistics } from "./adapters/cloudflare/durable-object-raffle-statistics";
import { DurableObjectSongQueue } from "./adapters/cloudflare/durable-object-song-queue";
import { createAdminRoutes } from "./adapters/http/create-admin-routes";
import { createEventSubRoutes } from "./adapters/http/create-eventsub-routes";
import { createEventSubWebhookRoutes } from "./adapters/http/create-eventsub-webhook-routes";
import { createOAuthRoutes } from "./adapters/http/create-oauth-routes";
import { createOverlayRoutes } from "./adapters/http/create-overlay-routes";
import { createWorkerHttpApp } from "./adapters/http/worker-http-app";
import { LoggingTracer } from "./capabilities/tracer";
import { parseWorkerConfiguration } from "./configuration/worker-configuration";
import { logger } from "./lib/logger";
import { createRequestId, createTraceId } from "./lib/request-context";
import { SpotifyService } from "./services/spotify-service";
import { TwitchService } from "./services/twitch-service";

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
		const configuration = parseWorkerConfiguration(env);
		if (configuration.status === "error") {
			invocationLogger.error("Worker configuration parsing failed", {
				event: "worker.configuration.invalid",
				error_tag: configuration.error._tag,
			});
			return Response.json({ error: "Service unavailable" }, { status: 503 });
		}
		const tracer = new LoggingTracer(invocationLogger);
		const spotifyAccessTokens = new DurableObjectSpotifyAccessTokens(env.SPOTIFY_TOKEN_DO, tracer);
		const twitchAccessTokens = new DurableObjectTwitchAccessTokens(env.TWITCH_TOKEN_DO, tracer);
		const spotifyService = new SpotifyService({
			configuration: configuration.value.spotify,
			accessTokens: spotifyAccessTokens,
		});
		const twitchService = new TwitchService({
			configuration: configuration.value.twitch,
			accessTokens: twitchAccessTokens,
		});
		const songQueue = new DurableObjectSongQueue(env.SONG_QUEUE_DO, tracer);
		const raffles = new DurableObjectRaffleStatistics(env.KEYBOARD_RAFFLE_DO, tracer);
		const streamLifecycle = new DurableObjectStreamLifecycle(env.STREAM_LIFECYCLE_DO, tracer);
		const achievements = new DurableObjectAchievementReader(env.ACHIEVEMENTS_DO, tracer);
		const eventBusAdministration = new DurableObjectEventBusAdministration(
			env.EVENT_BUS_DO,
			tracer,
		);
		const chatCommands = new DurableObjectChatCommands(env.COMMANDS_DO, tracer);
		const edgeResponseCache = new CloudflareEdgeResponseCache(
			caches.default,
			(task) => executionContext.waitUntil(task),
			invocationLogger,
		);
		const oauthAuthorizationStates = new DurableObjectOAuthAuthorizationState(
			env.OAUTH_STATE_DO,
			() => Date.now(),
			() => crypto.randomUUID(),
			10 * 60 * 1_000,
		);
		const eventSubReceipts = new DurableObjectEventSubReceiptAcceptor(
			env.EVENTSUB_WEBHOOK_DO,
			tracer,
		);
		const app = createWorkerHttpApp({
			correlation,
			logger: invocationLogger,
			songQueue,
			raffles,
			edgeResponseCache,
			administratorSecret: configuration.value.administratorSecret,
			streamLifecycle,
			achievements,
			twitchStreams: twitchService,
			broadcasterDisplayName: configuration.value.twitch.broadcaster.displayName,
			oauthRoutes: createOAuthRoutes({
				oauthSetupSecret: configuration.value.oauthSetupSecret,
				spotifyClientId: configuration.value.spotify.clientId,
				twitchClientId: configuration.value.twitch.clientId,
				authorizationStates: oauthAuthorizationStates,
				spotifyOAuth: spotifyService,
				twitchOAuth: twitchService,
				spotifyTokens: spotifyAccessTokens,
				twitchTokens: twitchAccessTokens,
			}),
			eventSubRoutes: createEventSubRoutes({
				administratorSecret: configuration.value.administratorSecret,
				broadcasterId: configuration.value.twitch.broadcaster.id,
				eventSubSecret: configuration.value.eventSubSecret,
				eventSubAdministration: twitchService,
			}),
			eventSubWebhookRoutes: createEventSubWebhookRoutes({
				eventSubSecret: configuration.value.eventSubSecret,
				receipts: eventSubReceipts,
				correlation,
			}),
			overlayRoutes: createOverlayRoutes({ logger: invocationLogger }),
			adminRoutes: createAdminRoutes({
				administratorSecret: configuration.value.administratorSecret,
				eventBus: eventBusAdministration,
				achievements,
				chatCommands,
				songQueue,
				raffles,
				logger: invocationLogger,
			}),
		});
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
