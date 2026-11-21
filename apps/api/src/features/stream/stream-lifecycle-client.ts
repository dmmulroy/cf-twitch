import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Context, Effect, Layer, Option, type Schema } from "effect";
import type { HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type { StreamId } from "@cf-twitch/contracts/identity";
import {
  STREAM_LIFECYCLE_SINGLETON_KEY,
  StreamLifecycleError,
  type MarkStreamOfflineInput,
  type MarkStreamOnlineInput,
  type RecordViewerCountInput,
  type StreamLifecycleDebugState,
  type StreamLifecycleOperation,
  type StreamLifecycleState,
  type StreamLifecycleStatus,
  type StreamProviderState,
  type StreamReconciliationResult,
  type ViewerHistory,
  type ViewerHistoryInput,
} from "@cf-twitch/contracts/stream";
import { StreamLifecycleHttpApi } from "./stream-http-api.ts";
import { StreamLifecycle, streamLifecycleTestLayer } from "./stream-lifecycle.ts";
import streamLifecycleServerLayer, { StreamLifecycleServer } from "./stream-server.ts";

/**
 * Stream Lifecycle operations shared by EventSub dispatch, the Worker, and debug handlers.
 *
 * **Details**
 *
 * Transitions are ordered by source time, so duplicate or stale evidence is ignored and retrying
 * the same request resumes its saved transition checkpoint instead of repeating effects.
 */
export interface IStreamLifecycleClient {
  /**
   * Returns the current Stream Lifecycle State.
   *
   * @returns The state, or fails with `StreamLifecycleError` when storage or transport fails.
   */
  readonly getState: () => Effect.Effect<StreamLifecycleState, StreamLifecycleError>;
  /**
   * Accepts authoritative online evidence and runs the transition's durable effects.
   *
   * @returns The resulting state, or fails with `StreamLifecycleError` whose reason is
   *   `effects_pending` when the transition was saved but an effect has not completed yet.
   */
  readonly markOnline: (
    input: MarkStreamOnlineInput,
  ) => Effect.Effect<StreamLifecycleState, StreamLifecycleError>;
  /**
   * Accepts authoritative offline evidence and runs the transition's durable effects.
   *
   * @returns The resulting state, or fails with `StreamLifecycleError` whose reason is
   *   `effects_pending` when the transition was saved but an effect has not completed yet.
   */
  readonly markOffline: (
    input: MarkStreamOfflineInput,
  ) => Effect.Effect<StreamLifecycleState, StreamLifecycleError>;
  /**
   * Records one viewer-count observation and raises the peak when exceeded.
   *
   * @returns Nothing, or fails with `StreamLifecycleError` when storage or transport fails.
   */
  readonly recordViewerCount: (
    input: RecordViewerCountInput,
  ) => Effect.Effect<void, StreamLifecycleError>;
  /**
   * Returns a page of viewer-count observations, oldest first.
   *
   * @returns The page, or fails with `StreamLifecycleError` when storage or transport fails.
   */
  readonly getViewerHistory: (
    input: ViewerHistoryInput,
  ) => Effect.Effect<ViewerHistory, StreamLifecycleError>;
  /**
   * Reconciles Twitch provider evidence with the durable state, marking transitions as needed.
   *
   * @returns The action taken with the before and after states, or fails with
   *   `StreamLifecycleError` when a transition's effects remain pending or storage fails.
   */
  readonly reconcile: (
    input: StreamProviderState,
  ) => Effect.Effect<StreamReconciliationResult, StreamLifecycleError>;
  /**
   * Returns readiness and whether transition effects are pending.
   *
   * @returns The status, or fails with `StreamLifecycleError` when storage or transport fails.
   */
  readonly getStatus: () => Effect.Effect<StreamLifecycleStatus, StreamLifecycleError>;
  /**
   * Returns persistence and pending-effect diagnostics.
   *
   * @returns The diagnostics, or fails with `StreamLifecycleError` when storage or transport fails.
   */
  readonly getDebugState: () => Effect.Effect<StreamLifecycleDebugState, StreamLifecycleError>;
  /**
   * Deletes viewer history, restores the initial offline state, and clears the alarm.
   *
   * @returns Nothing, or fails with `StreamLifecycleError` when storage, the alarm, or transport
   *   fails.
   */
  readonly reset: () => Effect.Effect<void, StreamLifecycleError>;
}

/** Service for Stream Lifecycle, backed by the preserved `stream-lifecycle` singleton Durable Object. */
export class StreamLifecycleClient extends Context.Service<
  StreamLifecycleClient,
  IStreamLifecycleClient
>()("@cf-twitch/StreamLifecycleClient") {}

/** Returns a transform that classifies Stream Lifecycle HTTP client failures for one operation. */
const streamLifecycleClientFailure =
  (operation: StreamLifecycleOperation, streamId: Option.Option<StreamId>) =>
  <A, R>(
    effect: Effect.Effect<
      A,
      StreamLifecycleError | HttpClientError.HttpClientError | Schema.SchemaError,
      R
    >,
  ): Effect.Effect<A, StreamLifecycleError, R> =>
    effect.pipe(
      Effect.catchTags({
        StreamLifecycleError: (error) => Effect.fail(error),
        HttpClientError: () =>
          Effect.fail(
            new StreamLifecycleError({ operation, reason: "transport_unavailable", streamId }),
          ),
        SchemaError: () =>
          Effect.fail(
            new StreamLifecycleError({ operation, reason: "invalid_response", streamId }),
          ),
      }),
    );

/**
 * Creates the Stream Lifecycle HTTP client for the `stream-lifecycle` singleton Durable Object.
 *
 * **Details**
 *
 * The client is memoized per Alchemy execution, so namespace stubs never outlive their invocation.
 *
 * @returns The client; each operation fails with `StreamLifecycleError` whose reason is
 *   `transport_unavailable` when the Durable Object is unreachable and `invalid_response` when its
 *   response does not decode.
 */
export const makeStreamLifecycleClient = Effect.gen(function* () {
  const namespace = yield* StreamLifecycleServer;

  const client = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(StreamLifecycleHttpApi, {
        baseUrl: "http://stream-lifecycle.internal",
        httpClient: Cloudflare.toHttpClient(namespace.getByName(STREAM_LIFECYCLE_SINGLETON_KEY)),
      }),
    ),
  );

  return StreamLifecycleClient.of({
    getState: Effect.fn("StreamLifecycleClient.getState")(
      function* () {
        return yield* (yield* client).streamLifecycle.getState();
      },
      streamLifecycleClientFailure("getState", Option.none()),
    ),
    markOnline: Effect.fn("StreamLifecycleClient.markOnline")(
      function* (input) {
        return yield* (yield* client).streamLifecycle.markOnline({ payload: input });
      },
      (effect, input) =>
        effect.pipe(streamLifecycleClientFailure("markOnline", Option.some(input.streamId))),
    ),
    markOffline: Effect.fn("StreamLifecycleClient.markOffline")(
      function* (input) {
        return yield* (yield* client).streamLifecycle.markOffline({ payload: input });
      },
      streamLifecycleClientFailure("markOffline", Option.none()),
    ),
    recordViewerCount: Effect.fn("StreamLifecycleClient.recordViewerCount")(
      function* (input) {
        yield* (yield* client).streamLifecycle.recordViewerCount({ payload: input });
      },
      streamLifecycleClientFailure("recordViewerCount", Option.none()),
    ),
    getViewerHistory: Effect.fn("StreamLifecycleClient.getViewerHistory")(
      function* (input) {
        return yield* (yield* client).streamLifecycle.getViewerHistory({ payload: input });
      },
      streamLifecycleClientFailure("getViewerHistory", Option.none()),
    ),
    reconcile: Effect.fn("StreamLifecycleClient.reconcile")(
      function* (input) {
        return yield* (yield* client).streamLifecycle.reconcile({ payload: input });
      },
      (effect, input) =>
        effect.pipe(
          streamLifecycleClientFailure(
            "reconcile",
            Option.map(input.stream, (stream) => stream.id),
          ),
        ),
    ),
    getStatus: Effect.fn("StreamLifecycleClient.getStatus")(
      function* () {
        return yield* (yield* client).streamLifecycle.getStatus();
      },
      streamLifecycleClientFailure("getStatus", Option.none()),
    ),
    getDebugState: Effect.fn("StreamLifecycleClient.getDebugState")(
      function* () {
        return yield* (yield* client).streamLifecycle.getDebugState();
      },
      streamLifecycleClientFailure("getDebugState", Option.none()),
    ),
    reset: Effect.fn("StreamLifecycleClient.reset")(
      function* () {
        yield* (yield* client).streamLifecycle.reset();
      },
      streamLifecycleClientFailure("reset", Option.none()),
    ),
  });
});

/** Layer that provides the Stream Lifecycle HTTP client, leaving the `StreamLifecycleDO` namespace visible. */
export const streamLifecycleClientLayerWithoutDependencies = Layer.effect(
  StreamLifecycleClient,
  makeStreamLifecycleClient,
);

/** Layer that provides the Stream Lifecycle HTTP client over the production `StreamLifecycleDO` server. */
export const streamLifecycleClientLayer = streamLifecycleClientLayerWithoutDependencies.pipe(
  Layer.provide(streamLifecycleServerLayer),
);

/**
 * Layer that provides the Stream Lifecycle client directly from the in-memory Stream Lifecycle.
 *
 * **Details**
 *
 * Crosses the same `IStreamLifecycleClient` interface as the HTTP client without a Durable Object
 * hop. Provider tokens, event publication, and the digest stay visible for each test to select.
 */
export const streamLifecycleClientTestLayer = Layer.effect(
  StreamLifecycleClient,
  Effect.gen(function* () {
    const lifecycle = yield* StreamLifecycle;

    return StreamLifecycleClient.of(lifecycle);
  }),
).pipe(Layer.provide(streamLifecycleTestLayer));
