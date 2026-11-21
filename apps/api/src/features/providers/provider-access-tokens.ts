import {
  ProviderError,
  type OAuthProvider,
  type ProviderOperation,
  type SetProviderTokens,
} from "@cf-twitch/contracts/provider";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Context, Effect, Layer, Option, type Redacted, type Schema } from "effect";
import type { HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import {
  ProviderTokenExchange,
  providerTokenExchangeTestLayer,
} from "./provider-token-exchange.ts";
import { ProviderTokenHttpApi } from "./provider-token-http-api.ts";
import { ProviderTokenIdentity } from "./provider-token-identity.ts";
import {
  ProviderTokenLifecycle,
  providerTokenLifecycleLayerWithoutDependencies,
} from "./provider-token-lifecycle.ts";
import { providerTokenAlarmTestLayer } from "./provider-token-alarm.ts";
import { providerTokenDatabaseTestLayer } from "./provider-token-database.ts";
import providerTokenServerLayer, {
  SpotifyTokenServer,
  TwitchTokenServer,
} from "./provider-token-server.ts";

/** Durable provider access-token capability shared by provider services, OAuth setup and stream lifecycle fanout. */
export interface IProviderAccessTokens {
  /**
   * Returns a usable access token for a provider, refreshing it while the stream is live.
   *
   * @returns The access token, or fails with `ProviderError` reason `not-configured`, `reauthorization-required` or `offline` when no usable token exists, `persistence` when token storage is unreachable, or `invalid-response` when its response cannot be decoded.
   */
  readonly getValidAccessToken: (
    provider: OAuthProvider,
  ) => Effect.Effect<Redacted.Redacted<string>, ProviderError>;
  /**
   * Stores newly authorized tokens for one provider.
   *
   * @returns Nothing, or fails with `ProviderError` reason `reauthorization-required` when no refresh token is available, `persistence` when token storage is unreachable, or `invalid-response` when its response cannot be decoded.
   */
  readonly setTokens: (input: SetProviderTokens) => Effect.Effect<void, ProviderError>;
  /**
   * Marks the stream live for a provider's token lifecycle and validates a configured token.
   *
   * @returns Nothing, or fails with the `ProviderError` of token validation or storage.
   */
  readonly onStreamOnline: (provider: OAuthProvider) => Effect.Effect<void, ProviderError>;
  /**
   * Marks the stream offline for a provider's token lifecycle and cancels scheduled refresh.
   *
   * @returns Nothing, or fails with `ProviderError` when token storage fails or is unreachable.
   */
  readonly onStreamOffline: (provider: OAuthProvider) => Effect.Effect<void, ProviderError>;
}

/** Service that owns durable provider authorization and stream-aware token refresh policy. */
export class ProviderAccessTokens extends Context.Service<
  ProviderAccessTokens,
  IProviderAccessTokens
>()("@cf-twitch/ProviderAccessTokens") {}

const translateProviderAccessTokensFailure =
  (provider: OAuthProvider, operation: ProviderOperation) =>
  <A, R>(
    effect: Effect.Effect<
      A,
      ProviderError | HttpClientError.HttpClientError | Schema.SchemaError,
      R
    >,
  ): Effect.Effect<A, ProviderError, R> =>
    effect.pipe(
      Effect.catchTags({
        ProviderError: (error) => Effect.fail(error),
        HttpClientError: () =>
          Effect.fail(
            new ProviderError({
              provider,
              operation,
              reason: "persistence",
              status: Option.none(),
              retryAfterMs: Option.none(),
            }),
          ),
        SchemaError: () =>
          Effect.fail(
            new ProviderError({
              provider,
              operation,
              reason: "invalid-response",
              status: Option.none(),
              retryAfterMs: Option.none(),
            }),
          ),
      }),
    );

/** Creates provider access tokens over invocation-scoped HTTP clients for the two historical singleton token Durable Objects. */
export const makeProviderAccessTokens = Effect.gen(function* () {
  const spotifyNamespace = yield* SpotifyTokenServer;
  const twitchNamespace = yield* TwitchTokenServer;

  const spotifyClient = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(ProviderTokenHttpApi, {
        baseUrl: "http://spotify-token.internal",
        httpClient: Cloudflare.toHttpClient(spotifyNamespace.getByName("spotify-token")),
      }),
    ),
  );

  const twitchClient = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(ProviderTokenHttpApi, {
        baseUrl: "http://twitch-token.internal",
        httpClient: Cloudflare.toHttpClient(twitchNamespace.getByName("twitch-token")),
      }),
    ),
  );

  const clientFor = (provider: OAuthProvider) =>
    provider === "spotify" ? spotifyClient : twitchClient;

  return ProviderAccessTokens.of({
    getValidAccessToken: Effect.fn("ProviderAccessTokens.getValidAccessToken")((provider) =>
      clientFor(provider).pipe(
        Effect.flatMap((client) => client.token.getValidToken()),
        translateProviderAccessTokensFailure(provider, "getValidAccessToken"),
      ),
    ),
    setTokens: Effect.fn("ProviderAccessTokens.setTokens")((input) =>
      clientFor(input.provider).pipe(
        Effect.flatMap((client) => client.token.setTokens({ payload: input.tokens })),
        translateProviderAccessTokensFailure(input.provider, "setTokens"),
      ),
    ),
    onStreamOnline: Effect.fn("ProviderAccessTokens.onStreamOnline")((provider) =>
      clientFor(provider).pipe(
        Effect.flatMap((client) => client.token.onStreamOnline()),
        translateProviderAccessTokensFailure(provider, "onStreamOnline"),
      ),
    ),
    onStreamOffline: Effect.fn("ProviderAccessTokens.onStreamOffline")((provider) =>
      clientFor(provider).pipe(
        Effect.flatMap((client) => client.token.onStreamOffline()),
        translateProviderAccessTokensFailure(provider, "onStreamOffline"),
      ),
    ),
  });
});

