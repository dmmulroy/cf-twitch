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
    if (definition.triggerEvent !== input.trigger.event) continue;
    const existing = input.progress.get(definition.id);
    if (
      existing &&
      Option.isSome(existing.unlockedAt) &&
      (input.direct || Option.isSome(definition.threshold))
    )
      continue;
    if (
      Option.isNone(definition.threshold) &&
      existing &&
      Option.contains(existing.eventId, input.trigger.eventId)
    )
      continue;
    const progress =
      input.trigger.mode === "set"
        ? input.trigger.increment
        : (existing?.progress ?? 0) + input.trigger.increment;
    const unlocked = progress >= Option.getOrElse(definition.threshold, () => 1);
    const unlockedAt = unlocked
      ? existing && Option.isSome(existing.unlockedAt)
        ? existing.unlockedAt
        : Option.some(input.now)
      : Option.none<IsoTimestamp>();
    decisions.push({
      definition,
      achievementId: definition.id,
      progress,
      unlockedAt,
      eventId: Option.isNone(definition.threshold)
        ? Option.some(input.trigger.eventId)
        : Option.none(),
      newlyUnlocked: unlocked && (!existing || Option.isNone(existing.unlockedAt)),
    });
  }
  return decisions;
}
/** All successful requests advance streaks, even offline; only a new online session resets them. */
export function achievementTriggersForEvent(input: {
  readonly event: DomainEvent;
  readonly streamOpener: boolean;
  readonly nextStreak: number;
}): ReadonlyArray<AchievementTrigger> {
  const event = input.event;
  switch (event.type) {
    case "stream_online":
    case "stream_offline":
      return [];
    case "song_request_success":
      return [
        { event: "song_request", increment: 1, mode: "increment", eventId: event.id },
        ...(input.streamOpener
          ? [
              {
                event: "stream_first_request",
                increment: 1,
                mode: "increment",
                eventId: `${event.id}-first-request`,
              } satisfies AchievementTrigger,
            ]
          : []),
        ...(input.nextStreak >= 3
          ? [
              {
                event: "request_streak",
                increment: input.nextStreak,
                mode: "set",
                eventId: `${event.id}-streak`,
              } satisfies AchievementTrigger,
            ]
          : []),
      ];
    case "raffle_roll":
      return [
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
  }
}
/** Stream watermark comparisons use instants, not lexical timezone representations. */
export interface AchievementSession {
  readonly status: "online" | "offline";
  readonly streamId: Option.Option<StreamId>;
  readonly startedAt: Option.Option<IsoTimestamp>;
  readonly transitionAt: IsoTimestamp;
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
