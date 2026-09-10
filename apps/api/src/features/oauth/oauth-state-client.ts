import {
  OAuthError,
  type ConsumeAuthorizationState,
  type OAuthAuthorizationAttempt,
  type OAuthStateOutcome,
} from "@cf-twitch/contracts/oauth";
import * as Cloudflare from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Cache, Context, Effect, Layer, Redacted, type Schema } from "effect";
import type { HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { OAuthStateHttpApi } from "./oauth-state-http-api.ts";
import oauthStateServerLayer, { OAuthStateServer } from "./oauth-state-server.ts";

/** OAuth state client addresses each random attempt independently, retaining legacy object keys. */
export interface IOAuthStateClient {
  readonly createAttempt: (input: OAuthAuthorizationAttempt) => Effect.Effect<void, OAuthError>;
  readonly consumeAttempt: (
    input: ConsumeAuthorizationState,
  ) => Effect.Effect<OAuthStateOutcome, OAuthError>;
}

/** OAuth state client exposes no native Durable Object handles to HTTP routes. */
export class OAuthStateClient extends Context.Service<OAuthStateClient, IOAuthStateClient>()(
  "@cf-twitch/OAuthStateClient",
) {}

/** Construct bounded invocation-local OAuth clients without retaining stubs across invocations. */
export const makeOAuthStateClient = Effect.gen(function* () {
  const namespace = yield* OAuthStateServer;

  const clients = yield* makeExecutionMemo(
    Cache.make({
      capacity: 128,
      lookup: (state: string) =>
        Effect.suspend(() =>
          HttpApiClient.makeWith(OAuthStateHttpApi, {
            baseUrl: "http://oauth-state.internal",
            httpClient: Cloudflare.toHttpClient(namespace.getByName(state)),
          }),
        ),
    }),
  );

  const clientFor = (state: Redacted.Redacted<string>) =>
    clients.pipe(Effect.flatMap((cache) => Cache.get(cache, Redacted.value(state))));

  const boundaryError =
    (operation: string) =>
    <A, R>(
      effect: Effect.Effect<
        A,
        OAuthError | HttpClientError.HttpClientError | Schema.SchemaError,
        R
      >,
    ): Effect.Effect<A, OAuthError, R> =>
      effect.pipe(
        Effect.catchTags({
          OAuthError: (error) => Effect.fail(error),
          HttpClientError: () => Effect.fail(new OAuthError({ operation, reason: "transport" })),
          SchemaError: () => Effect.fail(new OAuthError({ operation, reason: "invalid_response" })),
        }),
      );

  return OAuthStateClient.of({
    createAttempt: Effect.fn("OAuthStateClient.createAttempt")((input) =>
      clientFor(input.state).pipe(
        Effect.flatMap((client) => client.oauthState.createAttempt({ payload: input })),
        boundaryError("createAttempt"),
      ),
    ),
    consumeAttempt: Effect.fn("OAuthStateClient.consumeAttempt")((input) =>
      clientFor(input.state).pipe(
        Effect.flatMap((client) => client.oauthState.consumeAttempt({ payload: input })),
        boundaryError("consumeAttempt"),
      ),
    ),
  });
});

/** OAuth state clients preserve namespace and Worker execution requirements. */
export const oauthStateClientLayerWithoutDependencies = Layer.effect(
  OAuthStateClient,
  makeOAuthStateClient,
);

/** OAuth state client selects the native-storage HTTP Durable Object server. */
export const oauthStateClientLayer = oauthStateClientLayerWithoutDependencies.pipe(
  Layer.provide(oauthStateServerLayer),
);
