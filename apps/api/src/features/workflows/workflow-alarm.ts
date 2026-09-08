import { Context, Effect, Layer, Option, Schema } from "effect";
import * as Cloudflare from "alchemy/Cloudflare";

/** Alarm failures never erase durable retry evidence. */
export class WorkflowAlarmError extends Schema.TaggedError<WorkflowAlarmError>()(
  "WorkflowAlarmError",
  {
    message: Schema.String,
  },
) {}
/** Durable wake-up authority; timestamps are epoch milliseconds and None cancels the alarm. */
export interface IWorkflowAlarm {
  readonly set: (dueAt: Option.Option<number>) => Effect.Effect<void, WorkflowAlarmError>;
}
/** Durable alarm capability keeps Cloudflare storage outside business policy. */
export class WorkflowAlarm extends Context.Service<WorkflowAlarm, IWorkflowAlarm>()(
  "@cf-twitch/WorkflowAlarm",
) {}
/** Construct the native alarm adapter only in the returned runtime Effect, never planning. */
export const makeWorkflowAlarm = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  return WorkflowAlarm.of({
    set: Effect.fn("WorkflowAlarm.set")((dueAt) =>
      Effect.tryPromise({
        try: () =>
          Option.isSome(dueAt)
            ? state.raw.storage.setAlarm(dueAt.value)
            : state.raw.storage.deleteAlarm(),
        catch: () =>
          new WorkflowAlarmError({
            message: "Workflow alarm coordination failed; persisted retry remains recoverable",
          }),
      }),
    ),
  });
});
/** Native runtime alarm Layer; raw Promise interop is confined to this platform adapter. */
export const workflowAlarmLayer = Layer.effect(WorkflowAlarm, makeWorkflowAlarm);
