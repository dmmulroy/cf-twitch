import { Option } from "effect";
import type { AchievementDefinition, AchievementId } from "@cf-twitch/contracts/achievement";
import type { DomainEvent } from "@cf-twitch/contracts/domain-event";
import type { IsoTimestamp, StreamId } from "@cf-twitch/contracts/identity";

/** Achievement Progress facts an Achievement Rule reads, using domain options rather than nullable SQLite fields. */
export interface AchievementProgressFact {
  readonly achievementId: AchievementId;
  readonly progress: number;
  /** Time of the first unlock, or `None` while locked. */
  readonly unlockedAt: Option.Option<IsoTimestamp>;
  /** Trigger event that last advanced a one-time event achievement, used to ignore its redelivery. */
  readonly eventId: Option.Option<string>;
}

/** Progress change decided for one definition; it keeps the first unlock time, even for repeated one-time events. */
export interface AchievementProgressDecision extends AchievementProgressFact {
  readonly definition: AchievementDefinition;
  /** Whether this decision unlocks the achievement for the first time, requiring an announcement. */
  readonly newlyUnlocked: boolean;
}

/** Domain evidence that advances every Achievement Definition with a matching trigger. */
export interface AchievementTrigger {
  readonly event: AchievementDefinition["triggerEvent"];
  /** Amount to add, or the new progress value when `mode` is `set`. */
  readonly increment: number;
  /** `set` replaces progress, as Request Streak counts do; `increment` adds to it. */
  readonly mode: "increment" | "set";
  /** Trigger identity; one-time event achievements ignore a trigger ID they already applied. */
  readonly eventId: string;
}

const achievementCanAdvance = (
  definition: AchievementDefinition,
  existing: Option.Option<AchievementProgressFact>,
  trigger: AchievementTrigger,
  direct: boolean,
): boolean => {
  if (definition.triggerEvent !== trigger.event) return false;

  const unlockedBefore = Option.exists(existing, (fact) => Option.isSome(fact.unlockedAt));

  if (unlockedBefore && (direct || Option.isSome(definition.threshold))) return false;

  return !(
    Option.isNone(definition.threshold) &&
    Option.exists(existing, (fact) => Option.contains(fact.eventId, trigger.eventId))
  );
};

const advanceAchievementProgress = (
  definition: AchievementDefinition,
  existing: Option.Option<AchievementProgressFact>,
  trigger: AchievementTrigger,
  now: IsoTimestamp,
): AchievementProgressDecision => {
  const previousProgress = Option.match(existing, {
    onNone: () => 0,
    onSome: (fact) => fact.progress,
  });

  const progress =
    trigger.mode === "set" ? trigger.increment : previousProgress + trigger.increment;

  const unlocked = progress >= Option.getOrElse(definition.threshold, () => 1);
  const previousUnlock = Option.flatMap(existing, (fact) => fact.unlockedAt);
  const alreadyUnlocked = Option.isSome(previousUnlock);

  const unlockedAt = unlocked
    ? alreadyUnlocked
      ? previousUnlock
      : Option.some(now)
    : Option.none<IsoTimestamp>();

  return {
    definition,
    achievementId: definition.id,
    progress,
    unlockedAt,
    eventId: Option.isNone(definition.threshold) ? Option.some(trigger.eventId) : Option.none(),
    newlyUnlocked: unlocked && !alreadyUnlocked,
  };
};

/**
 * Decides the progress changes one trigger causes, without I/O.
 *
 * **Details**
 *
 * Threshold achievements stop advancing once unlocked. One-time event achievements keep counting
 * domain events after unlocking, but ignore a trigger ID they already applied; direct triggers never
 * advance an unlocked achievement.
 */
export function evaluateAchievementProgress(input: {
  readonly definitions: ReadonlyArray<AchievementDefinition>;
  /** The Viewer's current progress by achievement; absent definitions have not been started. */
  readonly progress: ReadonlyMap<AchievementId, AchievementProgressFact>;
  readonly trigger: AchievementTrigger;
  /** Unlock time recorded for achievements this trigger unlocks. */
  readonly now: IsoTimestamp;
  /** Whether the trigger came from `recordEvent` rather than a domain event; direct triggers never advance an unlocked achievement. */
  readonly direct: boolean;
}): ReadonlyArray<AchievementProgressDecision> {
  const decisions: AchievementProgressDecision[] = [];

  for (const definition of input.definitions) {
    const existing = Option.fromUndefinedOr(input.progress.get(definition.id));

    if (!achievementCanAdvance(definition, existing, input.trigger, input.direct)) continue;
    decisions.push(advanceAchievementProgress(definition, existing, input.trigger, input.now));
  }

  return decisions;
}

