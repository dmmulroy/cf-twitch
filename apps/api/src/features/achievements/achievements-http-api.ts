import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  AchievementError,
  AchievementEventInput,
  UnlockedAchievement,
  AchievementDefinition,
  ViewerAchievementProgress,
  AchievementLeaderboardQuery,
  AchievementLeaderboardEntry,
  UnannouncedAchievement,
  AchievementDebugTableCounts,
  AchievementDebugUserSnapshot,
  AchievementResetResult,
} from "@cf-twitch/contracts/achievement";
import { DomainEvent } from "@cf-twitch/contracts/domain-event";

/** Versioned achievements operations shared by the HTTP server and namespace client. */
export class AchievementsHttpApi extends HttpApi.make("AchievementsHttpApi")
  .add(
    HttpApiGroup.make("achievements")
      .add(
        HttpApiEndpoint.post("handleEvent", "/handleEvent", {
          payload: Schema.Struct({ event: DomainEvent }),
          success: Schema.Void,
          error: AchievementError,
        }),
      )
      .add(
        HttpApiEndpoint.post("recordEvent", "/recordEvent", {
          payload: AchievementEventInput,
          success: Schema.Array(UnlockedAchievement),
          error: AchievementError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getDefinitions", "/getDefinitions", {
          success: Schema.Array(AchievementDefinition),
          error: AchievementError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getUserAchievements", "/getUserAchievements", {
          payload: Schema.Struct({ userDisplayName: Schema.NonEmptyString }),
          success: Schema.Array(ViewerAchievementProgress),
          error: AchievementError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getUnlockedAchievements", "/getUnlockedAchievements", {
          payload: Schema.Struct({ userDisplayName: Schema.NonEmptyString }),
          success: Schema.Array(UnlockedAchievement),
          error: AchievementError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getLeaderboard", "/getLeaderboard", {
          payload: AchievementLeaderboardQuery,
          success: Schema.Array(AchievementLeaderboardEntry),
          error: AchievementError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getUnannounced", "/getUnannounced", {
          success: Schema.Array(UnannouncedAchievement),
          error: AchievementError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getDebugTableCounts", "/getDebugTableCounts", {
          success: AchievementDebugTableCounts,
          error: AchievementError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getDebugUserSnapshot", "/getDebugUserSnapshot", {
          payload: Schema.Struct({ userDisplayName: Schema.NonEmptyString }),
          success: AchievementDebugUserSnapshot,
          error: AchievementError,
        }),
      )
      .add(
        HttpApiEndpoint.post("resetOneTimeAchievements", "/resetOneTimeAchievements", {
          payload: Schema.Struct({
            userDisplayName: Schema.OptionFromNullOr(Schema.NonEmptyString),
          }),
          success: AchievementResetResult,
          error: AchievementError,
        }),
      ),
  )
  .prefix("/v1") {}
