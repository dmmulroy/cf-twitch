import { Option, Schema } from "effect";
import type { DomainEvent } from "./domain-event.ts";
import {
  EventId,
  IsoTimestamp,
  NonNegativeInt,
  PageSize,
  PositiveInt,
  ViewerId,
} from "./identity.ts";

/** Schema for the stable identity of an Achievement Definition, such as `first_request`. */
export const AchievementId = Schema.NonEmptyString.pipe(Schema.brand("AchievementId"));

/** Stable identity of an Achievement Definition, shared by progress, unlocks, and announcements. */
export type AchievementId = typeof AchievementId.Type;

/** Schema for the achievement grouping retained for overlay compatibility. */
export const AchievementCategory = Schema.Literals([
  "song_request",
  "raffle",
  "engagement",
  "special",
]);

/** Achievement grouping retained for overlay compatibility. */
export type AchievementCategory = typeof AchievementCategory.Type;

/** Schema for the domain trigger that advances an Achievement's progress. */
export const AchievementTriggerEvent = Schema.Literals([
  "song_request",
  "stream_first_request",
  "raffle_roll",
  "raffle_win",
  "raffle_close",
  "raffle_closest_record",
  "request_streak",
]);

/** Domain trigger that advances an Achievement's progress. */
export type AchievementTriggerEvent = typeof AchievementTriggerEvent.Type;

/** Schema for an Achievement Definition: identity, presentation, trigger, threshold, and scope. */
export const AchievementDefinition = Schema.Struct({
  id: AchievementId,
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  icon: Schema.NonEmptyString,
  category: AchievementCategory,
  /** Progress needed to unlock; `None` marks a one-time event achievement that unlocks on its first trigger. */
  threshold: Schema.OptionFromNullOr(PositiveInt),
  triggerEvent: AchievementTriggerEvent,
  /** `session` progress resets when a new Stream Session starts; `cumulative` progress never resets automatically. */
  scope: Schema.Literals(["session", "cumulative"]),
});

/** Achievement Definition: milestone metadata and the progression policy it follows. */
export interface AchievementDefinition extends Schema.Schema.Type<typeof AchievementDefinition> {}

/** Schema for an unlocked Achievement together with its original unlock time. */
export const UnlockedAchievement = Schema.Struct({
  id: AchievementId,
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  icon: Schema.NonEmptyString,
  category: AchievementCategory,
  /** Time of the first unlock; repeated triggers never move it. */
  unlockedAt: IsoTimestamp,
});

/** Unlocked Achievement projection shown to viewers and overlays. */
export interface UnlockedAchievement extends Schema.Schema.Type<typeof UnlockedAchievement> {}

/** Schema for one Viewer's Achievement Progress toward one definition, locked or unlocked. */
export const ViewerAchievementProgress = Schema.Struct({
  achievementId: AchievementId,
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  icon: Schema.NonEmptyString,
  category: AchievementCategory,
  /** Progress needed to unlock; `None` for one-time event achievements. */
  threshold: AchievementDefinition.fields.threshold,
  progress: NonNegativeInt,
  unlocked: Schema.Boolean,
  /** Time of the first unlock, or `None` while the achievement is locked. */
  unlockedAt: Schema.OptionFromNullOr(IsoTimestamp),
});

/** Viewer progress for one definition, including definitions the Viewer has not started. */
export interface ViewerAchievementProgress extends Schema.Schema.Type<
  typeof ViewerAchievementProgress
> {}

/** Schema for one achievement leaderboard row, ranked by unlocked achievement count. */
export const AchievementLeaderboardEntry = Schema.Struct({
  userDisplayName: Schema.NonEmptyString,
  /** Number of unlocked achievements, not cumulative progress. */
  count: NonNegativeInt,
});

/** Viewer rank by unlocked achievement count. */
export interface AchievementLeaderboardEntry extends Schema.Schema.Type<
  typeof AchievementLeaderboardEntry
> {}

/** Schema for an achievement leaderboard request. */
export const AchievementLeaderboardQuery = Schema.Struct({
  /** Maximum number of rows, at most one hundred; `None` selects ten. */
  limit: Schema.OptionFromNullOr(PageSize),
});

/** Bounded achievement leaderboard request. */
export interface AchievementLeaderboardQuery extends Schema.Schema.Type<
  typeof AchievementLeaderboardQuery
> {}

