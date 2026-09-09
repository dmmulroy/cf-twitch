import { Schema } from "effect";
import { EventId, IsoTimestamp, PageSize, ViewerId } from "./identity.ts";

/** Stable achievement identity includes the thirteen historical definitions. */
export const AchievementId = Schema.NonEmptyString.pipe(Schema.brand("AchievementId"));

/** Stable achievement identity. */
export type AchievementId = typeof AchievementId.Type;

/** Achievement grouping retained for overlay compatibility. */
export const AchievementCategory = Schema.Literals([
  "song_request",
  "raffle",
  "engagement",
  "special",
]);

/** Events that advance achievement progress. */
export const AchievementTriggerEvent = Schema.Literals([
  "song_request",
  "stream_first_request",
  "raffle_roll",
  "raffle_win",
  "raffle_close",
  "raffle_closest_record",
  "request_streak",
]);

/** Definition thresholds are absent for one-time event achievements. */
export const AchievementDefinition = Schema.Struct({
  id: AchievementId,
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  icon: Schema.NonEmptyString,
  category: AchievementCategory,
  threshold: Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  triggerEvent: AchievementTriggerEvent,
  scope: Schema.Literals(["session", "cumulative"]),
});

/** Achievement metadata and progression policy. */
export interface AchievementDefinition extends Schema.Schema.Type<typeof AchievementDefinition> {}

/** An unlocked achievement carries the original unlock timestamp. */
export const UnlockedAchievement = Schema.Struct({
  id: AchievementId,
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  icon: Schema.NonEmptyString,
  category: AchievementCategory,
  unlockedAt: IsoTimestamp,
});

/** Unlocked achievement projection. */
export interface UnlockedAchievement extends Schema.Schema.Type<typeof UnlockedAchievement> {}

/** Progress is scoped by stable viewer identity; display names are projections. */
export const ViewerAchievementProgress = Schema.Struct({
  achievementId: AchievementId,
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  icon: Schema.NonEmptyString,
  category: AchievementCategory,
  threshold: AchievementDefinition.fields.threshold,
  progress: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unlocked: Schema.Boolean,
  unlockedAt: Schema.OptionFromNullOr(IsoTimestamp),
});

/** Full viewer progress including locked definitions. */
export interface ViewerAchievementProgress extends Schema.Schema.Type<
  typeof ViewerAchievementProgress
> {}

/** Ranking counts unlocked achievements, not cumulative progress. */
export const AchievementLeaderboardEntry = Schema.Struct({
  userDisplayName: Schema.NonEmptyString,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Viewer achievement rank. */
export interface AchievementLeaderboardEntry extends Schema.Schema.Type<
  typeof AchievementLeaderboardEntry
> {}

/** Ranking limit is bounded to one hundred; None selects ten. */
export const AchievementLeaderboardQuery = Schema.Struct({
  limit: Schema.OptionFromNullOr(PageSize),
});

/** Bounded achievement ranking query. */
export interface AchievementLeaderboardQuery extends Schema.Schema.Type<
  typeof AchievementLeaderboardQuery
> {}

/** Direct event intake uses the same transactional inbox as domain events. */
export const AchievementEventInput = Schema.Struct({
  userId: ViewerId,
  userDisplayName: Schema.NonEmptyString,
  event: AchievementTriggerEvent,
  eventId: EventId,
  increment: Schema.Int.check(Schema.isGreaterThan(0)),
  metadata: Schema.OptionFromNullOr(Schema.Record(Schema.String, Schema.Json)),
});

/** Direct achievement trigger input; increment is explicit. */
export interface AchievementEventInput extends Schema.Schema.Type<typeof AchievementEventInput> {}

/** Counts support administrative persistence diagnosis. */
export const AchievementDebugTableCounts = Schema.Struct({
  definitions: Schema.Int,
  userAchievements: Schema.Int,
  unlockedAchievements: Schema.Int,
  userStreaks: Schema.Int,
  eventHistory: Schema.Int,
});

/** Administrative achievement table counts. */
export interface AchievementDebugTableCounts extends Schema.Schema.Type<
  typeof AchievementDebugTableCounts
> {}

/** Recent event history is diagnostic evidence, not reconstructed from progress. */
export const AchievementDebugEvent = Schema.Struct({
  eventId: Schema.String,
  eventType: Schema.String,
  userId: Schema.String,
  userDisplayName: Schema.String,
  timestamp: Schema.String,
  metadata: Schema.OptionFromNullOr(Schema.String),
});

/** Snapshot preserves exact, case-insensitive and loose-name diagnostics. */
export const AchievementDebugUserSnapshot = Schema.Struct({
  requestedUser: Schema.String,
  normalizedUser: Schema.String,
  exactUserAchievementRows: Schema.Int,
  caseInsensitiveUserAchievementRows: Schema.Int,
  exactUnlockedRows: Schema.Int,
  caseInsensitiveUnlockedRows: Schema.Int,
  exactStreakRows: Schema.Int,
  caseInsensitiveStreakRows: Schema.Int,
  exactEventHistoryRows: Schema.Int,
  caseInsensitiveEventHistoryRows: Schema.Int,
  recentEvents: Schema.Array(AchievementDebugEvent),
  similarUsers: Schema.Array(Schema.String),
});

/** Administrative viewer identity diagnostics. */
export interface AchievementDebugUserSnapshot extends Schema.Schema.Type<
  typeof AchievementDebugUserSnapshot
> {}

/** Reset only targets cumulative definitions with absent thresholds. */
export const AchievementResetResult = Schema.Struct({
  deleted: Schema.Int,
  achievementIds: Schema.Array(AchievementId),
});

/** One-time achievement reset result. */
export interface AchievementResetResult extends Schema.Schema.Type<typeof AchievementResetResult> {}

/** Unannounced unlocks remain observable even when provider delivery is blocked. */
export const UnannouncedAchievement = Schema.Struct({
  userDisplayName: Schema.NonEmptyString,
  achievement: UnlockedAchievement,
});

/** Unannounced achievement projection. */
export interface UnannouncedAchievement extends Schema.Schema.Type<typeof UnannouncedAchievement> {}

/** Achievement errors distinguish boundary corruption from storage and transport failure. */
export class AchievementError extends Schema.TaggedError<AchievementError>()("AchievementError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "invalid_input",
    "invalid_stored_data",
    "invalid_response",
    "persistence_unavailable",
    "transport_unavailable",
  ]),
}) {
  override get message(): string {
    return `Achievement operation failed: ${this.operation} (${this.reason})`;
  }
}
