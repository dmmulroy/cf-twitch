import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { TwitchHttpApi, TwitchNowPlayingResponse } from "@cf-twitch/contracts/twitch-api";
import {
  RequestHistoryQuery,
  RequestHistoryResult,
  SongQueueResult,
  type SongQueueError,
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
  HttpBoundaryError,
  encodeHttpResponse,
  parseHttpLimitQuery,
  parseHttpSongQueueQuery,
  handleHttpBoundary,
} from "./http-boundary.ts";

const songFailure = (message: string) => (error: SongQueueError) =>
  new HttpBoundaryError(
    error.reason === "transport_unavailable" ||
      error.reason === "coordination_unavailable" ||
      error.reason === "storage_unavailable" ||
      error.reason === "provider_unavailable"
      ? { status: 503, error: "Service temporarily unavailable" }
      : { status: 500, error: message },
  );
const renderFailure = handleHttpBoundary;

/** Public query handlers capture real service requirements without choosing their providers. */
export const twitchPublicHandlersLayer = HttpApiBuilder.group(TwitchHttpApi, "public", (handlers) =>
  Effect.gen(function* () {
    const songQueue = yield* SongQueue;
    const achievements = yield* Achievements;
    return handlers
      .handle("health", () => Effect.succeed({ status: "ok" as const }))
      .handleRaw("nowPlaying", () =>
        Effect.gen(function* () {
          const playing = yield* songQueue
            .getCurrentlyPlaying()
            .pipe(Effect.mapError(songFailure("Failed to fetch now playing")));
          return yield* encodeHttpResponse(TwitchNowPlayingResponse, playing);
        }).pipe(renderFailure),
      )
      .handleRaw("queue", () =>
        Effect.gen(function* () {
          const limit = yield* parseHttpSongQueueQuery();
          const queue = yield* songQueue
            .getSongQueue({ limit })
            .pipe(Effect.mapError(songFailure("Failed to fetch queue")));
          return yield* encodeHttpResponse(SongQueueResult, queue);
        }).pipe(renderFailure),
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
            .pipe(Effect.mapError(songFailure("Failed to fetch song request history")));
          return yield* encodeHttpResponse(RequestHistoryResult, history);
        }).pipe(renderFailure),
      )
      .handleRaw("achievementDefinitions", () =>
        achievements.getDefinitions().pipe(
          Effect.mapError(
            () =>
              new HttpBoundaryError({
                status: 500,
                error: "Failed to fetch achievement definitions",
              }),
          ),
          Effect.flatMap((value) => encodeHttpResponse(Schema.Array(AchievementDefinition), value)),
          renderFailure,
        ),
      )
      .handleRaw("achievementLeaderboard", () =>
        Effect.gen(function* () {
          const limit = yield* parseHttpLimitQuery();
          const value = yield* achievements.getLeaderboard({ limit: Option.some(limit) }).pipe(
            Effect.mapError(
              () =>
                new HttpBoundaryError({
                  status: 500,
                  error: "Failed to fetch achievement leaderboard",
                }),
            ),
          );
          return yield* encodeHttpResponse(Schema.Array(AchievementLeaderboardEntry), value);
        }).pipe(renderFailure),
      )
      .handleRaw("viewerAchievements", ({ params }) =>
        achievements.getUserAchievements({ userDisplayName: params.user }).pipe(
          Effect.mapError(
            () =>
              new HttpBoundaryError({ status: 500, error: "Failed to fetch user achievements" }),
          ),
          Effect.flatMap((value) =>
            encodeHttpResponse(Schema.Array(ViewerAchievementProgress), value),
          ),
          renderFailure,
        ),
      )
      .handleRaw("viewerUnlockedAchievements", ({ params }) =>
        achievements.getUnlockedAchievements({ userDisplayName: params.user }).pipe(
          Effect.mapError(
            () =>
              new HttpBoundaryError({
                status: 500,
                error: "Failed to fetch unlocked achievements",
              }),
          ),
          Effect.flatMap((value) => encodeHttpResponse(Schema.Array(UnlockedAchievement), value)),
          renderFailure,
        ),
      );
  }),
);
