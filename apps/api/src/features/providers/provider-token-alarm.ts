import { ProviderError, type ProviderOperation } from "@cf-twitch/contracts/provider";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Context, Effect, Layer, Option, Ref } from "effect";
import { ProviderTokenIdentity } from "./provider-token-identity.ts";

/** Scheduler of the single refresh alarm of one provider token Durable Object. */
export interface IProviderTokenAlarm {
  /**
   * Schedules the refresh alarm at a Unix millisecond deadline, replacing any earlier one.
   *
   * @returns Nothing, or fails with `ProviderError` reason `persistence` when the alarm cannot be stored.
   */
  readonly setAlarm: (atMs: number) => Effect.Effect<void, ProviderError>;
  /**
   * Cancels the refresh alarm.
   *
   * @returns Nothing, or fails with `ProviderError` reason `persistence` when the alarm cannot be removed.
   */
  readonly deleteAlarm: () => Effect.Effect<void, ProviderError>;
}

/** Service that schedules provider token refresh alarms; SQL persists the repairable intent separately. */
export class ProviderTokenAlarm extends Context.Service<ProviderTokenAlarm, IProviderTokenAlarm>()(
  "@cf-twitch/ProviderTokenAlarm",
) {}

/** Creates the provider token alarm over the running Durable Object's native alarm storage. */
export const makeProviderTokenAlarm = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const provider = yield* ProviderTokenIdentity;

  const failure = (operation: ProviderOperation) => () =>
    new ProviderError({
      provider,
      operation,
      reason: "persistence",
      status: Option.none(),
      retryAfterMs: Option.none(),
    });

  return ProviderTokenAlarm.of({
    setAlarm: Effect.fn("ProviderTokenAlarm.setAlarm")((atMs) =>
      Effect.tryPromise({
        try: () => state.raw.storage.setAlarm(atMs),
        catch: failure("setTokenAlarm"),
      }),
    ),
    deleteAlarm: Effect.fn("ProviderTokenAlarm.deleteAlarm")(() =>
      Effect.tryPromise({
        try: () => state.raw.storage.deleteAlarm(),
        catch: failure("deleteTokenAlarm"),
      }),
    ),
  });
});

/** Layer that provides the provider token alarm with Durable Object state and provider identity requirements visible. */
export const providerTokenAlarmLayerWithoutDependencies = Layer.effect(
  ProviderTokenAlarm,
  makeProviderTokenAlarm,
);

/** Production provider token alarm Layer; native alarm storage is a Workers runtime binding, not an application dependency. */
export const providerTokenAlarmLayer = providerTokenAlarmLayerWithoutDependencies;

/** Layer that provides an in-memory provider token alarm holding the latest scheduled deadline; nothing fires it automatically. */
export const providerTokenAlarmTestLayer = Layer.effect(
  ProviderTokenAlarm,
  Effect.gen(function* () {
    const deadline = yield* Ref.make(Option.none<number>());

    return ProviderTokenAlarm.of({
      setAlarm: Effect.fn("ProviderTokenAlarmTest.setAlarm")((atMs) =>
        Ref.set(deadline, Option.some(atMs)),
      ),
      deleteAlarm: Effect.fn("ProviderTokenAlarmTest.deleteAlarm")(() =>
        Ref.set(deadline, Option.none()),
      ),
    });
  }),
);
