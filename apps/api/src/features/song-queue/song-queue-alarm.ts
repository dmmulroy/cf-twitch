import * as Cloudflare from "@alchemy.run/cloudflare";
import { Context, Effect, Layer } from "effect";
import { SongQueueError } from "@cf-twitch/contracts/song-queue";

/** Song queue alarm scheduling, backed by the Durable Object's platform alarm. */
export interface ISongQueueAlarm {
  /**
   * Replaces the single platform alarm with one due at `dueAt` (epoch milliseconds).
   *
   * @returns Nothing, or fails with `SongQueueError` whose reason is `coordination_unavailable`
   *   when the platform rejects the alarm.
   */
  readonly scheduleAlarm: (dueAt: number) => Effect.Effect<void, SongQueueError>;
}

/** Service for the one physical alarm that wakes both durable refresh and Pending Request cleanup. */
export class SongQueueAlarm extends Context.Service<SongQueueAlarm, ISongQueueAlarm>()(
  "@cf-twitch/SongQueueAlarm",
) {}

/**
 * Creates the song queue alarm over the Durable Object's storage alarm.
 *
 * **Gotchas**
 *
 * Construct only inside the Durable Object runtime phase, where `DurableObjectState` is real.
 *
 * @returns The alarm service; `scheduleAlarm` fails with `SongQueueError` when `setAlarm` rejects.
 */
export const makeSongQueueAlarm = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;

  return SongQueueAlarm.of({
    scheduleAlarm: Effect.fn("SongQueueAlarm.scheduleAlarm")((dueAt) =>
      Effect.tryPromise({
        try: () => state.raw.storage.setAlarm(dueAt),
        catch: () =>
          new SongQueueError({ operation: "scheduleAlarm", reason: "coordination_unavailable" }),
      }),
    ),
  });
});

/** Layer that provides the song queue alarm, leaving the Durable Object state visible. */
export const songQueueAlarmLayerWithoutDependencies = Layer.effect(
  SongQueueAlarm,
  makeSongQueueAlarm,
);

/** Layer that provides the song queue alarm; the Durable Object state is a runtime binding. */
export const songQueueAlarmLayer = songQueueAlarmLayerWithoutDependencies;

/**
 * Layer that provides a song queue alarm that accepts every schedule without firing.
 *
 * **Details**
 *
 * Nothing fires the alarm, so tests drive alarm work by calling the coordinator's `runAlarm`.
 */
export const songQueueAlarmTestLayer = Layer.succeed(
  SongQueueAlarm,
  SongQueueAlarm.of({ scheduleAlarm: () => Effect.void }),
);
