import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, ErrorReporter, Layer } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { achievementsClientLayer } from "../features/achievements/achievements-client.ts";
import type { AchievementsServer } from "../features/achievements/achievements-server.ts";
import { commandsClientLayer } from "../features/commands/commands-client.ts";
import type { CommandsServer } from "../features/commands/commands-server.ts";
import {
  EventBusAdministration,
  eventBusAdministrationLayer,
} from "../features/events/event-bus-administration.ts";
import type { EventBusServer } from "../features/events/event-bus-server.ts";
import type { EventSubWebhookServer } from "../features/eventsub/eventsub-server.ts";
import { httpResponseCacheLayer } from "../features/http/http-response-cache.ts";
import { twitchHttpApiLayer } from "../features/http/twitch-http-api.ts";
import { oauthAuthorizationLayer } from "../features/oauth/oauth-authorization.ts";
import type { OAuthStateServer } from "../features/oauth/oauth-state-server.ts";
import type {
  SpotifyTokenServer,
  TwitchTokenServer,
} from "../features/providers/provider-token-server.ts";
import { twitchServiceLayer } from "../features/providers/twitch-service.ts";
import { raffleClientLayer } from "../features/raffle/raffle-client.ts";
import type { RaffleServer } from "../features/raffle/raffle-server.ts";
import { songQueueLayer } from "../features/song-queue/song-queue.ts";
import type { SongQueueServer } from "../features/song-queue/song-queue-server.ts";
import { streamLifecycleClientLayer } from "../features/stream/stream-lifecycle-client.ts";
import type { StreamLifecycleServer } from "../features/stream/stream-server.ts";
import type {
  KeyboardRaffleSagaServer,
  RaidShoutoutSagaServer,
  SongRequestSagaServer,
} from "../features/workflows/workflow-server.ts";
import { cloudflareHttpServerLayer } from "./cloudflare-http-server.ts";
import { twitchAnalyticsLayer } from "./twitch-analytics.ts";
import { twitchConfigurationLayer } from "./twitch-configuration.ts";
import { twitchHttpTelemetrySafetyLayer, twitchTelemetryLayer } from "./twitch-telemetry.ts";
import { Achievements } from "../features/achievements/achievements-service.ts";
import { Commands } from "../features/commands/commands.ts";
import { EventSubReceipts, eventSubReceiptsLayer } from "../features/eventsub/eventsub-receipts.ts";
import { OAuthAuthorization } from "../features/oauth/oauth-authorization.ts";
import { TwitchService } from "../features/providers/twitch-service.ts";
import { Raffle } from "../features/raffle/raffle-service.ts";
import { SongQueue } from "../features/song-queue/song-queue.ts";
import { StreamLifecycleClient } from "../features/stream/stream-lifecycle-client.ts";
import { TwitchConfiguration } from "./twitch-configuration.ts";

type TwitchWorkerHandlers = {
  readonly fetch: HttpEffect;
};

type TwitchHostedServers =
  | AchievementsServer
  | CommandsServer
  | EventBusServer
  | EventSubWebhookServer
  | OAuthStateServer
  | SpotifyTokenServer
  | TwitchTokenServer
  | RaffleServer
  | SongQueueServer
  | StreamLifecycleServer
  | KeyboardRaffleSagaServer
  | RaidShoutoutSagaServer
  | SongRequestSagaServer;

const twitchApplicationLayer = Layer.mergeAll(
  achievementsClientLayer,
  commandsClientLayer,
  eventBusAdministrationLayer,
  eventSubReceiptsLayer,
  oauthAuthorizationLayer,
  raffleClientLayer,
  songQueueLayer,
  streamLifecycleClientLayer,
  twitchServiceLayer,
).pipe(
  Layer.provide(twitchAnalyticsLayer),
  Layer.provide(twitchConfigurationLayer),
  Layer.provide(FetchHttpClient.layer),
);

