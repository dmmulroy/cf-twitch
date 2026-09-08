import * as Cloudflare from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer, type Schema } from "effect";
import type { HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { STREAM_LIFECYCLE_SINGLETON_KEY, StreamLifecycleError } from "@cf-twitch/contracts/stream";
import { StreamLifecycleHttpApi } from "./stream-http-api.ts";
import { StreamLifecycleClient, type IStreamLifecycleClient } from "./stream-lifecycle.ts";
export { StreamLifecycleClient, type IStreamLifecycleClient } from "./stream-lifecycle.ts";
import streamLifecycleServerLayer, { StreamLifecycleServer } from "./stream-server.ts";

const clientError = (
  operation: StreamLifecycleError["operation"],
  reason: "invalid_response" | "persistence_unavailable",
) => new StreamLifecycleError({ operation, reason });

const mapClientErrors = <A>(
  operation: StreamLifecycleError["operation"],
  effect: Effect.Effect<
    A,
    StreamLifecycleError | HttpClientError.HttpClientError | Schema.SchemaError
  >,
): Effect.Effect<A, StreamLifecycleError> =>
  effect.pipe(
    Effect.catchTags({
      StreamLifecycleError: (error) => Effect.fail(error),
      HttpClientError: () => Effect.fail(clientError(operation, "persistence_unavailable")),
      SchemaError: () => Effect.fail(clientError(operation, "invalid_response")),
    }),
  );

/** Construct an invocation-scoped HTTP client for the Stream Lifecycle singleton. */
export const makeStreamLifecycleClient: Effect.Effect<
  IStreamLifecycleClient,
  never,
  Cloudflare.Worker | StreamLifecycleServer
> = Effect.gen(function* () {
  const namespace = yield* StreamLifecycleServer;
  const memoizedClient = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(StreamLifecycleHttpApi, {
        baseUrl: "http://stream-lifecycle.internal",
        httpClient: Cloudflare.toHttpClient(namespace.getByName(STREAM_LIFECYCLE_SINGLETON_KEY)),
      }),
    ),
  );
  const client = memoizedClient;

  return StreamLifecycleClient.of({
    getState: () =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("getState", http.streamLifecycle.getState()),
      ),
    markOnline: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("markOnline", http.streamLifecycle.markOnline({ payload: input })),
      ),
    markOffline: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("markOffline", http.streamLifecycle.markOffline({ payload: input })),
      ),
    recordViewerCount: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors(
          "recordViewerCount",
          http.streamLifecycle.recordViewerCount({ payload: input }),
        ).pipe(Effect.asVoid),
      ),
    getViewerHistory: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors(
          "getViewerHistory",
          http.streamLifecycle.getViewerHistory({ payload: input }),
        ),
      ),
    reconcile: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("reconcile", http.streamLifecycle.reconcile({ payload: input })),
      ),
    getStatus: () =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("getStatus", http.streamLifecycle.getStatus()),
      ),
    getDebugState: () =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("getDebugState", http.streamLifecycle.getDebugState()),
      ),
    reset: () =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("reset", http.streamLifecycle.reset()).pipe(Effect.asVoid),
      ),
  });
});

/** Client Layer retaining its StreamLifecycleServer binding requirement. */
export const streamLifecycleClientLayerWithoutDependencies = Layer.effect(
  StreamLifecycleClient,
  makeStreamLifecycleClient,
);

/** Production client Layer selecting the preserved StreamLifecycleDO namespace. */
export const streamLifecycleClientLayer = streamLifecycleClientLayerWithoutDependencies.pipe(
  Layer.provide(streamLifecycleServerLayer),
);
