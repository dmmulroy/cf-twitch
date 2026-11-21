import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { SongQueueCoordinator } from "./song-queue-coordinator.ts";
import { SongQueueHttpApi } from "./song-queue-http-api.ts";

/** Layer that serves the `SongQueueDO` HTTP API by delegating parsed requests to the coordinator. */
export const songQueueHttpHandlersLayer = HttpApiBuilder.group(
  SongQueueHttpApi,
  "songQueue",
  (handlers) =>
    Effect.gen(function* () {
      const queue = yield* SongQueueCoordinator;

      return handlers
        .handle("persistRequest", ({ payload }) => queue.persistRequest(payload))
        .handle("deleteRequest", ({ payload }) => queue.deleteRequest(payload))
        .handle("getSongQueue", ({ payload }) => queue.getSongQueue(payload))
        .handle("getCurrentlyPlaying", () => queue.getCurrentlyPlaying())
        .handle("getRequestHistory", ({ payload }) => queue.getRequestHistory(payload))
        .handle("getUserRequestCount", ({ payload }) => queue.getUserRequestCount(payload))
        .handle("getUserRequestCountByDisplayName", ({ payload }) =>
          queue.getUserRequestCountByDisplayName(payload),
        )
        .handle("getSessionRequestCount", ({ payload }) => queue.getSessionRequestCount(payload))
        .handle("getTopTracks", ({ payload }) => queue.getTopTracks(payload))
        .handle("getTopTracksByUser", ({ payload }) => queue.getTopTracksByUser(payload))
        .handle("getTopRequesters", ({ payload }) => queue.getTopRequesters(payload))
        .handle("checkDuplicateRequest", ({ payload }) => queue.checkDuplicateRequest(payload))
        .handle("refreshQueue", () => queue.refreshQueue());
    }),
);
