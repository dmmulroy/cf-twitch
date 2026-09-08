import { ProviderError, type OAuthProvider } from "@cf-twitch/contracts/provider";
import * as Cloudflare from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer, Option, type Schema } from "effect";
import type { HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { ProviderAccessTokens } from "./provider-access-tokens.ts";
import { ProviderTokenHttpApi } from "./provider-token-http-api.ts";
import providerTokenServerLayer, {
  SpotifyTokenServer,
  TwitchTokenServer,
} from "./provider-token-server.ts";

/** Construct invocation-scoped HTTP clients for the two historical singleton token keys. */
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
  const boundaryError =
    (provider: OAuthProvider, operation: string) =>
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
                kind: "persistence",
                status: 0,
                retryAfterMs: Option.none(),
              }),
            ),
          SchemaError: () =>
            Effect.fail(
              new ProviderError({
                provider,
                operation,
                kind: "invalid-response",
                status: 0,
                retryAfterMs: Option.none(),
              }),
            ),
        }),
      );
  return ProviderAccessTokens.of({
    getValidAccessToken: Effect.fn("ProviderAccessTokens.getValidAccessToken")((provider) =>
      clientFor(provider).pipe(
        Effect.flatMap((client) => client.token.getValidToken()),
        boundaryError(provider, "getValidAccessToken"),
      ),
    ),
    setTokens: Effect.fn("ProviderAccessTokens.setTokens")((input) =>
      clientFor(input.provider).pipe(
        Effect.flatMap((client) => client.token.setTokens({ payload: input.tokens })),
        boundaryError(input.provider, "setTokens"),
      ),
    ),
    onStreamOnline: Effect.fn("ProviderAccessTokens.onStreamOnline")((provider) =>
      clientFor(provider).pipe(
        Effect.flatMap((client) => client.token.onStreamOnline()),
        boundaryError(provider, "onStreamOnline"),
      ),
    ),
    onStreamOffline: Effect.fn("ProviderAccessTokens.onStreamOffline")((provider) =>
      clientFor(provider).pipe(
        Effect.flatMap((client) => client.token.onStreamOffline()),
        boundaryError(provider, "onStreamOffline"),
      ),
    ),
  });
});
/** Provider token clients preserve their real Alchemy namespace requirements. */
export const providerAccessTokensLayerWithoutDependencies = Layer.effect(
  ProviderAccessTokens,
  makeProviderAccessTokens,
);
/** Provider token clients select HTTP-only Durable Object servers. */
export const providerAccessTokensLayer = providerAccessTokensLayerWithoutDependencies.pipe(
  Layer.provide(providerTokenServerLayer),
);