/** Schema for a direct achievement trigger, deduplicated by event ID like domain events. */
export const AchievementEventInput = Schema.Struct({
  userId: ViewerId,
  userDisplayName: Schema.NonEmptyString,
  event: AchievementTriggerEvent,
  /** Deduplication key; sending the same event ID again has no further effect. */
  eventId: EventId,
  /** Amount added to progress; a `request_streak` trigger sets progress to this value instead. */
  increment: PositiveInt,
  /** Optional trigger details; a numeric `streakCount` overrides `increment` for `request_streak`. */
  metadata: Schema.OptionFromNullOr(Schema.Record(Schema.String, Schema.Json)),
});

/** Direct achievement trigger with an explicit increment. */
export interface AchievementEventInput extends Schema.Schema.Type<typeof AchievementEventInput> {}

/** Schema for achievement table row counts used in administrative storage diagnosis. */
export const AchievementDebugTableCounts = Schema.Struct({
  definitions: Schema.Int,
  userAchievements: Schema.Int,
  unlockedAchievements: Schema.Int,
  userStreaks: Schema.Int,
  eventHistory: Schema.Int,
});

/** Administrative achievement table row counts. */
export interface AchievementDebugTableCounts extends Schema.Schema.Type<
  typeof AchievementDebugTableCounts
> {}

/** Schema for one recorded event in achievement history, kept as diagnostic evidence. */
export const AchievementDebugEvent = Schema.Struct({
  eventId: Schema.String,
  eventType: Schema.String,
  userId: Schema.String,
  userDisplayName: Schema.String,
  timestamp: Schema.String,
  /** Recorded event details as stored JSON text, or `None` when none were stored. */
  metadata: Schema.OptionFromNullOr(Schema.String),
});

/** One recorded event in achievement history. */
export interface AchievementDebugEvent extends Schema.Schema.Type<typeof AchievementDebugEvent> {}

/** Schema for exact, case-insensitive, and loose display-name diagnostics for one requested Viewer. */
export const AchievementDebugUserSnapshot = Schema.Struct({
  requestedUser: Schema.String,
  /** Requested name trimmed, without leading `@`, and lowercased. */
  normalizedUser: Schema.String,
  exactUserAchievementRows: Schema.Int,
  caseInsensitiveUserAchievementRows: Schema.Int,
  exactUnlockedRows: Schema.Int,
  caseInsensitiveUnlockedRows: Schema.Int,
  exactStreakRows: Schema.Int,
  caseInsensitiveStreakRows: Schema.Int,
  exactEventHistoryRows: Schema.Int,
  caseInsensitiveEventHistoryRows: Schema.Int,
  /** Matching events among the two hundred most recent, newest first. */
  recentEvents: Schema.Array(AchievementDebugEvent),
  /** Up to twenty known display names that resemble the request, ignoring case and underscores. */
  similarUsers: Schema.Array(Schema.String),
});

/** Administrative Viewer identity diagnostics; distinct Viewer IDs are never merged. */
export interface AchievementDebugUserSnapshot extends Schema.Schema.Type<
  typeof AchievementDebugUserSnapshot
> {}

/** Schema for the result of resetting one-time event achievements. */
export const AchievementResetResult = Schema.Struct({
  /** Number of Viewer progress rows removed. */
  deleted: Schema.Int,
  /** One-time event achievements targeted: cumulative definitions without a threshold. */
  achievementIds: Schema.Array(AchievementId),
});

/** Result of resetting one-time event achievements. */
export interface AchievementResetResult extends Schema.Schema.Type<typeof AchievementResetResult> {}

/** Schema for an unlock whose chat announcement is still pending. */
export const UnannouncedAchievement = Schema.Struct({
  userDisplayName: Schema.NonEmptyString,
  achievement: UnlockedAchievement,
});

/** Unlock awaiting announcement; it stays observable while chat delivery is blocked. */
export interface UnannouncedAchievement extends Schema.Schema.Type<typeof UnannouncedAchievement> {}

/** Achievement operations whose failures are reported as `AchievementError`. */
export const AchievementOperation = Schema.Literals([
  "handleEvent",
  "recordEvent",
  "getDefinitions",
  "getUserAchievements",
  "getUnlockedAchievements",
  "getLeaderboard",
  "getUnannounced",
  "getDebugTableCounts",
  "getDebugUserSnapshot",
  "resetOneTimeAchievements",
  "flushUnlockEffects",
  "hasPendingUnlockEffects",
]);

/** Name of the achievement operation that failed. */
export type AchievementOperation = typeof AchievementOperation.Type;

/** Classified causes of achievement failures. */
export const AchievementErrorReason = Schema.Literals([
  "invalid_input",
  "invalid_stored_data",
  "invalid_response",
  "persistence_unavailable",
  "transport_unavailable",
]);

/** Classified cause of an achievement failure. */
export type AchievementErrorReason = typeof AchievementErrorReason.Type;

