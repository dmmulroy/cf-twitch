import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { TwitchHttpApi, TwitchNowPlayingResponse } from "@cf-twitch/contracts/twitch-api";
import {
  RequestHistoryQuery,
  RequestHistoryResult,
  SongQueueResult,
} from "@cf-twitch/contracts/song-queue";
import {
  AchievementDefinition,
  AchievementLeaderboardEntry,
  UnlockedAchievement,
  ViewerAchievementProgress,
} from "@cf-twitch/contracts/achievement";
import { SongQueue } from "../song-queue/song-queue.ts";
import { Achievements } from "../achievements/achievements-service.ts";
import {
  encodeHttpResponse,
  parseHttpLimitQuery,
  parseHttpSongQueueQuery,
  handleHttpBoundary,
} from "./http-boundary.ts";
import { achievementHttpFailure, songQueueHttpFailure } from "./http-service-failures.ts";

/**
 * Layer that serves the public Song Queue and Achievements read endpoints.
 *
 * **Details**
 *
 * Captures the real `SongQueue` and `Achievements` services without choosing their providers.
 * Service failures render as public errors by classified reason; unavailable services return a
 * retryable 503.
 */
export const twitchPublicHandlersLayer = HttpApiBuilder.group(TwitchHttpApi, "public", (handlers) =>
  Effect.gen(function* () {
    const songQueue = yield* SongQueue;
    const achievements = yield* Achievements;

    return handlers
      .handle("health", () => Effect.succeed({ status: "ok" as const }))
      .handleRaw("nowPlaying", () =>
        Effect.gen(function* () {
          const playing = yield* songQueue.getCurrentlyPlaying().pipe(
            Effect.catchTag("SongQueueError", (error) =>
              Effect.fail(
                songQueueHttpFailure(error, {
                  kind: "repeatable",
                }),
              ),
            ),
          );

          return yield* encodeHttpResponse("songQueue", TwitchNowPlayingResponse, playing);
        }).pipe(handleHttpBoundary("nowPlaying")),
      )
      .handleRaw("queue", () =>
        Effect.gen(function* () {
          const limit = yield* parseHttpSongQueueQuery();

          const queue = yield* songQueue.getSongQueue({ limit }).pipe(
            Effect.catchTag("SongQueueError", (error) =>
              Effect.fail(
                songQueueHttpFailure(error, {
                  kind: "repeatable",
                }),
              ),
            ),
          );

          return yield* encodeHttpResponse("songQueue", SongQueueResult, queue);
        }).pipe(handleHttpBoundary("queue")),
      )
      .handleRaw("requestHistory", () =>
        Effect.gen(function* () {
          const limit = yield* parseHttpSongQueueQuery();

          const history = yield* songQueue
            .getRequestHistory(
              RequestHistoryQuery.make({
                limit,
                offset: 0,
                since: Option.none(),
                until: Option.none(),
              }),
            )
            .pipe(
              Effect.catchTag("SongQueueError", (error) =>
                Effect.fail(
                  songQueueHttpFailure(error, {
                    kind: "repeatable",
                  }),
                ),
              ),
            );

          return yield* encodeHttpResponse("songQueue", RequestHistoryResult, history);
        }).pipe(handleHttpBoundary("requestHistory")),
      )
      .handleRaw("achievementDefinitions", () =>
        achievements.getDefinitions().pipe(
          Effect.catchTag("AchievementError", (error) =>
            Effect.fail(
              achievementHttpFailure(error, {
                kind: "repeatable",
              }),
            ),
          ),
          Effect.flatMap((value) =>
            encodeHttpResponse("achievements", Schema.Array(AchievementDefinition), value),
          ),
          handleHttpBoundary("achievementDefinitions"),
        ),
      )
      .handleRaw("achievementLeaderboard", () =>
        Effect.gen(function* () {
          const limit = yield* parseHttpLimitQuery();

          const value = yield* achievements.getLeaderboard({ limit: Option.some(limit) }).pipe(
            Effect.catchTag("AchievementError", (error) =>
              Effect.fail(
                achievementHttpFailure(error, {
                  kind: "repeatable",
                }),
              ),
            ),
          );

          return yield* encodeHttpResponse(
            "achievements",
            Schema.Array(AchievementLeaderboardEntry),
            value,
          );
        }).pipe(handleHttpBoundary("achievementLeaderboard")),
      )
      .handleRaw("viewerAchievements", ({ params }) =>
        achievements.getUserAchievements({ userDisplayName: params.user }).pipe(
          Effect.catchTag("AchievementError", (error) =>
            Effect.fail(
              achievementHttpFailure(error, {
                kind: "repeatable",
              }),
            ),
          ),
          Effect.flatMap((value) =>
            encodeHttpResponse("achievements", Schema.Array(ViewerAchievementProgress), value),
          ),
          handleHttpBoundary("viewerAchievements"),
        ),
      )
      .handleRaw("viewerUnlockedAchievements", ({ params }) =>
        achievements.getUnlockedAchievements({ userDisplayName: params.user }).pipe(
          Effect.catchTag("AchievementError", (error) =>
            Effect.fail(
              achievementHttpFailure(error, {
                kind: "repeatable",
              }),
            ),
          ),
          Effect.flatMap((value) =>
            encodeHttpResponse("achievements", Schema.Array(UnlockedAchievement), value),
          ),
          handleHttpBoundary("viewerUnlockedAchievements"),
        ),
      );
  }),
);
