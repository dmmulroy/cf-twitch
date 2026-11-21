import {
  OAuthError,
  type ConsumeAuthorizationState,
  type OAuthAuthorizationAttempt,
  type OAuthOperation,
  type OAuthStateOutcome,
} from "@cf-twitch/contracts/oauth";
import type { OAuthProvider } from "@cf-twitch/contracts/provider";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Cache, Context, Effect, Layer, Option, Redacted, SynchronizedRef } from "effect";
import type { Schema } from "effect";
import type { HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { OAuthStateHttpApi } from "./oauth-state-http-api.ts";
import oauthStateServerLayer, { OAuthStateServer } from "./oauth-state-server.ts";
import {
  OAuthStateStore,
  oauthStateStoreTestLayer,
  type IOAuthStateStore,
} from "./oauth-state-store.ts";

/** Client of OAuth authorization state that addresses each random state value independently. */
export interface IOAuthStateClient {
  /**
   * Records a new authorization attempt under its state value.
   *
   * @returns Nothing, or fails with `OAuthError` when the attempt is rejected, storage fails (`persistence`), the state server is unreachable (`transport`) or its response cannot be decoded (`invalid-response`).
   */
  readonly createAttempt: (input: OAuthAuthorizationAttempt) => Effect.Effect<void, OAuthError>;
  /**
   * Consumes the attempt for a state value once.
   *
   * @returns The consumption outcome, or fails with `OAuthError` when storage fails (`persistence`), the state server is unreachable (`transport`) or its response cannot be decoded (`invalid-response`).
   */
  readonly consumeAttempt: (
    input: ConsumeAuthorizationState,
  ) => Effect.Effect<OAuthStateOutcome, OAuthError>;
}

/** Service that reaches OAuth state without exposing native Durable Object handles to HTTP routes. */
export class OAuthStateClient extends Context.Service<OAuthStateClient, IOAuthStateClient>()(
  "@cf-twitch/OAuthStateClient",
) {}

const translateOAuthStateClientFailure =
  (operation: OAuthOperation, provider: OAuthProvider) =>
  <A, R>(
    effect: Effect.Effect<A, OAuthError | HttpClientError.HttpClientError | Schema.SchemaError, R>,
  ): Effect.Effect<A, OAuthError, R> =>
    effect.pipe(
      Effect.catchTags({
        OAuthError: (error) => Effect.fail(error),
        HttpClientError: () =>
          Effect.fail(
            new OAuthError({ operation, reason: "transport", provider: Option.some(provider) }),
          ),
        SchemaError: () =>
          Effect.fail(
            new OAuthError({
              operation,
              reason: "invalid-response",
              provider: Option.some(provider),
            }),
          ),
      }),
    );

/**
 * Creates the OAuth state client over invocation-local HTTP clients for state Durable Objects.
 *
 * **Details**
 *
 * A bounded cache holds clients per state value within one Worker invocation; stubs never cross invocations.
 */
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

  return OAuthStateClient.of({
    createAttempt: Effect.fn("OAuthStateClient.createAttempt")((input) =>
      clientFor(input.state).pipe(
        Effect.flatMap((client) => client.oauthState.createAttempt({ payload: input })),
        translateOAuthStateClientFailure("createAttempt", input.provider),
      ),
    ),
    consumeAttempt: Effect.fn("OAuthStateClient.consumeAttempt")((input) =>
      clientFor(input.state).pipe(
        Effect.flatMap((client) => client.oauthState.consumeAttempt({ payload: input })),
        translateOAuthStateClientFailure("consumeAttempt", input.provider),
      ),
    ),
  });
});

/** Layer that provides the OAuth state client while leaving the state namespace and Worker execution requirements visible. */
export const oauthStateClientLayerWithoutDependencies = Layer.effect(
  OAuthStateClient,
  makeOAuthStateClient,
);

/** Production OAuth state client Layer that selects the native-storage HTTP Durable Object server. */
export const oauthStateClientLayer = oauthStateClientLayerWithoutDependencies.pipe(
  Layer.provide(oauthStateServerLayer),
);

/**
 * Layer that provides an in-memory OAuth state client with one isolated state store per state value.
 *
 * **Details**
 *
 * Mirrors production addressing, where each state value has its own Durable Object, using `oauthStateStoreTestLayer` for each store.
 */
export const oauthStateClientTestLayer = Layer.effect(
  OAuthStateClient,
  Effect.gen(function* () {
    const stores = yield* SynchronizedRef.make(new Map<string, IOAuthStateStore>());

    const storeFor = (state: Redacted.Redacted<string>) =>
      SynchronizedRef.modifyEffect(stores, (current) => {
        const key = Redacted.value(state);
        const existing = current.get(key);

        if (existing !== undefined) return Effect.succeed([existing, current] as const);

        return Effect.gen(function* () {
          return yield* OAuthStateStore;
        }).pipe(
          Effect.provide(oauthStateStoreTestLayer),
          Effect.map((created) => [created, new Map(current).set(key, created)] as const),
        );
      });

    return OAuthStateClient.of({
      createAttempt: Effect.fn("OAuthStateClientTest.createAttempt")((input) =>
        storeFor(input.state).pipe(Effect.flatMap((store) => store.createAttempt(input))),
      ),
      consumeAttempt: Effect.fn("OAuthStateClientTest.consumeAttempt")((input) =>
        storeFor(input.state).pipe(Effect.flatMap((store) => store.consumeAttempt(input))),
      ),
    });
  }),
);
