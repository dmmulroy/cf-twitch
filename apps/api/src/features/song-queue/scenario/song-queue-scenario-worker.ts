import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { SpotifyTrackId } from "@cf-twitch/contracts/identity";
import { ProviderError, type SpotifyConnectState } from "@cf-twitch/contracts/provider";
import type { SpotifyPlayback, SpotifyTrack } from "@cf-twitch/contracts/spotify-track";
import { Effect, Layer, Option, Ref } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { cloudflareHttpServerLayer } from "../../../runtime/cloudflare-http-server.ts";
import { SpotifyService } from "../../providers/spotify-service.ts";
import { SongQueue } from "../song-queue.ts";
import { songQueueClientLayerWithoutDependencies } from "../song-queue-client.ts";
import { SongQueueHttpApi } from "../song-queue-http-api.ts";
import { songQueueHttpHandlersLayer } from "../song-queue-http-handlers.ts";
import {
  songQueueServerLayerWithoutDependencies,
  type SongQueueServer,
} from "../song-queue-server.ts";

const localTrack: SpotifyTrack = {
  id: SpotifyTrackId.make("localtrack"),
  name: "Local track",
  artists: ["Local artist"],
  album: "Local album",
  albumCoverUrl: Option.none(),
};

// A complete, process-local Spotify model supplies the real provider interface. There is
// no reachable external HTTP client, token namespace, secret configuration or production resource.
const localSpotifyLayer = Layer.effect(
  SpotifyService,
  Effect.gen(function* () {
    const playback = yield* Ref.make<SpotifyPlayback>({
      currentlyPlaying: Option.none(),
      queue: [localTrack, localTrack],
      isPlaying: false,
      progressMs: 0,
    });
    const getTrack = Effect.fn("LocalSpotify.getTrack")(
      (id: SpotifyTrackId): Effect.Effect<SpotifyTrack, ProviderError> =>
        id === localTrack.id
          ? Effect.succeed(localTrack)
          : Effect.fail(
              new ProviderError({
                provider: "spotify",
                operation: "getTrack",
                kind: "not-found",
                status: 404,
                retryAfterMs: Option.none(),
              }),
            ),
    );
    const connectState = (state: SpotifyPlayback): SpotifyConnectState => ({
      timestamp: "0",
      context_uri: "local:queue",
      queue_revision: String(state.queue.length),
      next_tracks: state.queue.map((track, index) => ({
        uri: `spotify:track:${track.id}`,
        uid: String(index),
        metadata: { title: track.name },
        provider: "queue",
      })),
      prev_tracks: [],
    });
    return SpotifyService.of({
      getTrack,
      getPlayback: Effect.fn("LocalSpotify.getPlayback")(() => Ref.get(playback)),
      getQueue: Effect.fn("LocalSpotify.getQueue")(() =>
        Ref.get(playback).pipe(
          Effect.map((state) => ({ currentlyPlaying: state.currentlyPlaying, queue: state.queue })),
        ),
      ),
      getCurrentlyPlaying: Effect.fn("LocalSpotify.getCurrentlyPlaying")(() =>
        Ref.get(playback).pipe(Effect.map((state) => state.currentlyPlaying)),
      ),
      addToQueue: Effect.fn("LocalSpotify.addToQueue")(function* (id) {
        const track = yield* getTrack(id);
        yield* Ref.update(playback, (state) => ({ ...state, queue: [...state.queue, track] }));
      }),
      skipTrack: Effect.fn("LocalSpotify.skipTrack")(() =>
        Ref.update(playback, (state) => ({
          ...state,
          currentlyPlaying: Option.fromUndefinedOr(state.queue[0]),
          queue: state.queue.slice(1),
          isPlaying: state.queue.length > 0,
          progressMs: 0,
        })),
      ),
      getActiveDevice: Effect.fn("LocalSpotify.getActiveDevice")(() =>
        Effect.succeed(
          Option.some({
            id: "local-device",
            name: "Local device",
            type: "Computer",
            isActive: true,
          }),
        ),
      ),
      getConnectState: Effect.fn("LocalSpotify.getConnectState")(() =>
        Ref.get(playback).pipe(Effect.map(connectState)),
      ),
      removeFromQueue: Effect.fn("LocalSpotify.removeFromQueue")((id) =>
        Ref.update(playback, (state) => ({
          ...state,
          queue: state.queue.filter((track) => track.id !== id),
        })).pipe(Effect.as(true)),
      ),
    });
  }),
);

type SongQueueScenarioWorkerContract = { readonly fetch: HttpEffect };
/** Scratch-only scenario Worker exercises the real song queue HTTP namespace client. */
export class SongQueueScenarioWorker extends Cloudflare.Worker<
  SongQueueScenarioWorker,
  SongQueueScenarioWorkerContract,
  SongQueueServer
>()("CfTwitchSongQueueScenarioWorker") {}

/** Local workerd graph overrides the provider at the outer init binding boundary. */
export const songQueueScenarioWorkerLayer = SongQueueScenarioWorker.make(
  {
    main: import.meta.url,
    compatibility: { date: "2026-01-13", flags: ["nodejs_compat"] },
    dev: { host: "127.0.0.1", port: 8797, strictPort: true },
  },
  Effect.gen(function* () {
    const queue = yield* SongQueue;
    const httpLayer = HttpApiBuilder.layer(SongQueueHttpApi).pipe(
      Layer.provide(
        songQueueHttpHandlersLayer.pipe(Layer.provide(Layer.succeed(SongQueue, queue))),
      ),
      Layer.provide(cloudflareHttpServerLayer),
    );
    const router = yield* makeExecutionMemo(HttpRouter.toHttpEffect(httpLayer));
    const fetch: HttpEffect = Effect.gen(function* () {
      return yield* yield* router;
    });
    return { fetch };
  }).pipe(
    Effect.provide(
      songQueueClientLayerWithoutDependencies.pipe(
        Layer.provide(
          songQueueServerLayerWithoutDependencies.pipe(Layer.provide(localSpotifyLayer)),
        ),
      ),
    ),
  ),
);

/** Scratch scenario output contains only the local Worker URL. */
export const songQueueScenarioStack = Effect.gen(function* () {
  const worker = yield* SongQueueScenarioWorker;
  return { url: worker.url };
}).pipe(Effect.provide(songQueueScenarioWorkerLayer));

export default songQueueScenarioWorkerLayer;