/** Way forward for an unavailable or unreadable achievement operation, matched to that operation's idempotency. */
const achievementRetryGuidance = (operation: AchievementOperation): string => {
  switch (operation) {
    case "handleEvent":
    case "recordEvent":
      return "Send the same event again with its original event ID; duplicate events are ignored.";
    case "resetOneTimeAchievements":
      return "Read the viewer's unlocked achievements first, because the reset may have been applied, then repeat it only if it is still needed.";
    case "flushUnlockEffects":
      return "Leave pending unlock announcements in place; the next achievements alarm resumes them.";
    default:
      return "Retry the request.";
  }
};

/**
 * Typed failure of an achievement operation, carried across the achievements HTTP contract.
 *
 * **Details**
 *
 * `reason` separates caller-correctable input, stored-data corruption, an unreadable service
 * response, and unavailable storage or transport. The identifier fields hold the event and Viewer the
 * failing operation already knew; they are `None` when the operation has no such identifier.
 */
export class AchievementError extends Schema.TaggedError<AchievementError>()("AchievementError", {
  operation: AchievementOperation,
  reason: AchievementErrorReason,
  /** Event ID of the event being handled or recorded; `None` for operations without one. */
  eventId: Schema.OptionFromNullOr(EventId),
  /** Viewer the failing event concerned; `None` for stream transitions and queries by display name. */
  viewerId: Schema.OptionFromNullOr(ViewerId),
  /** Display name the failing operation queried or recorded; `None` when it concerned no Viewer. */
  viewerDisplayName: Schema.OptionFromNullOr(Schema.NonEmptyString),
}) {
  /** Failure summary naming the achievement operation, its classified reason, and the next step. */
  override get message(): string {
    switch (this.reason) {
      case "invalid_input":
        return `Achievement event metadata was rejected during ${this.operation} because streakCount must be a positive whole number. Correct the metadata and send the event again.`;
      case "invalid_stored_data":
        return `Achievement storage returned invalid data during ${this.operation} because a stored record failed validation. Inspect the stored achievement records before retrying.`;
      case "invalid_response":
        return `Achievement service response was invalid during ${this.operation} because it did not match the achievements contract. ${achievementRetryGuidance(this.operation)}`;
      case "persistence_unavailable":
        return `Achievement storage was unavailable during ${this.operation}. ${achievementRetryGuidance(this.operation)}`;
      case "transport_unavailable":
        return `Achievement service was unreachable during ${this.operation}. ${achievementRetryGuidance(this.operation)}`;
    }
  }
}

/** Safe identifiers an `AchievementError` carries for the event and Viewer its operation concerned. */
export type AchievementErrorIdentifiers = Pick<
  AchievementError,
  "eventId" | "viewerId" | "viewerDisplayName"
>;

/** Identifiers of an achievement failure that concerns no particular event or Viewer. */
export const achievementErrorWithoutIdentifiers: AchievementErrorIdentifiers = {
  eventId: Option.none(),
  viewerId: Option.none(),
  viewerDisplayName: Option.none(),
};

/** Returns the identifiers of an achievement failure while handling one domain event. */
export const achievementErrorIdentifiersForDomainEvent = (
  event: DomainEvent,
): AchievementErrorIdentifiers => {
  switch (event.type) {
    case "song_request_success":
    case "raffle_roll":
      return {
        eventId: Option.some(event.id),
        viewerId: Option.some(event.userId),
        viewerDisplayName: Option.some(event.userDisplayName),
      };
    case "stream_online":
    case "stream_offline":
      return { ...achievementErrorWithoutIdentifiers, eventId: Option.some(event.id) };
  }
};

/** Returns the identifiers of an achievement failure while recording one direct trigger. */
export const achievementErrorIdentifiersForEventInput = (
  input: AchievementEventInput,
): AchievementErrorIdentifiers => ({
  eventId: Option.some(input.eventId),
  viewerId: Option.some(input.userId),
  viewerDisplayName: Option.some(input.userDisplayName),
});

/** Returns the identifiers of an achievement failure while reading one display name's achievements. */
export const achievementErrorIdentifiersForDisplayName = (input: {
  readonly userDisplayName: string;
}): AchievementErrorIdentifiers => ({
  ...achievementErrorWithoutIdentifiers,
  viewerDisplayName: Option.some(input.userDisplayName),
});

/** Returns the identifiers of an achievement failure while resetting one display name, or every Viewer. */
export const achievementErrorIdentifiersForReset = (input: {
  readonly userDisplayName: Option.Option<string>;
}): AchievementErrorIdentifiers => ({
  ...achievementErrorWithoutIdentifiers,
  viewerDisplayName: input.userDisplayName,
});