/** Layer that provides provider access tokens with the Spotify and Twitch token namespace requirements visible. */
export const providerAccessTokensLayerWithoutDependencies = Layer.effect(
  ProviderAccessTokens,
  makeProviderAccessTokens,
);

/** Production provider access tokens Layer that selects the HTTP-only token Durable Object servers. */
export const providerAccessTokensLayer = providerAccessTokensLayerWithoutDependencies.pipe(
  Layer.provide(providerTokenServerLayer),
);

/**
 * Layer that provides provider access tokens over one real token lifecycle per provider with in-memory storage and alarms.
 *
 * **Details**
 *
 * Both lifecycles share the `ProviderTokenExchange` from `providerTokenExchangeTestLayer`, so refresh tokens issued during OAuth code exchange are accepted on refresh.
 */
export const providerAccessTokensTestLayer = Layer.effect(
  ProviderAccessTokens,
  Effect.gen(function* () {
    const exchange = yield* ProviderTokenExchange;

    const buildLifecycle = (provider: OAuthProvider) =>
      Layer.build(
        providerTokenLifecycleLayerWithoutDependencies.pipe(
          Layer.provide([
            providerTokenDatabaseTestLayer,
            providerTokenAlarmTestLayer,
            Layer.succeed(ProviderTokenExchange, exchange),
          ]),
          Layer.provide(Layer.succeed(ProviderTokenIdentity, provider)),
        ),
      ).pipe(Effect.map((context) => Context.get(context, ProviderTokenLifecycle)));

    const spotify = yield* buildLifecycle("spotify");
    const twitch = yield* buildLifecycle("twitch");
    const lifecycle = (provider: OAuthProvider) => (provider === "spotify" ? spotify : twitch);

    return ProviderAccessTokens.of({
      getValidAccessToken: Effect.fn("ProviderAccessTokensTest.getValidAccessToken")((provider) =>
        lifecycle(provider).getValidToken(),
      ),
      setTokens: Effect.fn("ProviderAccessTokensTest.setTokens")((input) =>
        lifecycle(input.provider).setTokens(input.tokens),
      ),
      onStreamOnline: Effect.fn("ProviderAccessTokensTest.onStreamOnline")((provider) =>
        lifecycle(provider).onStreamOnline(),
      ),
      onStreamOffline: Effect.fn("ProviderAccessTokensTest.onStreamOffline")((provider) =>
        lifecycle(provider).onStreamOffline(),
      ),
    });
  }),
).pipe(Layer.provide(providerTokenExchangeTestLayer));
