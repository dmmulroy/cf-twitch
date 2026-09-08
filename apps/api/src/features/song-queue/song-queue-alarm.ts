import * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, Layer } from "effect";
import { SongQueueError } from "@cf-twitch/contracts/song-queue";

/** Song queue alarm scheduling is a platform resource, not an in-memory timer. */
export interface ISongQueueAlarm {
  readonly scheduleAlarm: (dueAt: number) => Effect.Effect<void, SongQueueError>;
}
/** One physical alarm wakes both durable refresh and pending cleanup intent. */
export class SongQueueAlarm extends Context.Service<SongQueueAlarm, ISongQueueAlarm>()(
  "@cf-twitch/SongQueueAlarm",
) {}

/** Construct the song queue alarm only inside the Durable Object runtime phase. */
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
/** Song queue platform alarm Layer retains its instance-local state requirement. */
export const songQueueAlarmLayer = Layer.effect(SongQueueAlarm, makeSongQueueAlarm);
