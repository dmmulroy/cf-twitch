import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { Digest } from "effect/crypto";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import {
  TwitchConfiguration,
  twitchConfigurationLayer,
} from "../../runtime/twitch-configuration.ts";
import { EventPublisher, eventPublisherLayer } from "../events/event-publisher.ts";
import {
  ProviderAccessTokens,
  providerAccessTokensLayer,
} from "../providers/provider-access-tokens.ts";
import { TwitchService, twitchServiceLayer } from "../providers/twitch-service.ts";
import { StreamLifecycleHttpApi } from "./stream-http-api.ts";
import { streamLifecycleHttpHandlersLayer } from "./stream-http-handlers.ts";
import { StreamLifecycle, streamLifecycleLayer } from "./stream-lifecycle.ts";
import { streamViewerProviderLayerWithoutDependencies } from "./stream-viewer-provider.ts";

type StreamLifecycleServerContract = {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
};

/** Durable Object namespace for the preserved physical `StreamLifecycleDO` class. */
export class StreamLifecycleServer extends Cloudflare.DurableObject<
  StreamLifecycleServer,
  StreamLifecycleServerContract
>()("StreamLifecycleDO") {}

/** Creates the `StreamLifecycleDO` runtime from services captured during outer initialization. */
const makeStreamLifecycleServer = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const accessTokens = yield* ProviderAccessTokens;
  const eventPublisher = yield* EventPublisher;
  const twitch = yield* TwitchService;
  const configuration = yield* TwitchConfiguration;
  const digestService = yield* Digest.Digest;

  const applicationLayer = streamLifecycleLayer.pipe(
    Layer.provide([
      SqliteClient.layer({ storage: state.raw.storage }),
      Layer.succeed(Cloudflare.DurableObjectState, state),
      streamViewerProviderLayerWithoutDependencies.pipe(
        Layer.provide([
          Layer.succeed(TwitchService, twitch),
          Layer.succeed(TwitchConfiguration, configuration),
        ]),
      ),
      Layer.succeed(ProviderAccessTokens, accessTokens),
      Layer.succeed(EventPublisher, eventPublisher),
      Layer.succeed(Digest.Digest, digestService),
    ]),
  );

  return Effect.gen(function* () {
    const apiLayer = HttpApiBuilder.layer(StreamLifecycleHttpApi).pipe(
      Layer.provide(streamLifecycleHttpHandlersLayer),
      Layer.provide(cloudflareHttpServerLayer),
    );

    const fetch = yield* HttpRouter.toHttpEffect(apiLayer);
    const lifecycle = yield* StreamLifecycle;
    yield* lifecycle.resumeTransitionEffects().pipe(Effect.ignore);
    yield* lifecycle.rebuildAlarm();

    return {
      fetch,
      alarm: () => lifecycle.processAlarm().pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(applicationLayer), Effect.orDie);
});

/**
 * Layer that hosts `StreamLifecycleDO`, leaving every outgoing application capability visible.
 *
 * **Details**
 *
 * Runtime initialization migrates storage, resumes incomplete transition effects best effort, and
 * reinstalls the alarm before serving the Stream Lifecycle HTTP API.
 *
 * @throws {MigrationError | SqlError | SchemaError | StreamLifecycleError} As a defect when runtime
 *   initialization cannot adopt storage or rebuild the alarm, and from the alarm handler when alarm
 *   work fails so the platform retries the alarm.
 */
export const streamLifecycleServerLayerWithoutDependencies = StreamLifecycleServer.make<
  | Cloudflare.DurableObjectState
  | ProviderAccessTokens
  | EventPublisher
  | TwitchService
  | TwitchConfiguration
  | Digest.Digest
>(makeStreamLifecycleServer.pipe(Effect.orDie));

/** Layer that hosts `StreamLifecycleDO` with the production provider, token, and Event Bus graph. */
export const streamLifecycleServerLayer = streamLifecycleServerLayerWithoutDependencies.pipe(
  Layer.provide(providerAccessTokensLayer),
  Layer.provide(eventPublisherLayer),
  Layer.provide(twitchServiceLayer),
  Layer.provide(twitchConfigurationLayer),
);

/** Default export: the production `StreamLifecycleDO` server Layer, discovered by Alchemy. */
export default streamLifecycleServerLayer;
