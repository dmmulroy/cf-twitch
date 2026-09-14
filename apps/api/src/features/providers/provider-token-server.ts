import { SqliteClient } from "@effect/sql-sqlite-do";
import { ProviderError, type OAuthProvider } from "@cf-twitch/contracts/provider";
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import {
  providerTokenDatabaseLayerWithoutDependencies,
  TokenProviderIdentity,
} from "./provider-token-database.ts";
import { ProviderTokenExchange, providerTokenExchangeLayer } from "./provider-token-exchange.ts";
import { ProviderTokenHttpApi } from "./provider-token-http-api.ts";
import { providerTokenHttpHandlersLayer } from "./provider-token-http-handlers.ts";
import {
  ProviderTokenAlarm,
  ProviderTokenLifecycle,
  providerTokenLifecycleLayerWithoutDependencies,
} from "./provider-token-lifecycle.ts";

type ProviderTokenServerContract = {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
};

/** Spotify token namespace preserves its historical physical class without adopting production storage. */
export class SpotifyTokenServer extends Cloudflare.DurableObject<
  SpotifyTokenServer,
  ProviderTokenServerContract
>()("SpotifyTokenDO") {}

/** Twitch token namespace preserves its historical physical class without adopting production storage. */
export class TwitchTokenServer extends Cloudflare.DurableObject<
  TwitchTokenServer,
  ProviderTokenServerContract
>()("TwitchTokenDO") {}

const tokenServer = (provider: OAuthProvider) =>
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const exchange = yield* ProviderTokenExchange;

    return Effect.gen(function* () {
      const failure = () =>
        new ProviderError({
          provider,
          operation: "tokenAlarm",
          kind: "persistence",
          status: 0,
          retryAfterMs: Option.none(),
        });

      const alarmLayer = Layer.succeed(ProviderTokenAlarm, {
        setAlarm: Effect.fn("ProviderTokenAlarm.setAlarm")((atMs) =>
          Effect.tryPromise({ try: () => state.raw.storage.setAlarm(atMs), catch: failure }),
        ),
        deleteAlarm: Effect.fn("ProviderTokenAlarm.deleteAlarm")(() =>
          Effect.tryPromise({ try: () => state.raw.storage.deleteAlarm(), catch: failure }),
        ),
      });

      const databaseLayer = providerTokenDatabaseLayerWithoutDependencies.pipe(
        Layer.provide(SqliteClient.layer({ storage: state.raw.storage })),
        Layer.provide(Layer.succeed(TokenProviderIdentity, provider)),
      );

      const lifecycleLayer = providerTokenLifecycleLayerWithoutDependencies.pipe(
        Layer.provide([
          databaseLayer,
          alarmLayer,
          Layer.succeed(ProviderTokenExchange, exchange),
          Layer.succeed(TokenProviderIdentity, provider),
        ]),
      );

      return yield* Effect.gen(function* () {
        const lifecycle = yield* ProviderTokenLifecycle;

        const httpLayer = HttpApiBuilder.layer(ProviderTokenHttpApi).pipe(
          Layer.provide(
            providerTokenHttpHandlersLayer.pipe(
              Layer.provide(Layer.succeed(ProviderTokenLifecycle, lifecycle)),
            ),
          ),
          Layer.provide(cloudflareHttpServerLayer),
        );

        const fetch = yield* HttpRouter.toHttpEffect(httpLayer);

        return {
          fetch,
          alarm: () =>
            lifecycle.refreshTokenTick().pipe(
              Effect.catchTag("ProviderError", (error) =>
                error.kind === "persistence"
                  ? Effect.die(error)
                  : Effect.logWarning("Provider token alarm refresh failed", {
                      provider: error.provider,
                      kind: error.kind,
                    }),
              ),
            ),
        };
      }).pipe(Effect.provide(lifecycleLayer));
    }).pipe(Effect.orDie);
  });

/** Spotify token server preserves the provider exchange seam for controlled workerd transports. */
export const spotifyTokenServerLayerWithoutDependencies = SpotifyTokenServer.make(
  tokenServer("spotify"),
);

/** Twitch token server preserves the provider exchange seam for controlled workerd transports. */
export const twitchTokenServerLayerWithoutDependencies = TwitchTokenServer.make(
  tokenServer("twitch"),
);

const readyTokenExchangeLayer = providerTokenExchangeLayer;

/** Spotify token server acquires SQL only inside its returned runtime Effect. */
export const spotifyTokenServerLayer = spotifyTokenServerLayerWithoutDependencies.pipe(
  Layer.provide(readyTokenExchangeLayer),
);

/** Twitch token server acquires SQL only inside its returned runtime Effect. */
export const twitchTokenServerLayer = twitchTokenServerLayerWithoutDependencies.pipe(
  Layer.provide(readyTokenExchangeLayer),
);

/** Both provider token servers are registered at the Worker composition root. */
const providerTokenServerLayer = Layer.mergeAll(spotifyTokenServerLayer, twitchTokenServerLayer);

export default providerTokenServerLayer;
