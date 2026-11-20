import { Effect, Option, Result } from "effect";
import { HttpServerResponse } from "effect/http";
import type {
  AchievementDefinition,
  AchievementError,
  UnlockedAchievement,
} from "@cf-twitch/contracts/achievement";
import type { RaffleError, RaffleLeaderboardEntry } from "@cf-twitch/contracts/raffle";
import { Achievements } from "../achievements/achievements-service.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { HttpBoundaryError } from "./http-boundary.ts";

const summarizeAchievementStats = (
  unlocked: Result.Result<ReadonlyArray<UnlockedAchievement>, AchievementError>,
  definitions: Result.Result<ReadonlyArray<AchievementDefinition>, AchievementError>,
) => {
  const success = Result.isSuccess(unlocked) && Result.isSuccess(definitions);
  const unlockedCount = success ? unlocked.success.length : null;
  const definitionsCount = success ? definitions.success.length : null;

  return {
    label: success ? `${unlockedCount}/${definitionsCount}` : "?/?",
    component: {
      status: success ? ("ok" as const) : ("error" as const),
      unlockedCount,
      definitionsCount,
      error: Result.isFailure(unlocked)
        ? unlocked.failure.message
        : Result.isFailure(definitions)
          ? definitions.failure.message
          : null,
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
      ? result.failure.message
      : notFound
        ? `Raffle viewer not found: ${targetUser} has no Keyboard Raffle rolls. Check the display name and try again.`
        : null,
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
 * @returns The diagnostic response, or fails with `HttpBoundaryError` (`InvalidViewerDisplayName`, 400) when the trimmed display name is empty.
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
          error: "User is required",
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
  const songCount = Result.getOrNull(song);
  const raffleStats = summarizeRaffleStats(raffleStatsResult, targetUser);

  const noStatsForTargetUser =
    songCount === 0 &&
    achievementStats.component.unlockedCount === 0 &&
    achievementStats.component.definitionsCount !== null &&
    raffleStats.notFound;

  const chatMessage = noStatsForTargetUser
    ? `No records found for @${targetUser} yet — no songs, achievements, or raffle stats.`
    : `@${targetUser} — Songs: ${songCount ?? "unavailable"} | Achievements: ${achievementStats.label} | Raffles: ${raffleStats.stats}`;

  return HttpServerResponse.jsonUnsafe({
    targetUser,
    noStatsForTargetUser,
    chatMessage,
    components: {
      song: {
        status: Result.isSuccess(song) ? "ok" : "error",
        count: songCount,
        error: Result.isFailure(song) ? song.failure.message : null,
      },
      achievements: achievementStats.component,
      raffle: raffleStats,
    },
  });
});
