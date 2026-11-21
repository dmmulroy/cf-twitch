import { SqliteClient } from "@effect/sql-sqlite-do";
import type { OAuthProvider } from "@cf-twitch/contracts/provider";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { ProviderTokenExchange, providerTokenExchangeLayer } from "./provider-token-exchange.ts";
import { ProviderTokenHttpApi } from "./provider-token-http-api.ts";
import { providerTokenHttpHandlersLayer } from "./provider-token-http-handlers.ts";
import { ProviderTokenIdentity } from "./provider-token-identity.ts";
import { ProviderTokenLifecycle, providerTokenLifecycleLayer } from "./provider-token-lifecycle.ts";

type ProviderTokenServerContract = {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
};

/** Durable Object namespace of Spotify tokens, preserving the historical `SpotifyTokenDO` class without adopting production storage. */
export class SpotifyTokenServer extends Cloudflare.DurableObject<
  SpotifyTokenServer,
  ProviderTokenServerContract
>()("SpotifyTokenDO") {}

/** Durable Object namespace of Twitch tokens, preserving the historical `TwitchTokenDO` class without adopting production storage. */
export class TwitchTokenServer extends Cloudflare.DurableObject<
  TwitchTokenServer,
  ProviderTokenServerContract
>()("TwitchTokenDO") {}

/**
 * Creates the runtime of one provider token Durable Object for the provider it physically represents.
 *
 * **Details**
 *
 * Outer initialization captures `ProviderTokenExchange`; SQL and native storage are acquired only inside the returned runtime Effect.
 * Alarm refresh failures other than storage failures are logged, because the lifecycle has already persisted its retry deadline.
 *
 * @throws Dies when token storage cannot be initialized, when a historical Agent import fails closed, or when an alarm refresh fails with reason `persistence` or `stored-state-invalid`.
 */
const makeProviderTokenServer = (provider: OAuthProvider) =>
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const exchange = yield* ProviderTokenExchange;

    return Effect.gen(function* () {
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
              error.reason === "persistence" || error.reason === "stored-state-invalid"
                ? Effect.die(error)
                : Effect.logWarning("Provider token alarm refresh failed", {
                    provider: error.provider,
                    reason: error.reason,
                  }),
            ),
          ),
      };
    }).pipe(
      Effect.provide(
        providerTokenLifecycleLayer.pipe(
          Layer.provide([
            SqliteClient.layer({ storage: state.raw.storage }),
            Layer.succeed(Cloudflare.DurableObjectState, state),
            Layer.succeed(ProviderTokenExchange, exchange),
          ]),
          Layer.provide(Layer.succeed(ProviderTokenIdentity, provider)),
        ),
      ),
      Effect.orDie,
    );
  });

/** Layer that registers the Spotify token server, leaving `ProviderTokenExchange` required for controlled workerd transports. */
export const spotifyTokenServerLayerWithoutDependencies = SpotifyTokenServer.make(
  makeProviderTokenServer("spotify"),
);

/** Layer that registers the Twitch token server, leaving `ProviderTokenExchange` required for controlled workerd transports. */
export const twitchTokenServerLayerWithoutDependencies = TwitchTokenServer.make(
  makeProviderTokenServer("twitch"),
);

/** Production Spotify token server Layer that selects real provider token exchange; SQL is acquired only inside its runtime Effect. */
export const spotifyTokenServerLayer = spotifyTokenServerLayerWithoutDependencies.pipe(
  Layer.provide(providerTokenExchangeLayer),
);

/** Production Twitch token server Layer that selects real provider token exchange; SQL is acquired only inside its runtime Effect. */
export const twitchTokenServerLayer = twitchTokenServerLayerWithoutDependencies.pipe(
  Layer.provide(providerTokenExchangeLayer),
);

/** Layer that registers both production provider token servers at the Worker composition root. */
const providerTokenServerLayer = Layer.mergeAll(spotifyTokenServerLayer, twitchTokenServerLayer);

/** Default export of the provider token server registration Layer for the Worker composition root. */
export default providerTokenServerLayer;