/** Worker declaration for the public Twitch API and its thirteen HTTP-only Durable Object namespaces. */
export class TwitchApiWorker extends Cloudflare.Worker<
  TwitchApiWorker,
  TwitchWorkerHandlers,
  TwitchHostedServers
>()("CfTwitchApi") {}

/**
 * Effect that captures application capabilities at init while leaving concrete providers selectable by the host.
 *
 * **Details**
 *
 * Captured services are bridged into the per-invocation router with `Layer.succeed`; the router
 * itself is memoized per execution so no scope escapes its invocation.
 */
export const twitchWorkerImplementationWithoutDependencies = Effect.gen(function* () {
  const achievements = yield* Achievements;
  const commands = yield* Commands;
  const eventBus = yield* EventBusAdministration;
  const eventSub = yield* EventSubReceipts;
  const oauth = yield* OAuthAuthorization;
  const twitch = yield* TwitchService;
  const raffle = yield* Raffle;
  const songQueue = yield* SongQueue;
  const stream = yield* StreamLifecycleClient;
  const configuration = yield* TwitchConfiguration;
  const digestService = yield* Digest.Digest;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const errorReporters = yield* ErrorReporter.CurrentErrorReporters;

  const runtimeServices = Layer.mergeAll(
    Layer.succeed(Achievements, achievements),
    Layer.succeed(Commands, commands),
    Layer.succeed(EventBusAdministration, eventBus),
    Layer.succeed(EventSubReceipts, eventSub),
    Layer.succeed(OAuthAuthorization, oauth),
    Layer.succeed(TwitchService, twitch),
    Layer.succeed(Raffle, raffle),
    Layer.succeed(SongQueue, songQueue),
    Layer.succeed(StreamLifecycleClient, stream),
    Layer.succeed(TwitchConfiguration, configuration),
    Layer.succeed(Digest.Digest, digestService),
    Layer.succeed(SecureRandom.SecureRandom, secureRandom),
  );

  // Router acquisition is scoped in Effect rc.112; never attach it to workerd's unclosed isolate scope.
  const requestRouter = yield* makeExecutionMemo(
    HttpRouter.toHttpEffect(
      twitchHttpApiLayer.pipe(
        Layer.provide(runtimeServices),
        Layer.provide(httpResponseCacheLayer),
        Layer.provide(cloudflareHttpServerLayer),
        Layer.provideMerge(Layer.succeed(ErrorReporter.CurrentErrorReporters, errorReporters)),
      ),
    ),
  );

  const fetch: HttpEffect = Effect.flatten(requestRouter);

  return { fetch };
});

/**
 * Effect that initializes the production capability graph during Alchemy planning and runtime cold start.
 *
 * @throws A defect when runtime configuration, telemetry settings, or the analytics dataset stage
 *   are invalid; the Worker cannot start without them.
 */
export const twitchWorkerImplementation = twitchWorkerImplementationWithoutDependencies.pipe(
  Effect.provide(twitchApplicationLayer),
  Effect.provide(twitchConfigurationLayer),
  Effect.provide(twitchTelemetryLayer),
  // Provide the application's crypto requirements without acquiring unrelated Node services.
  Effect.provide(Layer.mergeAll(NodeCrypto.layerDigest, NodeCrypto.layerSecureRandom)),
  Effect.orDie,
);

/**
 * Layer that declares the `cf-twitch-api` Worker with its implementation and telemetry safety.
 *
 * **Details**
 *
 * Alchemy owns stage-qualified Worker names; existing production resources are never adopted
 * implicitly.
 */
export const twitchApiWorkerLayer = TwitchApiWorker.make(
  {
    name: "cf-twitch-api",
    main: import.meta.url,
    compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
    dev: { port: 8787, strictPort: true },
    workersDev: true,
    observability: { enabled: true },
  },
  twitchWorkerImplementation,
).pipe(
  // Alchemy's native HTTP adapter wraps fetch in a tracer. Its context must disable
  // unsafe collection before that wrapper runs, not merely inside the application.
  Layer.provideMerge(twitchHttpTelemetrySafetyLayer),
);

export default twitchApiWorkerLayer;
