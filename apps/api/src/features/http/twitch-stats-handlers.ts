import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import {
  TwitchHttpApi,
  TwitchStatsViewerId,
  TwitchTopRequestersResponse,
  TwitchRaffleViewerResponse,
} from "@cf-twitch/contracts/twitch-api";
import { TopRequestedTrack, type SongQueueError } from "@cf-twitch/contracts/song-queue";
import { type RaffleError } from "@cf-twitch/contracts/raffle";
import { SongQueue } from "../song-queue/song-queue.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { HttpResponseCache } from "./http-response-cache.ts";
import {
  HttpBoundaryError,
  encodeHttpResponse,
  parseHttpLeaderboardQuery,
  parseHttpSongQueueQuery,
  rejectHttpQueryParameters,
  handleHttpBoundary,
} from "./http-boundary.ts";

const parseViewerId = Schema.decodeEffect(TwitchStatsViewerId);
const topTracks = Schema.Array(TopRequestedTrack);
const topRequesters = TwitchTopRequestersResponse;
const raffleLeaderboard = Schema.Array(TwitchRaffleViewerResponse);
const invalidRequest = () =>
  new HttpBoundaryError({ status: 400, error: "Invalid request parameters" });
const statsFailure = (failure: SongQueueError | RaffleError) => {
  switch (failure.reason) {
    case "invalid_response":
      return new HttpBoundaryError({ status: 502, error: "Invalid service response" });
    case "storage_unavailable":
    case "provider_unavailable":
    case "coordination_unavailable":
    case "transport_unavailable":
    case "persistence_unavailable":
      return new HttpBoundaryError({ status: 503, error: "Service temporarily unavailable" });
    default:
      return new HttpBoundaryError({ status: 500, error: "Failed to fetch statistics" });
  }
};
const renderFailure = handleHttpBoundary;
const withCacheHeader = HttpServerResponse.setHeader("Cache-Control", "public, max-age=60");

/** Statistics share canonical cache entries across origins and equivalent limit spellings. */
export const twitchStatsHandlersLayer = HttpApiBuilder.group(TwitchHttpApi, "stats", (handlers) =>
  Effect.gen(function* () {
    const songQueue = yield* SongQueue;
    const raffle = yield* Raffle;
    const cache = yield* HttpResponseCache;
    return handlers
      .handleRaw("topTracks", () =>
        Effect.gen(function* () {
          const limit = yield* parseHttpSongQueueQuery();
          const value = yield* cache.readThrough({
            key: `https://stats.internal/api/stats/top-tracks?limit=${limit}`,
            schema: topTracks,
            load: songQueue.getTopTracks({ limit }).pipe(Effect.mapError(statsFailure)),
          });
          return withCacheHeader(yield* encodeHttpResponse(topTracks, value));
        }).pipe(renderFailure),
      )
      .handleRaw("viewerTopTracks", ({ params }) =>
        Effect.gen(function* () {
          const limit = yield* parseHttpSongQueueQuery().pipe(Effect.mapError(invalidRequest));
          const userId = yield* parseViewerId(params.user).pipe(Effect.mapError(invalidRequest));
          const value = yield* cache.readThrough({
            key: `https://stats.internal/api/stats/top-tracks/${userId}?limit=${limit}`,
            schema: topTracks,
            load: songQueue
              .getTopTracksByUser({ userId, limit })
              .pipe(Effect.mapError(statsFailure)),
          });
          return withCacheHeader(yield* encodeHttpResponse(topTracks, value));
        }).pipe(renderFailure),
      )
      .handleRaw("topRequesters", () =>
        Effect.gen(function* () {
          const limit = yield* parseHttpSongQueueQuery();
          const value = yield* cache.readThrough({
            key: `https://stats.internal/api/stats/top-requesters?limit=${limit}`,
            schema: topRequesters,
            load: songQueue.getTopRequesters({ limit }).pipe(Effect.mapError(statsFailure)),
          });
          return withCacheHeader(yield* encodeHttpResponse(topRequesters, value));
        }).pipe(renderFailure),
      )
      .handleRaw("raffleLeaderboard", () =>
        Effect.gen(function* () {
          const { limit, sortBy } = yield* parseHttpLeaderboardQuery();
          const value = yield* cache.readThrough({
            key: `https://stats.internal/api/stats/raffle/leaderboard?limit=${limit}&sortBy=${sortBy}`,
            schema: raffleLeaderboard,
            load: raffle
              .getLeaderboard({ limit: Option.some(limit), sortBy })
              .pipe(Effect.mapError(statsFailure)),
          });
          return withCacheHeader(yield* encodeHttpResponse(raffleLeaderboard, value));
        }).pipe(renderFailure),
      )
      .handleRaw("raffleViewer", ({ params }) =>
        Effect.gen(function* () {
          yield* rejectHttpQueryParameters().pipe(Effect.mapError(invalidRequest));
          const userId = yield* parseViewerId(params.user).pipe(Effect.mapError(invalidRequest));
          const value = yield* cache.readThrough({
            key: `https://stats.internal/api/stats/raffle/user/${userId}`,
            schema: TwitchRaffleViewerResponse,
            load: raffle.getUserStats({ userId }).pipe(
              Effect.mapError(statsFailure),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(new HttpBoundaryError({ status: 404, error: "User not found" })),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          });
          return withCacheHeader(yield* encodeHttpResponse(TwitchRaffleViewerResponse, value));
        }).pipe(renderFailure),
      );
  }),
);
