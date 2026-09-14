import { Option } from "effect";
import type { AchievementDefinition, AchievementId } from "@cf-twitch/contracts/achievement";
import type { DomainEvent } from "@cf-twitch/contracts/domain-event";
import type { IsoTimestamp, StreamId } from "@cf-twitch/contracts/identity";

/** Progress facts contain domain options, not nullable SQLite fields. */
export interface AchievementProgressFact {
  readonly achievementId: AchievementId;
  readonly progress: number;
  readonly unlockedAt: Option.Option<IsoTimestamp>;
  readonly eventId: Option.Option<string>;
}

/** Progress decision retains the first unlock time, even for repeated one-time events. */
export interface AchievementProgressDecision extends AchievementProgressFact {
  readonly definition: AchievementDefinition;
  readonly newlyUnlocked: boolean;
}

/** Trigger increment can set streak progress rather than adding it cumulatively. */
export interface AchievementTrigger {
  readonly event: AchievementDefinition["triggerEvent"];
  readonly increment: number;
  readonly mode: "increment" | "set";
  readonly eventId: string;
}

const achievementCanAdvance = (
  definition: AchievementDefinition,
  existing: AchievementProgressFact | undefined,
  trigger: AchievementTrigger,
  direct: boolean,
): boolean => {
  if (definition.triggerEvent !== trigger.event) return false;

  if (
    existing &&
    Option.isSome(existing.unlockedAt) &&
    (direct || Option.isSome(definition.threshold))
  )
    return false;

  return !(
    Option.isNone(definition.threshold) &&
    existing &&
    Option.contains(existing.eventId, trigger.eventId)
  );
};

const advanceAchievementProgress = (
  definition: AchievementDefinition,
  existing: AchievementProgressFact | undefined,
  trigger: AchievementTrigger,
  now: IsoTimestamp,
): AchievementProgressDecision => {
  const progress =
    trigger.mode === "set" ? trigger.increment : (existing?.progress ?? 0) + trigger.increment;

  const unlocked = progress >= Option.getOrElse(definition.threshold, () => 1);
  const alreadyUnlocked = existing !== undefined && Option.isSome(existing.unlockedAt);

  const unlockedAt = unlocked
    ? alreadyUnlocked
      ? existing.unlockedAt
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

/** Evaluate one trigger without I/O; threshold unlocks freeze, one-time progress may keep growing. */
export function evaluateAchievementProgress(input: {
  readonly definitions: ReadonlyArray<AchievementDefinition>;
  readonly progress: ReadonlyMap<AchievementId, AchievementProgressFact>;
  readonly trigger: AchievementTrigger;
  readonly now: IsoTimestamp;
  readonly direct: boolean;
}): ReadonlyArray<AchievementProgressDecision> {
  const decisions: AchievementProgressDecision[] = [];

  for (const definition of input.definitions) {
    const existing = input.progress.get(definition.id);

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

/** All successful requests advance streaks, even offline; only a new online session resets them. */
export function achievementTriggersForEvent(input: {
  readonly event: DomainEvent;
  readonly streamOpener: boolean;
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

/** Stream watermark comparisons use instants, not lexical timezone representations. */
export interface AchievementSession {
  readonly status: "online" | "offline";
  readonly streamId: Option.Option<StreamId>;
  readonly startedAt: Option.Option<IsoTimestamp>;
  readonly transitionAt: IsoTimestamp;
}

/** Return the accepted online session start for a possible Stream Opener request. */
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

/** Reject stale and mismatched stream transitions without resetting session progress. */
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
