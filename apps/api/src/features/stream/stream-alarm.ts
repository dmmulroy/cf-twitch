import * as Cloudflare from "@alchemy.run/cloudflare";
import { Context, Effect, Layer } from "effect";
import type { IsoTimestamp } from "@cf-twitch/contracts/identity";
import { StreamLifecycleError } from "@cf-twitch/contracts/stream";

/** Stream Lifecycle alarm scheduling, backed by the Durable Object's platform alarm. */
export interface IStreamAlarm {
  /**
   * Replaces the single platform alarm with one due at `timestamp`.
   *
   * @returns Nothing, or fails with `StreamLifecycleError` whose reason is
   *   `persistence_unavailable` when the platform rejects the alarm.
   */
  readonly scheduleAt: (timestamp: IsoTimestamp) => Effect.Effect<void, StreamLifecycleError>;
  /**
   * Deletes the platform alarm, if any.
   *
   * @returns Nothing, or fails with `StreamLifecycleError` whose reason is
   *   `persistence_unavailable` when the platform rejects the deletion.
   */
  readonly clear: () => Effect.Effect<void, StreamLifecycleError>;
}

/** Service for the alarm that drives viewer polling and incomplete transition recovery. */
export class StreamAlarm extends Context.Service<StreamAlarm, IStreamAlarm>()(
  "@cf-twitch/StreamAlarm",
) {}

/**
 * Creates the Stream Lifecycle alarm over the Durable Object's storage alarm.
 *
 * **Gotchas**
 *
 * Construct only inside the Durable Object runtime phase, where `DurableObjectState` is real.
 *
 * @returns The alarm service; its operations fail with `StreamLifecycleError` when the platform
 *   rejects them.
 */
export const makeStreamAlarm = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;

  return StreamAlarm.of({
    scheduleAt: Effect.fn("StreamAlarm.scheduleAt")((timestamp) =>
      Effect.tryPromise({
        try: () => state.raw.storage.setAlarm(new Date(timestamp)),
        catch: () =>
          new StreamLifecycleError({
            operation: "scheduleAlarm",
            reason: "persistence_unavailable",
          }),
      }),
    ),
    clear: Effect.fn("StreamAlarm.clear")(() =>
      Effect.tryPromise({
        try: () => state.raw.storage.deleteAlarm(),
        catch: () =>
          new StreamLifecycleError({ operation: "clearAlarm", reason: "persistence_unavailable" }),
      }),
    ),
  });
});

/** Layer that provides the Stream Lifecycle alarm, leaving the Durable Object state visible. */
export const streamAlarmLayerWithoutDependencies = Layer.effect(StreamAlarm, makeStreamAlarm);

/** Layer that provides the Stream Lifecycle alarm; the Durable Object state is a runtime binding. */
export const streamAlarmLayer = streamAlarmLayerWithoutDependencies;

/**
 * Layer that provides a Stream Lifecycle alarm that accepts every schedule without firing.
 *
 * **Details**
 *
 * Nothing fires the alarm, so tests drive alarm work by calling `processAlarm` directly.
 */
export const streamAlarmTestLayer = Layer.succeed(
  StreamAlarm,
  StreamAlarm.of({ scheduleAt: () => Effect.void, clear: () => Effect.void }),
);
