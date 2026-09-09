import { Context, type Effect, type Option } from "effect";
import type { DomainEvent } from "@cf-twitch/contracts/domain-event";
import type {
  AchievementDebugTableCounts,
  AchievementDebugUserSnapshot,
  AchievementDefinition,
  AchievementError,
  AchievementEventInput,
  AchievementLeaderboardEntry,
  AchievementLeaderboardQuery,
  AchievementResetResult,
  UnannouncedAchievement,
  UnlockedAchievement,
  ViewerAchievementProgress,
} from "@cf-twitch/contracts/achievement";

/** Achievement authority owns progress, event inbox, sessions and unlock delivery intents. */
export interface IAchievements {
  /** Commit event inbox, progress, session decisions and unlock intents atomically. */
  readonly handleEvent: (event: DomainEvent) => Effect.Effect<void, AchievementError>;
  /** Direct triggers share Event ID deduplication; duplicate delivery returns no new unlocks. */
  readonly recordEvent: (
    input: AchievementEventInput,
  ) => Effect.Effect<ReadonlyArray<UnlockedAchievement>, AchievementError>;
  /** Return all thirteen historical achievement definitions, including session scope. */
  readonly getDefinitions: () => Effect.Effect<
    ReadonlyArray<AchievementDefinition>,
    AchievementError
  >;
  /** Return every definition with progress using the exact current display-name projection. */
  readonly getUserAchievements: (input: {
    readonly userDisplayName: string;
  }) => Effect.Effect<ReadonlyArray<ViewerAchievementProgress>, AchievementError>;
  /** Return unlocked achievements newest first for an exact display-name projection. */
  readonly getUnlockedAchievements: (input: {
    readonly userDisplayName: string;
  }) => Effect.Effect<ReadonlyArray<UnlockedAchievement>, AchievementError>;
  /** Rank display-name projections by unlock count, bounded to one hundred. */
  readonly getLeaderboard: (
    input: AchievementLeaderboardQuery,
  ) => Effect.Effect<ReadonlyArray<AchievementLeaderboardEntry>, AchievementError>;
  /** Return pending unlocked projections, including historical pre-outbox unlocks. */
  readonly getUnannounced: () => Effect.Effect<
    ReadonlyArray<UnannouncedAchievement>,
    AchievementError
  >;
  /** Expose authoritative SQL counts rather than an Agent JSON projection. */
  readonly getDebugTableCounts: () => Effect.Effect<AchievementDebugTableCounts, AchievementError>;
  /** Diagnose exact, normalized and loose-name matches without merging Viewer IDs. */
  readonly getDebugUserSnapshot: (input: {
    readonly userDisplayName: string;
  }) => Effect.Effect<AchievementDebugUserSnapshot, AchievementError>;
  /** Reset only event-based cumulative achievements; None targets every viewer. */
  readonly resetOneTimeAchievements: (input: {
    readonly userDisplayName: Option.Option<string>;
  }) => Effect.Effect<AchievementResetResult, AchievementError>;
}

/** Shared service tag for local SQL authority and namespace HTTP client. */
export class Achievements extends Context.Service<Achievements, IAchievements>()(
  "@cf-twitch/Achievements",
) {}
