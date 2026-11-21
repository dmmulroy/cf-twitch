import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Achievements } from "./achievements-service.ts";
import { AchievementsHttpApi } from "./achievements-http-api.ts";

/**
 * Layer of achievements HTTP handlers that delegate each endpoint to the instance-local `Achievements` authority.
 *
 * **Details**
 *
 * Each endpoint returns the service's `AchievementError` unchanged, encoded by the HTTP contract's error schema.
 */
export const achievementsHttpHandlersLayer = HttpApiBuilder.group(
  AchievementsHttpApi,
  "achievements",
  (handlers) =>
    Effect.gen(function* () {
      const service = yield* Achievements;

      return handlers
        .handle("handleEvent", ({ payload }) => service.handleEvent(payload.event))
        .handle("recordEvent", ({ payload }) => service.recordEvent(payload))
        .handle("getDefinitions", () => service.getDefinitions())
        .handle("getUserAchievements", ({ payload }) => service.getUserAchievements(payload))
        .handle("getUnlockedAchievements", ({ payload }) =>
          service.getUnlockedAchievements(payload),
        )
        .handle("getLeaderboard", ({ payload }) => service.getLeaderboard(payload))
        .handle("getUnannounced", () => service.getUnannounced())
        .handle("getDebugTableCounts", () => service.getDebugTableCounts())
        .handle("getDebugUserSnapshot", ({ payload }) => service.getDebugUserSnapshot(payload))
        .handle("resetOneTimeAchievements", ({ payload }) =>
          service.resetOneTimeAchievements(payload),
        );
    }),
);
