import * as Cloudflare from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer, type Schema } from "effect";
import type { HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { SongQueueError } from "@cf-twitch/contracts/song-queue";
import { SongQueue } from "./song-queue.ts";
import { SongQueueHttpApi } from "./song-queue-http-api.ts";
import songQueueServerLayer, {
  SongQueueServer,
  songQueueSingletonKey,
} from "./song-queue-server.ts";

const clientFailure =
  (operation: string) =>
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
          Effect.fail(new SongQueueError({ operation, reason: "transport_unavailable" })),
        SchemaError: () =>
          Effect.fail(new SongQueueError({ operation, reason: "invalid_response" })),
      }),
    );

/** Construct the singleton song queue HTTP client without retaining invocation-scoped DO stubs. */
export const makeSongQueueClient = Effect.gen(function* () {
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
    persistRequest: Effect.fn("SongQueueClient.persistRequest")(function* (input) {
      return yield* (yield* client).songQueue.persistRequest({ payload: input });
    }, clientFailure("persistRequest")),
    deleteRequest: Effect.fn("SongQueueClient.deleteRequest")(function* (input) {
      return yield* (yield* client).songQueue.deleteRequest({ payload: input });
    }, clientFailure("deleteRequest")),
    getSongQueue: Effect.fn("SongQueueClient.getSongQueue")(function* (input) {
      return yield* (yield* client).songQueue.getSongQueue({ payload: input });
    }, clientFailure("getSongQueue")),
    getCurrentlyPlaying: Effect.fn("SongQueueClient.getCurrentlyPlaying")(function* () {
      return yield* (yield* client).songQueue.getCurrentlyPlaying();
    }, clientFailure("getCurrentlyPlaying")),
    getRequestHistory: Effect.fn("SongQueueClient.getRequestHistory")(function* (input) {
      return yield* (yield* client).songQueue.getRequestHistory({ payload: input });
    }, clientFailure("getRequestHistory")),
    getUserRequestCount: Effect.fn("SongQueueClient.getUserRequestCount")(function* (input) {
      return yield* (yield* client).songQueue.getUserRequestCount({ payload: input });
    }, clientFailure("getUserRequestCount")),
    getUserRequestCountByDisplayName: Effect.fn("SongQueueClient.getUserRequestCountByDisplayName")(
      function* (input) {
        return yield* (yield* client).songQueue.getUserRequestCountByDisplayName({
          payload: input,
        });
      },
      clientFailure("getUserRequestCountByDisplayName"),
    ),
    getSessionRequestCount: Effect.fn("SongQueueClient.getSessionRequestCount")(function* (input) {
      return yield* (yield* client).songQueue.getSessionRequestCount({ payload: input });
    }, clientFailure("getSessionRequestCount")),
    getTopTracks: Effect.fn("SongQueueClient.getTopTracks")(function* (input) {
      return yield* (yield* client).songQueue.getTopTracks({ payload: input });
    }, clientFailure("getTopTracks")),
    getTopTracksByUser: Effect.fn("SongQueueClient.getTopTracksByUser")(function* (input) {
      return yield* (yield* client).songQueue.getTopTracksByUser({ payload: input });
    }, clientFailure("getTopTracksByUser")),
    getTopRequesters: Effect.fn("SongQueueClient.getTopRequesters")(function* (input) {
      return yield* (yield* client).songQueue.getTopRequesters({ payload: input });
    }, clientFailure("getTopRequesters")),
    checkDuplicateRequest: Effect.fn("SongQueueClient.checkDuplicateRequest")(function* (input) {
      return yield* (yield* client).songQueue.checkDuplicateRequest({ payload: input });
    }, clientFailure("checkDuplicateRequest")),
    refreshQueue: Effect.fn("SongQueueClient.refreshQueue")(function* () {
      return yield* (yield* client).songQueue.refreshQueue();
    }, clientFailure("refreshQueue")),
  });
});

/** Song queue HTTP client leaves namespace selection visible to the root. */
export const songQueueClientLayerWithoutDependencies = Layer.effect(SongQueue, makeSongQueueClient);

/** Ready song queue client selects its HTTP Durable Object server implementation. */
export const songQueueClientLayer = songQueueClientLayerWithoutDependencies.pipe(
  Layer.provide(songQueueServerLayer),
);
