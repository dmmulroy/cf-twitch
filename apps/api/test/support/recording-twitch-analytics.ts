import { Context, Data, Effect, Layer, Ref } from "effect";

import {
  TwitchAnalytics,
  type AchievementUnlockMetric,
  type ChatCommandMetric,
  type RaffleRollMetric,
  type SagaLifecycleMetric,
  type SongRequestMetric,
} from "../../src/runtime/twitch-analytics.ts";

/** One analytics call recorded by the controlled scenario boundary. */
export type RecordedTwitchAnalyticsCall = Data.TaggedEnum<{
  readonly AchievementUnlockMetric: { readonly metric: AchievementUnlockMetric };
  readonly ChatCommandMetric: { readonly metric: ChatCommandMetric };
  readonly SagaLifecycleMetric: { readonly metric: SagaLifecycleMetric };
  readonly SongRequestMetric: { readonly metric: SongRequestMetric };
  readonly RaffleRollMetric: { readonly metric: RaffleRollMetric };
}>;

/** Constructors for analytics calls recorded by the controlled scenario boundary. */
export const RecordedTwitchAnalyticsCall = Data.taggedEnum<RecordedTwitchAnalyticsCall>();

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
        recordCall(RecordedTwitchAnalyticsCall.AchievementUnlockMetric({ metric })),
      writeChatCommandMetric: (metric) =>
        recordCall(RecordedTwitchAnalyticsCall.ChatCommandMetric({ metric })),
      writeSagaLifecycleMetric: (metric) =>
        recordCall(RecordedTwitchAnalyticsCall.SagaLifecycleMetric({ metric })),
      writeSongRequestMetric: (metric) =>
        recordCall(RecordedTwitchAnalyticsCall.SongRequestMetric({ metric })),
      writeRaffleRollMetric: (metric) =>
        recordCall(RecordedTwitchAnalyticsCall.RaffleRollMetric({ metric })),
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
