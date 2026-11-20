import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerResponse } from "effect/http";
import {
  TwitchHttpApi,
  TwitchStatsViewerId,
  TwitchTopRequestersResponse,
  TwitchRaffleViewerResponse,
} from "@cf-twitch/contracts/twitch-api";
import type { ViewerId } from "@cf-twitch/contracts/identity";
import { TopRequestedTrack } from "@cf-twitch/contracts/song-queue";
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
import { raffleHttpFailure, songQueueHttpFailure } from "./http-service-failures.ts";

const decodeTwitchStatsViewerId = Schema.decodeEffect(TwitchStatsViewerId);

/**
 * Parses a statistics route `user` segment as a numeric Viewer ID.
 *
 * @returns The Viewer ID, or fails with `HttpBoundaryError` (`InvalidViewerId`, 400) when the segment is not 1–20 digits.
 */
const parseHttpStatsViewerId = (user: string): Effect.Effect<ViewerId, HttpBoundaryError> =>
  decodeTwitchStatsViewerId(user).pipe(
    Effect.mapError(
      () =>
        new HttpBoundaryError({
          operation: "parsePath",
          status: 400,
          failure: {
            code: "InvalidViewerId",
            error: "Invalid request parameters",
            message: `Invalid Viewer ID ${JSON.stringify(user)}: statistics paths require a numeric Twitch user ID of 1 to 20 digits. Fix the path and try again.`,
            details: { user },
            retryable: false,
          },
        }),
    ),
  );

const topTracks = Schema.Array(TopRequestedTrack);

const raffleLeaderboard = Schema.Array(TwitchRaffleViewerResponse);

const statisticsRead = { kind: "repeatable", summary: "Failed to fetch statistics" } as const;

const withCacheHeader = HttpServerResponse.setHeader("Cache-Control", "public, max-age=60");

/**
 * Layer that serves public Song Request and Keyboard Raffle statistics through the response cache.
 *
 * **Details**
 *
 * Canonical cache keys share entries across origins and equivalent limit spellings. Only
 * successful, schema-valid values are cached and served with `Cache-Control: public, max-age=60`.
 */
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
            service: "songQueue",
            schema: topTracks,
            load: songQueue
              .getTopTracks({ limit })
              .pipe(
                Effect.catchTag("SongQueueError", (error) =>
                  Effect.fail(songQueueHttpFailure(error, statisticsRead)),
                ),
              ),
          });

          return withCacheHeader(yield* encodeHttpResponse("songQueue", topTracks, value));
        }).pipe(handleHttpBoundary("topTracks")),
      )
      .handleRaw("viewerTopTracks", ({ params }) =>
        Effect.gen(function* () {
          const limit = yield* parseHttpSongQueueQuery();
          const userId = yield* parseHttpStatsViewerId(params.user);

          const value = yield* cache.readThrough({
            key: `https://stats.internal/api/stats/top-tracks/${userId}?limit=${limit}`,
            service: "songQueue",
            schema: topTracks,
            load: songQueue
              .getTopTracksByUser({ userId, limit })
              .pipe(
                Effect.catchTag("SongQueueError", (error) =>
                  Effect.fail(songQueueHttpFailure(error, statisticsRead)),
                ),
              ),
          });

          return withCacheHeader(yield* encodeHttpResponse("songQueue", topTracks, value));
        }).pipe(handleHttpBoundary("viewerTopTracks")),
      )
      .handleRaw("topRequesters", () =>
        Effect.gen(function* () {
          const limit = yield* parseHttpSongQueueQuery();

          const value = yield* cache.readThrough({
            key: `https://stats.internal/api/stats/top-requesters?limit=${limit}`,
            service: "songQueue",
            schema: TwitchTopRequestersResponse,
            load: songQueue
              .getTopRequesters({ limit })
              .pipe(
                Effect.catchTag("SongQueueError", (error) =>
                  Effect.fail(songQueueHttpFailure(error, statisticsRead)),
                ),
              ),
          });

          return withCacheHeader(
            yield* encodeHttpResponse("songQueue", TwitchTopRequestersResponse, value),
          );
        }).pipe(handleHttpBoundary("topRequesters")),
      )
      .handleRaw("raffleLeaderboard", () =>
        Effect.gen(function* () {
          const { limit, sortBy } = yield* parseHttpLeaderboardQuery();

          const value = yield* cache.readThrough({
            key: `https://stats.internal/api/stats/raffle/leaderboard?limit=${limit}&sortBy=${sortBy}`,
            service: "keyboardRaffle",
            schema: raffleLeaderboard,
            load: raffle
              .getLeaderboard({ limit: Option.some(limit), sortBy })
              .pipe(
                Effect.catchTag("RaffleError", (error) =>
                  Effect.fail(raffleHttpFailure(error, statisticsRead)),
                ),
              ),
          });

          return withCacheHeader(
            yield* encodeHttpResponse("keyboardRaffle", raffleLeaderboard, value),
          );
        }).pipe(handleHttpBoundary("raffleLeaderboard")),
      )
      .handleRaw("raffleViewer", ({ params }) =>
        Effect.gen(function* () {
          yield* rejectHttpQueryParameters();
          const userId = yield* parseHttpStatsViewerId(params.user);

          const value = yield* cache.readThrough({
            key: `https://stats.internal/api/stats/raffle/user/${userId}`,
            service: "keyboardRaffle",
            schema: TwitchRaffleViewerResponse,
            load: raffle.getUserStats({ userId }).pipe(
              Effect.catchTag("RaffleError", (error) =>
                Effect.fail(raffleHttpFailure(error, statisticsRead)),
              ),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new HttpBoundaryError({
                        operation: "callService",
                        status: 404,
                        failure: {
                          code: "ViewerNotFound",
                          error: "User not found",
                          message: `Viewer not found: Viewer ${userId} has no Keyboard Raffle rolls. Check the Twitch user ID and try again.`,
                          details: { userId },
                          retryable: false,
                        },
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          });

          return withCacheHeader(
            yield* encodeHttpResponse("keyboardRaffle", TwitchRaffleViewerResponse, value),
          );
        }).pipe(handleHttpBoundary("raffleViewer")),
      );
  }),
);
