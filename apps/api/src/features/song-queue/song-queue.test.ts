import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import {
  IsoTimestamp,
  RedemptionId,
  SpotifyTrackId,
  ViewerId,
} from "@cf-twitch/contracts/identity";
import { ProviderError, type ProviderOperation } from "@cf-twitch/contracts/provider";
import {
  PendingSongRequest,
  RequestHistoryQuery,
  SongQueueLimit,
} from "@cf-twitch/contracts/song-queue";
import type { SpotifyPlayback, SpotifyTrack } from "@cf-twitch/contracts/spotify-track";
import { SpotifyService } from "../providers/spotify-service.ts";
import { SongQueue, songQueueTestLayer } from "./song-queue.ts";

const requestedTrack: SpotifyTrack = {
  id: SpotifyTrackId.make("requested"),
  name: "Requested",
  artists: ["Artist"],
  album: "Album",
  albumCoverUrl: Option.none(),
};

const request = PendingSongRequest.make({
  eventId: RedemptionId.make("redemption"),
  track: requestedTrack,
  requesterUserId: ViewerId.make("viewer"),
  requesterDisplayName: "Viewer",
  requestedAt: IsoTimestamp.make("1970-01-01T00:00:00.000Z"),
});

const unavailable = (operation: ProviderOperation) =>
  Effect.fail(
    new ProviderError({
      provider: "spotify",
      operation,
      reason: "not-configured",
      status: Option.none(),
      retryAfterMs: Option.none(),
    }),
  );

// Controlled Spotify playback: only playback observation is reachable from the song queue.
const controlledSpotify = (playback: Ref.Ref<SpotifyPlayback>) =>
  Layer.succeed(
    SpotifyService,
    SpotifyService.of({
      getPlayback: () => Ref.get(playback),
      getTrack: () => unavailable("getTrack"),
      getQueue: () => unavailable("getQueue"),
      getCurrentlyPlaying: () => unavailable("getCurrentlyPlaying"),
      addToQueue: () => unavailable("addToQueue"),
      skipTrack: () => unavailable("skipTrack"),
      getActiveDevice: () => unavailable("getActiveDevice"),
      getConnectState: () => unavailable("getConnectState"),
      removeFromQueue: () => unavailable("removeFromQueue"),
    }),
  );

describe("Song queue test Layer", () => {
  it.effect(
    "attributes a persisted Song Request and records it as played through the ISongQueue interface",
    () =>
      Effect.gen(function* () {
        const playback = yield* Ref.make<SpotifyPlayback>({
          currentlyPlaying: Option.none(),
          queue: [],
          isPlaying: false,
          progressMs: 0,
        });

        yield* Effect.gen(function* () {
          const queue = yield* SongQueue;
          yield* queue.persistRequest(request);
          yield* Ref.update(playback, (state) => ({ ...state, queue: [requestedTrack] }));

          expect(
            (yield* queue.getSongQueue({ limit: SongQueueLimit.make(10) })).tracks,
          ).toMatchObject([{ source: "user", eventId: request.eventId }]);

          yield* Ref.update(playback, (state) => ({
            ...state,
            currentlyPlaying: Option.some(requestedTrack),
            queue: [],
          }));
          yield* queue.refreshQueue();
          yield* Ref.update(playback, (state) => ({ ...state, currentlyPlaying: Option.none() }));
          yield* queue.refreshQueue();

          const history = yield* queue.getRequestHistory(
            RequestHistoryQuery.make({
              limit: SongQueueLimit.make(10),
              offset: 0,
              since: Option.none(),
              until: Option.none(),
            }),
          );

          expect(history.requests.map((item) => item.eventId)).toEqual([request.eventId]);
          expect(yield* queue.getUserRequestCount({ userId: request.requesterUserId })).toBe(1);
        }).pipe(
          Effect.provide(songQueueTestLayer.pipe(Layer.provide(controlledSpotify(playback)))),
        );
      }),
  );
});
