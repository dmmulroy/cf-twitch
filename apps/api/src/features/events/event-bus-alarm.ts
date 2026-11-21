import * as Cloudflare from "@alchemy.run/cloudflare";
import { Context, Effect, Layer, Option, Ref } from "effect";
import { EventBusError } from "@cf-twitch/contracts/event-bus";
import type { IsoTimestamp } from "@cf-twitch/contracts/identity";

/** Wake-up capability used to rebuild retry and dead-letter expiry timers from durable Event Bus rows. */
export interface IEventBusAlarm {
  /**
   * Schedules the next Event Bus wake-up, replacing any earlier one.
   *
   * @returns Nothing, or fails with `EventBusError` (`alarm_unavailable`) when the alarm cannot be
   * set; pending rows stay stored and the next rebuild reschedules them.
   */
  readonly scheduleAt: (timestamp: IsoTimestamp) => Effect.Effect<void, EventBusError>;
  /**
   * Cancels the Event Bus wake-up when no retry or expiry is due.
   *
   * @returns Nothing, or fails with `EventBusError` (`alarm_unavailable`) when the alarm cannot be cleared.
   */
  readonly clear: () => Effect.Effect<void, EventBusError>;
}

/** Service for the Event Bus wake-up backed by Durable Object storage alarms. */
export class EventBusAlarm extends Context.Service<EventBusAlarm, IEventBusAlarm>()(
  "@cf-twitch/EventBusAlarm",
) {}

const alarmUnavailable = () =>
  new EventBusError({
    operation: "scheduleAlarm",
    reason: "alarm_unavailable",
    eventId: Option.none(),
  });

/**
 * Creates the alarm adapter over the Durable Object's native storage alarm.
 *
 * **Details**
 *
 * Must run only in the Durable Object runtime phase; raw Promise interop is confined here.
 *
 * @returns The alarm service; constructing it does not fail.
 */
export const makeEventBusAlarm = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;

  return EventBusAlarm.of({
    scheduleAt: (timestamp) =>
      Effect.tryPromise({
        try: () => state.raw.storage.setAlarm(new Date(timestamp)),
        catch: alarmUnavailable,
      }),
    clear: () =>
      Effect.tryPromise({
        try: () => state.raw.storage.deleteAlarm(),
        catch: alarmUnavailable,
      }),
  });
});

/** Layer that provides the native alarm adapter and keeps its Durable Object state requirement visible. */
export const eventBusAlarmLayerWithoutDependencies = Layer.effect(EventBusAlarm, makeEventBusAlarm);

/** Production alarm Layer; Durable Object state is a Workers runtime binding supplied by `EventBusServer`. */
export const eventBusAlarmLayer = eventBusAlarmLayerWithoutDependencies;

/** Layer that provides an in-memory alarm which records the next scheduled wake-up without firing it. */
export const eventBusAlarmTestLayer = Layer.effect(
  EventBusAlarm,
  Effect.gen(function* () {
    const scheduled = yield* Ref.make(Option.none<IsoTimestamp>());

    return EventBusAlarm.of({
      scheduleAt: (timestamp) => Ref.set(scheduled, Option.some(timestamp)),
      clear: () => Ref.set(scheduled, Option.none()),
    });
  }),
);
