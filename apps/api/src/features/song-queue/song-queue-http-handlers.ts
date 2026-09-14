import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { SongQueue } from "./song-queue.ts";
import { SongQueueHttpApi } from "./song-queue-http-api.ts";

/** Song queue HTTP handlers delegate parsed requests to the instance-local application service. */
export const songQueueHttpHandlersLayer = HttpApiBuilder.group(
  SongQueueHttpApi,
  "songQueue",
  (handlers) =>
    Effect.gen(function* () {
      const queue = yield* SongQueue;

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
