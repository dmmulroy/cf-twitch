import { cfTwitchAnalyticsDataset } from "@cf-twitch/shared-infrastructure";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Context, Data, Effect, Layer, Option, Ref, Schema } from "effect";

/** Schema for an achievement unlock metric that carries its durable effect identity for downstream deduplication. */
export const TwitchAnalyticsAchievementUnlockMetric = Schema.Struct({
  /** Durable unlock effect identity that downstream queries use to deduplicate repeated writes. */
  effectId: Schema.NonEmptyString,
  /** Viewer display name at unlock time, kept for historical queries rather than identity. */
  user: Schema.String,
  achievementId: Schema.NonEmptyString,
  achievementName: Schema.String,
  category: Schema.String,
});

/** Achievement unlock analytics input whose callers own at-most-once durable claiming. */
export type TwitchAnalyticsAchievementUnlockMetric =
  typeof TwitchAnalyticsAchievementUnlockMetric.Type;

/** Schema for a chat command execution metric, which excludes the original chat message. */
export const TwitchAnalyticsChatCommandMetric = Schema.Struct({
  command: Schema.String,
  /** Stable Twitch user ID of the chatter. */
  userId: Schema.String,
  /** Chatter display name at command time. */
  userName: Schema.String,
  status: Schema.Literals(["success", "ignored", "error"]),
  durationMs: Schema.Number,
  /** Classified safe failure message; the stored value is truncated to 900 characters. */
  error: Schema.Option(Schema.String),
});

/** Chat command outcome used by historical Analytics Engine queries. */
export type TwitchAnalyticsChatCommandMetric = typeof TwitchAnalyticsChatCommandMetric.Type;

/** Schema for a durable workflow metric that keeps the historical saga index and lifecycle vocabulary. */
export const TwitchAnalyticsSagaLifecycleMetric = Schema.Struct({
  sagaType: Schema.Literals(["song-request-saga", "keyboard-raffle-saga", "raid-shoutout-saga"]),
  sagaId: Schema.String,
  event: Schema.Literals([
    "started",
    "step_started",
    "step_completed",
    "step_failed",
    "step_compensated",
    "step_compensation_failed",
    "fulfilled",
    "compensating",
    "completed",
    "failed",
  ]),
  /** Workflow step the event belongs to; absent for whole-workflow events. */
  stepName: Schema.Option(Schema.String),
  /** Classified safe failure message, never a provider payload; truncated to 900 characters. */
  error: Schema.Option(Schema.String),
  /** Elapsed milliseconds; written as `0` when absent. */
  durationMs: Schema.Option(Schema.Number),
});

/** Workflow outcome metric whose errors are classified safe messages, never provider payloads. */
export type TwitchAnalyticsSagaLifecycleMetric = typeof TwitchAnalyticsSagaLifecycleMetric.Type;

/** Schema for a song request metric that records fulfillment latency in milliseconds. */
export const TwitchAnalyticsSongRequestMetric = Schema.Struct({
  /** Requesting Viewer's display name at redemption time. */
  requester: Schema.String,
  trackId: Schema.String,
  trackName: Schema.String,
  status: Schema.Literals(["fulfilled", "failed"]),
  /** Milliseconds from the Twitch redemption time to the moment the outcome was recorded. */
  latencyMs: Schema.Number,
});

/** Song request Analytics Engine input. */
export type TwitchAnalyticsSongRequestMetric = typeof TwitchAnalyticsSongRequestMetric.Type;

/** Schema for a keyboard raffle metric that retains independent winning and viewer numbers. */
export const TwitchAnalyticsRaffleRollMetric = Schema.Struct({
  /** Viewer display name at roll time. */
  user: Schema.String,
  roll: Schema.Number,
  winningNumber: Schema.Number,
  /** Absolute difference between `roll` and `winningNumber`; zero, and only zero, is a win. */
  distance: Schema.Number,
  status: Schema.Literals(["win", "loss"]),
});

/** Keyboard raffle Analytics Engine input. */
export type TwitchAnalyticsRaffleRollMetric = typeof TwitchAnalyticsRaffleRollMetric.Type;

/**
 * Best-effort historical analytics whose ingestion failures never roll back a domain operation.
 *
 * **Details**
 *
 * Every method succeeds even when the Analytics Engine write fails; the failure is logged as a
 * warning instead.
 */
export interface ITwitchAnalytics {
  /** Writes one unlock metric after its caller durably claims delivery. */
  readonly writeAchievementUnlockMetric: (
    metric: TwitchAnalyticsAchievementUnlockMetric,
  ) => Effect.Effect<void>;
  /** Writes a command outcome without storing the incoming chat text. */
  readonly writeChatCommandMetric: (
    metric: TwitchAnalyticsChatCommandMetric,
  ) => Effect.Effect<void>;
  /** Writes a durable workflow transition after its owning state change. */
  readonly writeSagaLifecycleMetric: (
    metric: TwitchAnalyticsSagaLifecycleMetric,
  ) => Effect.Effect<void>;
  /** Writes fulfilled or failed song request latency. */
  readonly writeSongRequestMetric: (
    metric: TwitchAnalyticsSongRequestMetric,
  ) => Effect.Effect<void>;
  /** Writes a completed keyboard raffle outcome. */
  readonly writeRaffleRollMetric: (metric: TwitchAnalyticsRaffleRollMetric) => Effect.Effect<void>;
}

/** Analytics service that hides the native binding and its best-effort failure policy. */
export class TwitchAnalytics extends Context.Service<TwitchAnalytics, ITwitchAnalytics>()(
  "@cf-twitch/TwitchAnalytics",
) {}

