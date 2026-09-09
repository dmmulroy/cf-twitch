import { Context, Effect, Layer, Ref } from "effect";

import {
  TwitchAnalytics,
  type AchievementUnlockMetric,
  type ChatCommandMetric,
  type RaffleRollMetric,
  type SagaLifecycleMetric,
  type SongRequestMetric,
} from "../../src/runtime/twitch-analytics.ts";

/** One analytics call recorded by the controlled scenario boundary. */
export type RecordedTwitchAnalyticsCall =
  | { readonly _tag: "AchievementUnlockMetric"; readonly metric: AchievementUnlockMetric }
  | { readonly _tag: "ChatCommandMetric"; readonly metric: ChatCommandMetric }
  | { readonly _tag: "SagaLifecycleMetric"; readonly metric: SagaLifecycleMetric }
  | { readonly _tag: "SongRequestMetric"; readonly metric: SongRequestMetric }
  | { readonly _tag: "RaffleRollMetric"; readonly metric: RaffleRollMetric };

/** Test-only reader for analytics calls made through the production TwitchAnalytics interface. */
export interface ITwitchAnalyticsRecording {
  /** Clear every analytics call observed by the current test Layer. */
  readonly clearRecordedTwitchAnalyticsCalls: () => Effect.Effect<void>;
  /** Read analytics calls in their observed order. */
  readonly readRecordedTwitchAnalyticsCalls: () => Effect.Effect<
    ReadonlyArray<RecordedTwitchAnalyticsCall>
  >;
}

/** Scenario-test control surface; it is never provided by production composition. */
export class TwitchAnalyticsRecording extends Context.Service<
  TwitchAnalyticsRecording,
  ITwitchAnalyticsRecording
>()("@cf-twitch/test/TwitchAnalyticsRecording") {}

/** Controlled analytics boundary implementing all five production metric methods. */
export const recordingTwitchAnalyticsLayer = Layer.effectContext(
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<RecordedTwitchAnalyticsCall>>([]);

    const recordCall = (call: RecordedTwitchAnalyticsCall) =>
      Ref.update(calls, (recordedCalls) => [...recordedCalls, call]);

    const analytics = TwitchAnalytics.of({
      writeAchievementUnlockMetric: (metric) =>
        recordCall({ _tag: "AchievementUnlockMetric", metric }),
      writeChatCommandMetric: (metric) => recordCall({ _tag: "ChatCommandMetric", metric }),
      writeSagaLifecycleMetric: (metric) => recordCall({ _tag: "SagaLifecycleMetric", metric }),
      writeSongRequestMetric: (metric) => recordCall({ _tag: "SongRequestMetric", metric }),
      writeRaffleRollMetric: (metric) => recordCall({ _tag: "RaffleRollMetric", metric }),
    });

    const recording = TwitchAnalyticsRecording.of({
      clearRecordedTwitchAnalyticsCalls: Effect.fn(
        "TwitchAnalyticsRecording.clearRecordedTwitchAnalyticsCalls",
      )(function* () {
        yield* Ref.set(calls, []);
      }),
      readRecordedTwitchAnalyticsCalls: Effect.fn(
        "TwitchAnalyticsRecording.readRecordedTwitchAnalyticsCalls",
      )(function* () {
        return yield* Ref.get(calls);
      }),
    });

    return Context.make(TwitchAnalytics, analytics).pipe(
      Context.add(TwitchAnalyticsRecording, recording),
    );
  }),
);
