import { Effect, Option, Result } from "effect";
import { TwitchViewerStatsDebugResponse } from "@cf-twitch/contracts/twitch-api";
import type {
  AchievementDefinition,
  AchievementError,
  UnlockedAchievement,
} from "@cf-twitch/contracts/achievement";
import type { RaffleError, RaffleLeaderboardEntry } from "@cf-twitch/contracts/raffle";
import { Achievements } from "../achievements/achievements-service.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { HttpBoundaryError, encodeHttpResponse } from "./http-boundary.ts";
import {
  achievementHttpFailure,
  type HttpServiceAccess,
  raffleHttpFailure,
  songQueueHttpFailure,
} from "./http-service-failures.ts";

/** Component reads are repeatable, so their public failure messages suggest retrying. */
const componentRead: HttpServiceAccess = { kind: "repeatable" };

const summarizeAchievementStats = (
  unlocked: Result.Result<ReadonlyArray<UnlockedAchievement>, AchievementError>,
  definitions: Result.Result<ReadonlyArray<AchievementDefinition>, AchievementError>,
) => {
  if (Result.isSuccess(unlocked) && Result.isSuccess(definitions))
    return {
      label: `${unlocked.success.length}/${definitions.success.length}`,
      component: {
        status: "ok" as const,
        unlockedCount: Option.some(unlocked.success.length),
        definitionsCount: Option.some(definitions.success.length),
        error: Option.none(),
      },
    };

  return {
    label: "?/?",
    component: {
      status: "error" as const,
      unlockedCount: Option.none(),
      definitionsCount: Option.none(),
      error: Result.isFailure(unlocked)
        ? Option.some(achievementHttpFailure(unlocked.failure, componentRead).message)
        : Result.isFailure(definitions)
          ? Option.some(achievementHttpFailure(definitions.failure, componentRead).message)
          : Option.none(),
    },
  };
};

const formatRaffleStats = (entry: RaffleLeaderboardEntry): string => {
  const extras = [
    ...Option.match(entry.closestDistance, {
      onNone: () => [],
      onSome: (distance) => [`closest: ${distance}`],
    }),
    ...(entry.totalWins > 0 ? [`${entry.totalWins} win${entry.totalWins > 1 ? "s" : ""}!`] : []),
  ];

  return extras.length > 0
    ? `${entry.totalRolls} rolls (${extras.join(", ")})`
    : `${entry.totalRolls} rolls`;
};

const summarizeRaffleStats = (
  result: Result.Result<Option.Option<RaffleLeaderboardEntry>, RaffleError>,
  targetUser: string,
) => {
  const notFound = Result.isSuccess(result) && Option.isNone(result.success);
  const entry = Result.isSuccess(result) ? result.success : Option.none();

  return {
    status: Option.isNone(entry) ? ("error" as const) : ("ok" as const),
    notFound,
    stats: Option.match(entry, {
      onNone: () => (notFound ? "0 rolls" : "unavailable"),
      onSome: formatRaffleStats,
    }),
    error: Result.isFailure(result)
      ? Option.some(raffleHttpFailure(result.failure, componentRead).message)
      : notFound
        ? Option.some(
            `Raffle viewer not found: ${targetUser} has no Keyboard Raffle rolls. Check the display name and try again.`,
          )
        : Option.none(),
  };
};

/**
 * Reads the `!stats` preview for one viewer, reporting each component's failure separately.
 *
 * **Details**
 *
 * Trims whitespace and leading `@` from the display name. A failed component reports its error
 * in the body while the other components still render, so partial failures return 200.
 *
 * @returns The diagnostic response, or fails with `HttpBoundaryError`: `InvalidViewerDisplayName` (400)
 * when the trimmed display name is empty, or `InvalidServiceResponse` (500) when the aggregate violates its schema.
 */
export const readViewerStatsDebug = Effect.fn("Http.viewerStatsDebug")(function* (rawUser: string) {
  const targetUser = rawUser.trim().replace(/^@+/u, "");

  if (targetUser.length === 0)
    return yield* Effect.fail(
      new HttpBoundaryError({
        operation: "parsePath",
        status: 400,
        failure: {
          code: "InvalidViewerDisplayName",
          message:
            'Viewer display name must not be empty: the path has no display name after removing whitespace and "@". Put a display name in the path and try again.',
          details: { parameter: "user" },
          retryable: false,
        },
      }),
    );
  const achievements = yield* Achievements;
  const songQueue = yield* SongQueue;
  const raffle = yield* Raffle;

  const [unlocked, definitions, song, raffleStatsResult] = yield* Effect.all(
    [
      achievements.getUnlockedAchievements({ userDisplayName: targetUser }).pipe(Effect.result),
      achievements.getDefinitions().pipe(Effect.result),
      songQueue.getUserRequestCountByDisplayName({ displayName: targetUser }).pipe(Effect.result),
      raffle.getUserStatsByDisplayName({ displayName: targetUser }).pipe(Effect.result),
    ],
    { concurrency: "unbounded" },
  );

  const achievementStats = summarizeAchievementStats(unlocked, definitions);
  const songCount = Result.isSuccess(song) ? Option.some(song.success) : Option.none();
  const raffleStats = summarizeRaffleStats(raffleStatsResult, targetUser);

  const noStatsForTargetUser =
    Option.contains(songCount, 0) &&
    Option.contains(achievementStats.component.unlockedCount, 0) &&
    raffleStats.notFound;

  const chatMessage = noStatsForTargetUser
    ? `No records found for @${targetUser} yet — no songs, achievements, or raffle stats.`
    : `@${targetUser} — Songs: ${Option.getOrElse(songCount, () => "unavailable")} | Achievements: ${achievementStats.label} | Raffles: ${raffleStats.stats}`;

  return yield* encodeHttpResponse("achievements", TwitchViewerStatsDebugResponse, {
    targetUser,
    noStatsForTargetUser,
    chatMessage,
    components: {
      song: {
        status: Result.isSuccess(song) ? "ok" : "error",
        count: songCount,
        error: Result.isFailure(song)
          ? Option.some(songQueueHttpFailure(song.failure, componentRead).message)
          : Option.none(),
      },
      achievements: achievementStats.component,
      raffle: raffleStats,
    },
  });
});
