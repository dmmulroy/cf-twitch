import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Context, Effect, Layer, Option, type Schema } from "effect";
import type { HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type { RedemptionId } from "@cf-twitch/contracts/identity";
import {
  SongQueueError,
  type NowPlaying,
  type PendingSongRequest,
  type RequestHistoryQuery,
  type RequestHistoryResult,
  type SongQueueDisplayNameInput,
  type SongQueueDuplicateInput,
  type SongQueueLimitInput,
  type SongQueueOperation,
  type SongQueueResult,
  type SongQueueSessionInput,
  type SongQueueViewerInput,
  type SongQueueViewerTracksInput,
  type SongRequestIdentityInput,
  type TopRequestedTrack,
  type TopSongRequester,
} from "@cf-twitch/contracts/song-queue";
import { SongQueueCoordinator, songQueueCoordinatorTestLayer } from "./song-queue-coordinator.ts";
import { SongQueueHttpApi } from "./song-queue-http-api.ts";
import songQueueServerLayer, {
  SongQueueServer,
  songQueueSingletonKey,
} from "./song-queue-server.ts";

/**
 * Song queue operations shared by workflows, chat commands, and public HTTP handlers.
 *
 * **Details**
 *
 * The song queue owns Queue Occurrence attribution, Request History, and durable Spotify refresh.
 * Every write is idempotent by redemption ID, so callers may retry a failed write.
 */
export interface ISongQueue {
  /**
   * Persists an accepted Song Request before its Spotify queue mutation.
   *
   * @returns Nothing, or fails with `SongQueueError` when storage, alarm scheduling, or transport
   *   fails; a redelivered or compensated redemption ID is ignored.
   */
  readonly persistRequest: (input: PendingSongRequest) => Effect.Effect<void, SongQueueError>;
  /**
   * Removes a Pending Request and leaves a tombstone so a late replay cannot restore it.
   *
   * @returns Nothing, or fails with `SongQueueError` when storage, alarm scheduling, or transport
   *   fails.
   */
  readonly deleteRequest: (
    input: typeof SongRequestIdentityInput.Type,
  ) => Effect.Effect<void, SongQueueError>;
  /**
   * Returns upcoming Queue Occurrences with requested tracks in FIFO order before autoplay.
   *
   * @returns The bounded queue page and its total count, or fails with `SongQueueError` when
   *   storage or transport fails; a failed Spotify refresh falls back to the last saved snapshot.
   */
  readonly getSongQueue: (
    input: typeof SongQueueLimitInput.Type,
  ) => Effect.Effect<SongQueueResult, SongQueueError>;
  /**
   * Returns the Now Playing Queue Occurrence, with Viewer attribution when known.
   *
   * @returns The current occurrence or none, or fails with `SongQueueError` when storage or
   *   transport fails; a failed Spotify refresh falls back to the last saved snapshot.
   */
  readonly getCurrentlyPlaying: () => Effect.Effect<NowPlaying, SongQueueError>;
  /**
   * Returns a page of Request History, newest playback departure first.
   *
   * @returns The history page and total match count, or fails with `SongQueueError` when storage
   *   or transport fails or stored rows are invalid.
   */
  readonly getRequestHistory: (
    input: RequestHistoryQuery,
  ) => Effect.Effect<RequestHistoryResult, SongQueueError>;
  /**
   * Returns how many of a Viewer's Song Requests were confirmed as played.
   *
   * @returns The played request count, or fails with `SongQueueError` when storage or transport
   *   fails.
   */
  readonly getUserRequestCount: (
    input: typeof SongQueueViewerInput.Type,
  ) => Effect.Effect<number, SongQueueError>;
  /**
   * Returns how many played Song Requests were recorded under an exact display name.
   *
   * @returns The played request count, or fails with `SongQueueError` when storage or transport
   *   fails.
   */
  readonly getUserRequestCountByDisplayName: (
    input: typeof SongQueueDisplayNameInput.Type,
  ) => Effect.Effect<number, SongQueueError>;
  /**
   * Returns how many Song Requests left playback at or after a Stream Session start.
   *
   * @returns The played request count, or fails with `SongQueueError` when storage or transport
   *   fails.
   */
  readonly getSessionRequestCount: (
    input: typeof SongQueueSessionInput.Type,
  ) => Effect.Effect<number, SongQueueError>;
  /**
   * Returns the most played requested Spotify Tracks with their latest played metadata.
   *
   * @returns Tracks ordered by play count, or fails with `SongQueueError` when storage or
   *   transport fails or stored rows are invalid.
   */
  readonly getTopTracks: (
    input: typeof SongQueueLimitInput.Type,
  ) => Effect.Effect<readonly TopRequestedTrack[], SongQueueError>;
  /**
   * Returns one Viewer's most played requested Spotify Tracks.
   *
   * @returns Tracks ordered by play count, or fails with `SongQueueError` when storage or
   *   transport fails or stored rows are invalid.
   */
  readonly getTopTracksByUser: (
    input: typeof SongQueueViewerTracksInput.Type,
  ) => Effect.Effect<readonly TopRequestedTrack[], SongQueueError>;
  /**
   * Returns the Viewers with the most played Song Requests, using their latest display names.
   *
   * @returns Viewers ordered by play count, or fails with `SongQueueError` when storage or
   *   transport fails or stored rows are invalid.
   */
  readonly getTopRequesters: (
    input: typeof SongQueueLimitInput.Type,
  ) => Effect.Effect<readonly TopSongRequester[], SongQueueError>;
  /**
   * Returns whether a Viewer requested the same Spotify Track inside the duplicate window.
   *
   * @returns `true` when a pending or played request matches, or fails with `SongQueueError` when
   *   storage or transport fails.
   */
  readonly checkDuplicateRequest: (
    input: typeof SongQueueDuplicateInput.Type,
  ) => Effect.Effect<boolean, SongQueueError>;
  /**
   * Forces Spotify reconciliation of the saved snapshot; never retries a Spotify mutation.
   *
   * @returns Nothing, or fails with `SongQueueError` whose reason is `provider_unavailable` when
   *   Spotify playback cannot be read, after persisting backoff, or another reason when storage,
   *   alarm scheduling, or transport fails.
   */
  readonly refreshQueue: () => Effect.Effect<void, SongQueueError>;
}

/** Service for the application song queue, backed by the `song-queue` Durable Object. */
export class SongQueue extends Context.Service<SongQueue, ISongQueue>()("@cf-twitch/SongQueue") {}

/** Returns a transform that classifies song queue HTTP client failures for one operation. */
const songQueueClientFailure =
  (operation: SongQueueOperation, eventId: Option.Option<RedemptionId>) =>
  <A, R>(
    effect: Effect.Effect<
      A,
      SongQueueError | HttpClientError.HttpClientError | Schema.SchemaError,
      R
    >,
  ): Effect.Effect<A, SongQueueError, R> =>
    effect.pipe(
      Effect.catchTags({
        SongQueueError: (error) => Effect.fail(error),
        HttpClientError: () =>
          Effect.fail(new SongQueueError({ operation, reason: "transport_unavailable", eventId })),
        SchemaError: () =>
          Effect.fail(new SongQueueError({ operation, reason: "invalid_response", eventId })),
      }),
    );

/**
 * Creates the song queue HTTP client for the singleton `song-queue` Durable Object.
 *
 * **Details**
 *
 * The client is memoized per Alchemy execution, so namespace stubs never outlive their invocation.
 *
 * @returns The song queue service; each operation fails with `SongQueueError` whose reason is
 *   `transport_unavailable` when the Durable Object is unreachable and `invalid_response` when its
 *   response does not decode.
 */
export const makeSongQueue = Effect.gen(function* () {
  const namespace = yield* SongQueueServer;

  const client = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(SongQueueHttpApi, {
        baseUrl: "http://song-queue.internal",
        httpClient: Cloudflare.toHttpClient(namespace.getByName(songQueueSingletonKey)),
      }),
    ),
  );

  return SongQueue.of({
    persistRequest: Effect.fn("SongQueue.persistRequest")(
      function* (input) {
        return yield* (yield* client).songQueue.persistRequest({ payload: input });
      },
      (effect, input) =>
        effect.pipe(songQueueClientFailure("persistRequest", Option.some(input.eventId))),
    ),
    deleteRequest: Effect.fn("SongQueue.deleteRequest")(
      function* (input) {
        return yield* (yield* client).songQueue.deleteRequest({ payload: input });
      },
      (effect, input) =>
        effect.pipe(songQueueClientFailure("deleteRequest", Option.some(input.eventId))),
    ),
    getSongQueue: Effect.fn("SongQueue.getSongQueue")(
      function* (input) {
        return yield* (yield* client).songQueue.getSongQueue({ payload: input });
      },
      songQueueClientFailure("getSongQueue", Option.none()),
    ),
    getCurrentlyPlaying: Effect.fn("SongQueue.getCurrentlyPlaying")(
      function* () {
        return yield* (yield* client).songQueue.getCurrentlyPlaying();
      },
      songQueueClientFailure("getCurrentlyPlaying", Option.none()),
    ),
    getRequestHistory: Effect.fn("SongQueue.getRequestHistory")(
      function* (input) {
        return yield* (yield* client).songQueue.getRequestHistory({ payload: input });
      },
      songQueueClientFailure("getRequestHistory", Option.none()),
    ),
    getUserRequestCount: Effect.fn("SongQueue.getUserRequestCount")(
      function* (input) {
        return yield* (yield* client).songQueue.getUserRequestCount({ payload: input });
      },
      songQueueClientFailure("getUserRequestCount", Option.none()),
    ),
    getUserRequestCountByDisplayName: Effect.fn("SongQueue.getUserRequestCountByDisplayName")(
      function* (input) {
        return yield* (yield* client).songQueue.getUserRequestCountByDisplayName({
          payload: input,
        });
      },
      songQueueClientFailure("getUserRequestCountByDisplayName", Option.none()),
    ),
    getSessionRequestCount: Effect.fn("SongQueue.getSessionRequestCount")(
      function* (input) {
        return yield* (yield* client).songQueue.getSessionRequestCount({ payload: input });
      },
      songQueueClientFailure("getSessionRequestCount", Option.none()),
    ),
    getTopTracks: Effect.fn("SongQueue.getTopTracks")(
      function* (input) {
        return yield* (yield* client).songQueue.getTopTracks({ payload: input });
      },
      songQueueClientFailure("getTopTracks", Option.none()),
    ),
    getTopTracksByUser: Effect.fn("SongQueue.getTopTracksByUser")(
      function* (input) {
        return yield* (yield* client).songQueue.getTopTracksByUser({ payload: input });
      },
      songQueueClientFailure("getTopTracksByUser", Option.none()),
    ),
    getTopRequesters: Effect.fn("SongQueue.getTopRequesters")(
      function* (input) {
        return yield* (yield* client).songQueue.getTopRequesters({ payload: input });
      },
      songQueueClientFailure("getTopRequesters", Option.none()),
    ),
    checkDuplicateRequest: Effect.fn("SongQueue.checkDuplicateRequest")(
      function* (input) {
        return yield* (yield* client).songQueue.checkDuplicateRequest({ payload: input });
      },
      songQueueClientFailure("checkDuplicateRequest", Option.none()),
    ),
    refreshQueue: Effect.fn("SongQueue.refreshQueue")(
      function* () {
        return yield* (yield* client).songQueue.refreshQueue();
      },
      songQueueClientFailure("refreshQueue", Option.none()),
    ),
  });
});

/** Layer that provides the song queue HTTP client, leaving the `SongQueueDO` namespace visible. */
export const songQueueLayerWithoutDependencies = Layer.effect(SongQueue, makeSongQueue);

/** Layer that provides the song queue HTTP client over the production `SongQueueDO` server. */
export const songQueueLayer = songQueueLayerWithoutDependencies.pipe(
  Layer.provide(songQueueServerLayer),
);

/**
 * Layer that provides the song queue directly from the in-memory song queue coordinator.
 *
 * **Details**
 *
 * Crosses the same `ISongQueue` interface as the HTTP client without a Durable Object hop. The
 * Spotify provider stays a visible requirement so each test selects a controlled provider.
 */
export const songQueueTestLayer = Layer.effect(
  SongQueue,
  Effect.gen(function* () {
    const coordinator = yield* SongQueueCoordinator;

    return SongQueue.of(coordinator);
  }),
).pipe(Layer.provide(songQueueCoordinatorTestLayer));
