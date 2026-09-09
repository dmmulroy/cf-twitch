import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { StreamLifecycleError } from "@cf-twitch/contracts/stream";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import {
  TwitchConfiguration,
  twitchConfigurationLayer,
} from "../../runtime/twitch-configuration.ts";
import { eventPublisherLayer } from "../events/event-bus-client.ts";
import { EventPublisher } from "../events/event-bus-service.ts";
import { ProviderAccessTokens } from "../providers/provider-access-tokens.ts";
import { providerAccessTokensLayer } from "../providers/provider-token-client.ts";
import { TwitchService, twitchServiceLayer } from "../providers/twitch-service.ts";
import { streamDatabaseLayerWithoutDependencies } from "./stream-database.ts";
import { StreamLifecycleHttpApi } from "./stream-http-api.ts";
import { streamLifecycleHttpHandlersLayer } from "./stream-http-handlers.ts";
import {
  StreamAlarm,
  StreamProcessor,
  StreamViewerProvider,
  streamLifecycleLayerWithoutDependencies,
} from "./stream.ts";

type StreamLifecycleServerContract = {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
};

/** Namespace service for the preserved physical StreamLifecycleDO class. */
export class StreamLifecycleServer extends Cloudflare.DurableObject<
  StreamLifecycleServer,
  StreamLifecycleServerContract
>()("StreamLifecycleDO") {}

const alarmError = () =>
  new StreamLifecycleError({
    operation: "resumeTransitionEffects",
    reason: "persistence_unavailable",
  });

const makeStreamLifecycleServer = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const accessTokens = yield* ProviderAccessTokens;
  const eventPublisher = yield* EventPublisher;
  const twitch = yield* TwitchService;
  const configuration = yield* TwitchConfiguration;

  const streamAlarm = StreamAlarm.of({
    scheduleAt: (timestamp) =>
      Effect.tryPromise({
        try: () => state.raw.storage.setAlarm(new Date(timestamp)),
        catch: alarmError,
      }),
    clear: () =>
      Effect.tryPromise({
        try: () => state.raw.storage.deleteAlarm(),
        catch: alarmError,
      }),
  });

  const alarmLayer = Layer.succeed(StreamAlarm, streamAlarm);

  const viewerLayer = Layer.succeed(
    StreamViewerProvider,
    StreamViewerProvider.of({
      getViewerCount: () =>
        twitch.getStreamInfo(configuration.twitch.broadcaster.displayName).pipe(
          Effect.map((stream) => Option.map(stream, (value) => value.viewerCount)),
          Effect.mapError(
            () =>
              new StreamLifecycleError({
                operation: "recordViewerCount",
                reason: "provider_unavailable",
              }),
          ),
        ),
    }),
  );

  const databaseLayer = streamDatabaseLayerWithoutDependencies.pipe(
    Layer.provide(SqliteClient.layer({ storage: state.raw.storage })),
  );

  const applicationLayer = streamLifecycleLayerWithoutDependencies.pipe(
    Layer.provide(databaseLayer),
    Layer.provide(alarmLayer),
    Layer.provide(viewerLayer),
    Layer.provide(Layer.succeed(ProviderAccessTokens, accessTokens)),
    Layer.provide(Layer.succeed(EventPublisher, eventPublisher)),
  );

  const handlersLayer = streamLifecycleHttpHandlersLayer.pipe(Layer.provide(applicationLayer));

  return Effect.gen(function* () {
    const apiLayer = HttpApiBuilder.layer(StreamLifecycleHttpApi).pipe(
      Layer.provide(handlersLayer),
      Layer.provide(cloudflareHttpServerLayer),
    );

    const fetch = yield* HttpRouter.toHttpEffect(apiLayer);
    const processor = yield* StreamProcessor;
    yield* Effect.result(processor.resumeTransitionEffects());
    yield* processor.rebuildAlarm();

    return {
      fetch,
      alarm: () => processor.processAlarm().pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(applicationLayer), Effect.orDie);
});

/** Hosts StreamLifecycleDO while leaving every outgoing application capability visible. */
export const streamLifecycleServerLayerWithoutDependencies = StreamLifecycleServer.make<
  ProviderAccessTokens | EventPublisher | TwitchService | TwitchConfiguration
>(makeStreamLifecycleServer.pipe(Effect.orDie));

/** Ready Stream Lifecycle server selects the production provider and Event Bus graph. */
export const streamLifecycleServerLayer = streamLifecycleServerLayerWithoutDependencies.pipe(
  Layer.provide(providerAccessTokensLayer),
  Layer.provide(eventPublisherLayer),
  Layer.provide(twitchServiceLayer),
  Layer.provide(twitchConfigurationLayer),
);

export default streamLifecycleServerLayer;