const songRequestAchievementTriggers = (
  event: Extract<DomainEvent, { type: "song_request_success" }>,
  streamOpener: boolean,
  nextStreak: number,
): ReadonlyArray<AchievementTrigger> => [
  { event: "song_request", increment: 1, mode: "increment", eventId: event.id },
  ...(streamOpener
    ? [
        {
          event: "stream_first_request",
          increment: 1,
          mode: "increment",
          eventId: `${event.id}-first-request`,
        } satisfies AchievementTrigger,
      ]
    : []),
  ...(nextStreak >= 3
    ? [
        {
          event: "request_streak",
          increment: nextStreak,
          mode: "set",
          eventId: `${event.id}-streak`,
        } satisfies AchievementTrigger,
      ]
    : []),
];

const raffleAchievementTriggers = (
  event: Extract<DomainEvent, { type: "raffle_roll" }>,
): ReadonlyArray<AchievementTrigger> => [
  { event: "raffle_roll", increment: 1, mode: "increment", eventId: event.id },
  ...(event.isWinner
    ? [
        {
          event: "raffle_win",
          increment: 1,
          mode: "increment",
          eventId: `${event.id}-win`,
        } satisfies AchievementTrigger,
      ]
    : []),
  ...(!event.isWinner && event.distance <= 100
    ? [
        {
          event: "raffle_close",
          increment: 1,
          mode: "increment",
          eventId: `${event.id}-close`,
        } satisfies AchievementTrigger,
      ]
    : []),
  ...(!event.isWinner && event.isNewRecord
    ? [
        {
          event: "raffle_closest_record",
          increment: 1,
          mode: "increment",
          eventId: `${event.id}-closest-record`,
        } satisfies AchievementTrigger,
      ]
    : []),
];

/**
 * Returns the achievement triggers one domain event produces.
 *
 * **Details**
 *
 * Every successful Song Request advances the Request Streak, even while offline; only a new online
 * Stream Session resets it. Stream transitions produce no triggers.
 */
export function achievementTriggersForEvent(input: {
  readonly event: DomainEvent;
  /** Whether this Song Request is the Stream Opener of the current Stream Session. */
  readonly streamOpener: boolean;
  /** The Viewer's Request Streak including this Song Request; three or more sets streak progress. */
  readonly nextStreak: number;
}): ReadonlyArray<AchievementTrigger> {
  switch (input.event.type) {
    case "stream_online":
    case "stream_offline":
      return [];
    case "song_request_success":
      return songRequestAchievementTriggers(input.event, input.streamOpener, input.nextStreak);
    case "raffle_roll":
      return raffleAchievementTriggers(input.event);
  }
}

/** Stream Session watermark the achievement authority accepted most recently; comparisons use instants, not text. */
export interface AchievementSession {
  readonly status: "online" | "offline";
  readonly streamId: Option.Option<StreamId>;
  /** Source start time of the online Stream Session; `None` while offline. */
  readonly startedAt: Option.Option<IsoTimestamp>;
  /** Source time of the accepted transition, used to reject stale transitions. */
  readonly transitionAt: IsoTimestamp;
}

/** Returns the online Stream Session start a Song Request must follow strictly to qualify as Stream Opener. */
export function achievementStreamOpenerStart(
  session: Option.Option<AchievementSession>,
  event: Extract<DomainEvent, { type: "song_request_success" }>,
): Option.Option<IsoTimestamp> {
  if (
    Option.isNone(session) ||
    session.value.status !== "online" ||
    Option.isNone(session.value.startedAt) ||
    Date.parse(event.timestamp) <= Date.parse(session.value.startedAt.value)
  )
    return Option.none();

  return session.value.startedAt;
}

/** Returns whether a stream transition is newer than the watermark and matches the current Stream Session. */
export function acceptsAchievementTransition(
  session: Option.Option<AchievementSession>,
  event: Extract<DomainEvent, { type: "stream_online" | "stream_offline" }>,
): boolean {
  if (Option.isNone(session)) return true;
  const current = session.value;

  if (event.type === "stream_online")
    return (
      Date.parse(event.startedAt) > Date.parse(current.transitionAt) &&
      !(current.status === "online" && Option.contains(current.streamId, event.streamId))
    );

  return current.status === "offline"
    ? Date.parse(event.endedAt) > Date.parse(current.transitionAt)
    : Option.contains(current.streamId, event.streamId) &&
        Date.parse(event.endedAt) >= Date.parse(current.transitionAt);
}
