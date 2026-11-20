import { Context, Effect, Layer, Match, Option, Ref, Schema } from "effect";
import * as Cloudflare from "@alchemy.run/cloudflare";

/** Error raised when Durable Object storage rejects an alarm read or update; callers keep their durable retry evidence. */
export class WorkflowAlarmError extends Schema.TaggedError<WorkflowAlarmError>()(
  "WorkflowAlarmError",
  {
    /** Alarm operation that storage rejected. */
    operation: Schema.Literals(["set-alarm", "delete-alarm", "get-alarm"]),
    /** Durable Object storage rejected the alarm read or update. */
    reason: Schema.Literal("storage_rejected"),
    /** Requested wake-up time in epoch milliseconds, absent when cancelling or reading. */
    dueAt: Schema.OptionFromNullOr(Schema.Number),
  },
) {
  /** Alarm failure message naming the rejected alarm operation. */
  override get message(): string {
    return Match.value(this.operation).pipe(
      Match.when(
        "set-alarm",
        () =>
          "Workflow alarm set-alarm failed because Durable Object storage rejected the update. Retry the operation; setting the same alarm again is idempotent.",
      ),
      Match.when(
        "delete-alarm",
        () =>
          "Workflow alarm delete-alarm failed because Durable Object storage rejected the update. Retry the operation; deleting the alarm again is idempotent.",
      ),
      Match.when(
        "get-alarm",
        () =>
          "Workflow alarm get-alarm failed because Durable Object storage rejected the read. Retry the read.",
      ),
      Match.exhaustive,
    );
  }
}

/** Durable wake-up authority for one Durable Object; timestamps are epoch milliseconds. */
export interface IWorkflowAlarm {
  /**
   * Schedules the object's single alarm, or cancels it when `dueAt` is `None`.
   *
   * @returns Nothing, or fails with `WorkflowAlarmError` when storage rejects the update.
   */
  readonly set: (dueAt: Option.Option<number>) => Effect.Effect<void, WorkflowAlarmError>;
  /**
   * Returns the currently scheduled alarm time, or `None` when no alarm is pending.
   *
   * @returns The scheduled time, or fails with `WorkflowAlarmError` when storage rejects the read.
   */
  readonly get: () => Effect.Effect<Option.Option<number>, WorkflowAlarmError>;
}

/** Service tag for the durable alarm capability, keeping Cloudflare storage outside business policy. */
export class WorkflowAlarm extends Context.Service<WorkflowAlarm, IWorkflowAlarm>()(
  "@cf-twitch/WorkflowAlarm",
) {}

/** Effect that builds the native alarm adapter over the current Durable Object's storage, only in the runtime phase. */
export const makeWorkflowAlarm = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;

  const set = Effect.fn("WorkflowAlarm.set")((dueAt: Option.Option<number>) =>
    Effect.tryPromise({
      try: () =>
        Option.isSome(dueAt)
          ? state.raw.storage.setAlarm(dueAt.value)
          : state.raw.storage.deleteAlarm(),
      catch: () =>
        new WorkflowAlarmError({
          operation: Option.isSome(dueAt) ? "set-alarm" : "delete-alarm",
          reason: "storage_rejected",
          dueAt,
        }),
    }),
  );

  const get = Effect.fn("WorkflowAlarm.get")(() =>
    Effect.tryPromise({
      try: () => state.raw.storage.getAlarm(),
      catch: () =>
        new WorkflowAlarmError({
          operation: "get-alarm",
          reason: "storage_rejected",
          dueAt: Option.none(),
        }),
    }).pipe(Effect.map(Option.fromNullOr)),
  );

  return WorkflowAlarm.of({ set, get });
});

/** Layer that provides the native alarm adapter; requires the runtime `DurableObjectState`. */
export const workflowAlarmLayerWithoutDependencies = Layer.effect(WorkflowAlarm, makeWorkflowAlarm);

/** Production alarm Layer; the Durable Object runtime supplies its own state. */
export const workflowAlarmLayer = workflowAlarmLayerWithoutDependencies;

/** Layer that provides an in-memory alarm holding one pending wake-up time, like a Durable Object. */
export const workflowAlarmTestLayer = Layer.effect(
  WorkflowAlarm,
  Effect.gen(function* () {
    const scheduled = yield* Ref.make(Option.none<number>());

    return WorkflowAlarm.of({
      set: (dueAt) => Ref.set(scheduled, dueAt),
      get: () => Ref.get(scheduled),
    });
  }),
);
