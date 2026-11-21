import { Option } from "effect";
import type {
  AchievementDebugEvent,
  AchievementDebugUserSnapshot,
  AchievementDefinition,
  AchievementId,
  UnannouncedAchievement,
  ViewerAchievementProgress,
} from "@cf-twitch/contracts/achievement";
import type { DomainEvent } from "@cf-twitch/contracts/domain-event";
import type { IsoTimestamp, ViewerId } from "@cf-twitch/contracts/identity";

/** Viewer progress toward one Achievement as stored by an achievement authority. */
export interface AchievementProgressRecord {
  readonly userId: ViewerId;
  /** Display name from the Viewer's most recent achievement event; a projection, not an identity. */
  readonly userDisplayName: string;
  readonly achievementId: AchievementId;
  readonly progress: number;
  /** Time of the first unlock, or `None` while locked. */
  readonly unlockedAt: Option.Option<IsoTimestamp>;
  /** Event that last advanced a one-time event achievement; `None` for threshold achievements. */
  readonly eventId: Option.Option<string>;
  /** Chat announcement state of the current unlock. */
  readonly announcementState: "pending" | "sending" | "sent" | "abandoned" | "uncertain";
}

/** Achievement history row recorded for one inbox event, before its event ID, type, and time are added. */
export interface AchievementHistoryRecord {
  /** Viewer the event concerns, or `system` for Stream Session transitions. */
  readonly userId: ViewerId | "system";
  readonly userDisplayName: string;
  /** Event details serialized as JSON text, retained only as diagnostic evidence. */
  readonly metadata: string;
}

/** Returns the achievement history row that records one domain event in the achievement inbox. */
export const achievementHistoryRecordForEvent = (event: DomainEvent): AchievementHistoryRecord => {
  switch (event.type) {
    case "song_request_success":
      return {
        userId: event.userId,
        userDisplayName: event.userDisplayName,
        metadata: JSON.stringify({ trackId: event.trackId, sagaId: event.sagaId }),
      };
    case "raffle_roll":
      return {
        userId: event.userId,
        userDisplayName: event.userDisplayName,
        metadata: JSON.stringify({
          roll: event.roll,
          winningNumber: event.winningNumber,
          distance: event.distance,
          isWinner: event.isWinner,
          sagaId: event.sagaId,
        }),
      };
    case "stream_online":
      return {
        userId: "system",
        userDisplayName: "System",
        metadata: JSON.stringify({ streamId: event.streamId, startedAt: event.startedAt }),
      };
    case "stream_offline":
      return {
        userId: "system",
        userDisplayName: "System",
        metadata: JSON.stringify({ streamId: event.streamId, endedAt: event.endedAt }),
      };
  }
};

/** Returns every Achievement Definition paired with the Viewer's progress, defaulting to zero progress. */
export const projectViewerAchievementProgress = (
  definitions: ReadonlyArray<AchievementDefinition>,
  progress: ReadonlyArray<AchievementProgressRecord>,
): ReadonlyArray<ViewerAchievementProgress> => {
  const byId = new Map(progress.map((row) => [row.achievementId, row]));

  return definitions.map((definition): ViewerAchievementProgress => {
    const row = Option.fromUndefinedOr(byId.get(definition.id));
    const unlockedAt = Option.flatMap(row, (value) => value.unlockedAt);

    return {
      achievementId: definition.id,
      name: definition.name,
      description: definition.description,
      icon: definition.icon,
      category: definition.category,
      threshold: definition.threshold,
      progress: Option.match(row, { onNone: () => 0, onSome: (value) => value.progress }),
      unlocked: Option.isSome(unlockedAt),
      unlockedAt,
    };
  });
};

/** Returns pending-announcement unlocks with their definitions, skipping rows whose definition is unknown. */
export const projectUnannouncedAchievements = (
  definitions: ReadonlyArray<AchievementDefinition>,
  rows: ReadonlyArray<AchievementProgressRecord>,
): ReadonlyArray<UnannouncedAchievement> =>
  rows.flatMap((row) => {
    const definition = definitions.find((item) => item.id === row.achievementId);

    if (definition === undefined || Option.isNone(row.unlockedAt)) return [];

    return [
      {
        userDisplayName: row.userDisplayName,
        achievement: {
          id: definition.id,
          name: definition.name,
          description: definition.description,
          icon: definition.icon,
          category: definition.category,
          unlockedAt: row.unlockedAt.value,
        },
      },
    ];
  });

const normalizeAchievementUser = (value: string) => value.trim().replace(/^@+/, "").toLowerCase();

const normalizeLooseAchievementUser = (value: string) =>
  normalizeAchievementUser(value).replaceAll("_", "");

/**
 * Summarizes how a requested display name matches stored achievement records, without merging Viewer IDs.
 *
 * **Details**
 *
 * Exact matching compares display names unchanged. Case-insensitive matching trims, removes leading
 * `@`, and lowercases. Similar names also ignore underscores and accept substring matches, capped at
 * twenty sorted names.
 */
export const summarizeAchievementDebugUser = (input: {
  readonly requestedUser: string;
  readonly progress: ReadonlyArray<AchievementProgressRecord>;
  readonly streakDisplayNames: ReadonlyArray<string>;
  readonly events: ReadonlyArray<AchievementDebugEvent>;
  /** The two hundred most recent history events, newest first. */
  readonly recentEvents: ReadonlyArray<AchievementDebugEvent>;
}): AchievementDebugUserSnapshot => {
  const { requestedUser } = input;
  const normalizedUser = normalizeAchievementUser(requestedUser);
  const loose = normalizeLooseAchievementUser(requestedUser);
  const exact = (name: string) => name === requestedUser;
  const normalized = (name: string) => normalizeAchievementUser(name) === normalizedUser;
  const progressNames = input.progress.map((row) => row.userDisplayName);

  const unlockedNames = input.progress
    .filter((row) => Option.isSome(row.unlockedAt))
    .map((row) => row.userDisplayName);

  const eventNames = input.events.map((row) => row.userDisplayName);
  const known = new Set([...progressNames, ...input.streakDisplayNames, ...eventNames]);

  const similarUsers = Array.from(known)
    .filter((name) => {
      const normal = normalizeAchievementUser(name);
      const candidate = normalizeLooseAchievementUser(name);

      return (
        normal === normalizedUser ||
        candidate === loose ||
        normal.includes(normalizedUser) ||
        normalizedUser.includes(normal) ||
        candidate.includes(loose) ||
        loose.includes(candidate)
      );
    })
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 20);

  return {
    requestedUser,
    normalizedUser,
    exactUserAchievementRows: progressNames.filter(exact).length,
    caseInsensitiveUserAchievementRows: progressNames.filter(normalized).length,
    exactUnlockedRows: unlockedNames.filter(exact).length,
    caseInsensitiveUnlockedRows: unlockedNames.filter(normalized).length,
    exactStreakRows: input.streakDisplayNames.filter(exact).length,
    caseInsensitiveStreakRows: input.streakDisplayNames.filter(normalized).length,
    exactEventHistoryRows: eventNames.filter(exact).length,
    caseInsensitiveEventHistoryRows: eventNames.filter(normalized).length,
    recentEvents: input.recentEvents.filter((row) => normalized(row.userDisplayName)),
    similarUsers,
  };
};