/**
 * Effect that registers the Analytics Engine binding during init and defers metric writes to invocation.
 *
 * @returns The analytics service, or fails with `CfTwitchAnalyticsDatasetError` when the stage
 *   that names the dataset is unusable.
 * @throws A defect when planning runs without the Alchemy `Stage` service.
 */
export const makeTwitchAnalytics = Effect.gen(function* () {
  const dataset = yield* cfTwitchAnalyticsDataset;
  const writer = yield* Cloudflare.AnalyticsEngine.WriteDataset(dataset);

  const writeMetric = Effect.fn("TwitchAnalytics.writeMetric")(function* (
    index: string,
    blobs: string[],
    doubles: number[],
  ) {
    yield* writer.writeDataPoint({ indexes: [index], blobs, doubles }).pipe(
      // Alchemy's binding closes over env; the phantom requirement only marks runtime-only I/O.
      Effect.provide(RuntimeContext.phantom),
      Effect.catchTag("DatasetError", () =>
        Effect.logWarning(
          "Twitch analytics metric write failed in the Analytics Engine binding. The metric may be missing from analytics; the domain operation is unaffected and needs no retry.",
        ).pipe(Effect.annotateLogs({ metric: index, error_tag: "DatasetError" })),
      ),
    );
  });

  return TwitchAnalytics.of({
    writeAchievementUnlockMetric: Effect.fn("TwitchAnalytics.writeAchievementUnlockMetric")(
      function* (metric) {
        yield* writeMetric(
          "achievement_unlock",
          [
            metric.effectId,
            metric.user,
            metric.achievementId,
            metric.achievementName,
            metric.category,
          ],
          [],
        );
      },
    ),
    writeChatCommandMetric: Effect.fn("TwitchAnalytics.writeChatCommandMetric")(function* (metric) {
      yield* writeMetric(
        "chat-command",
        [
          metric.command,
          metric.userId,
          metric.userName,
          metric.status,
          Option.getOrElse(metric.error, () => "").slice(0, 900),
        ],
        [metric.durationMs],
      );
    }),
    writeSagaLifecycleMetric: Effect.fn("TwitchAnalytics.writeSagaLifecycleMetric")(
      function* (metric) {
        yield* writeMetric(
          metric.sagaType,
          [
            metric.sagaId,
            metric.event,
            Option.getOrElse(metric.stepName, () => ""),
            Option.getOrElse(metric.error, () => "").slice(0, 900),
          ],
          [Option.getOrElse(metric.durationMs, () => 0)],
        );
      },
    ),
    writeSongRequestMetric: Effect.fn("TwitchAnalytics.writeSongRequestMetric")(function* (metric) {
      yield* writeMetric(
        "song_request",
        [metric.requester, metric.trackId, metric.trackName, metric.status],
        [metric.latencyMs],
      );
    }),
    writeRaffleRollMetric: Effect.fn("TwitchAnalytics.writeRaffleRollMetric")(function* (metric) {
      yield* writeMetric(
        "raffle_roll",
        [metric.user, metric.status],
        [metric.roll, metric.winningNumber, metric.distance],
      );
    }),
  });
});

/** Layer that keeps the dataset binding requirement until the Worker or Durable Object selects its runtime. */
export const twitchAnalyticsLayerWithoutDependencies = Layer.effect(
  TwitchAnalytics,
  makeTwitchAnalytics,
);

/** Layer that writes metrics to the native Analytics Engine dataset owned by the current stage. */
export const twitchAnalyticsLayer = twitchAnalyticsLayerWithoutDependencies.pipe(
  Layer.provide(Cloudflare.AnalyticsEngine.WriteDatasetBinding),
);

/** One analytics call observed by `twitchAnalyticsTestLayer`. */
export type RecordedTwitchAnalyticsCall = Data.TaggedEnum<{
  readonly AchievementUnlockMetric: { readonly metric: TwitchAnalyticsAchievementUnlockMetric };
  readonly ChatCommandMetric: { readonly metric: TwitchAnalyticsChatCommandMetric };
  readonly SagaLifecycleMetric: { readonly metric: TwitchAnalyticsSagaLifecycleMetric };
  readonly SongRequestMetric: { readonly metric: TwitchAnalyticsSongRequestMetric };
  readonly RaffleRollMetric: { readonly metric: TwitchAnalyticsRaffleRollMetric };
}>;

/** Constructors for analytics calls observed by `twitchAnalyticsTestLayer`. */
export const RecordedTwitchAnalyticsCall = Data.taggedEnum<RecordedTwitchAnalyticsCall>();

/** Test-only reader for analytics calls made through the production `TwitchAnalytics` interface. */
export interface ITwitchAnalyticsRecording {
  /** Clears every analytics call observed by the current test Layer. */
  readonly clearRecordedTwitchAnalyticsCalls: () => Effect.Effect<void>;
  /** Reads analytics calls in their observed order. */
  readonly readRecordedTwitchAnalyticsCalls: () => Effect.Effect<
    ReadonlyArray<RecordedTwitchAnalyticsCall>
  >;
}

/** Test control service for recorded analytics calls; production composition never provides it. */
export class TwitchAnalyticsRecording extends Context.Service<
  TwitchAnalyticsRecording,
  ITwitchAnalyticsRecording
>()("@cf-twitch/test/TwitchAnalyticsRecording") {}

/**
 * Layer that records every `TwitchAnalytics` write in memory instead of using a native dataset.
 *
 * **Details**
 *
 * Provides both `TwitchAnalytics` and `TwitchAnalyticsRecording` over one shared recording. Like
 * production, every write succeeds.
 */
export const twitchAnalyticsTestLayer = Layer.effectContext(
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
