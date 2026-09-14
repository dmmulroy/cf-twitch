import { cfTwitchAnalyticsDataset } from "@cf-twitch/shared-infrastructure";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, Layer, Option, Schema } from "effect";

/** Achievement unlock metric carries its durable effect identity for downstream deduplication. */
export const AchievementUnlockMetric = Schema.Struct({
  effectId: Schema.NonEmptyString,
  user: Schema.String,
  achievementId: Schema.NonEmptyString,
  achievementName: Schema.String,
  category: Schema.String,
});

/** Achievement unlock analytics input; callers own at-most-once durable claiming. */
export type AchievementUnlockMetric = typeof AchievementUnlockMetric.Type;

/** Chat command execution metric excludes the original chat message. */
export const ChatCommandMetric = Schema.Struct({
  command: Schema.String,
  userId: Schema.String,
  userName: Schema.String,
  status: Schema.Literals(["success", "ignored", "error"]),
  durationMs: Schema.Number,
  error: Schema.Option(Schema.String),
});

/** Chat command outcome used by historical Analytics Engine queries. */
export type ChatCommandMetric = typeof ChatCommandMetric.Type;

/** Durable workflow metric keeps the historical saga index and lifecycle vocabulary. */
export const SagaLifecycleMetric = Schema.Struct({
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
  stepName: Schema.Option(Schema.String),
  error: Schema.Option(Schema.String),
  durationMs: Schema.Option(Schema.Number),
});

/** Workflow outcome metric; errors must be classified safe messages, never provider payloads. */
export type SagaLifecycleMetric = typeof SagaLifecycleMetric.Type;

/** Song request metric records fulfillment latency in milliseconds. */
export const SongRequestMetric = Schema.Struct({
  requester: Schema.String,
  trackId: Schema.String,
  trackName: Schema.String,
  status: Schema.Literals(["fulfilled", "failed"]),
  latencyMs: Schema.Number,
});

/** Song request Analytics Engine input. */
export type SongRequestMetric = typeof SongRequestMetric.Type;

/** Keyboard raffle metric retains independent winning and viewer numbers. */
export const RaffleRollMetric = Schema.Struct({
  user: Schema.String,
  roll: Schema.Number,
  winningNumber: Schema.Number,
  distance: Schema.Number,
  status: Schema.Literals(["win", "loss"]),
});

/** Keyboard raffle Analytics Engine input. */
export type RaffleRollMetric = typeof RaffleRollMetric.Type;

/** Best-effort historical analytics; ingestion failure never rolls back a domain operation. */
export interface ITwitchAnalytics {
  /** Attempt one unlock metric after its caller durably claims delivery. */
  readonly writeAchievementUnlockMetric: (metric: AchievementUnlockMetric) => Effect.Effect<void>;
  /** Record command outcome without storing the incoming chat text. */
  readonly writeChatCommandMetric: (metric: ChatCommandMetric) => Effect.Effect<void>;
  /** Record the durable workflow transition after its owning state change. */
  readonly writeSagaLifecycleMetric: (metric: SagaLifecycleMetric) => Effect.Effect<void>;
  /** Record fulfilled or failed song request latency. */
  readonly writeSongRequestMetric: (metric: SongRequestMetric) => Effect.Effect<void>;
  /** Record a completed keyboard raffle outcome. */
  readonly writeRaffleRollMetric: (metric: RaffleRollMetric) => Effect.Effect<void>;
}

/** Analytics authority hides the native binding and its best-effort failure policy. */
export class TwitchAnalytics extends Context.Service<TwitchAnalytics, ITwitchAnalytics>()(
  "@cf-twitch/TwitchAnalytics",
) {}

/** Register the Analytics Engine binding during init; defer all metric writes until invocation. */
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
        Effect.logWarning("Twitch analytics metric write failed").pipe(
          Effect.annotateLogs({ metric: index, error_tag: "DatasetError" }),
        ),
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

/** Preserve binding requirements until the Worker or Durable Object selects its runtime. */
export const twitchAnalyticsLayerWithoutDependencies = Layer.effect(
  TwitchAnalytics,
  makeTwitchAnalytics,
);

/** Native Analytics Engine implementation using a stage-owned dataset. */
export const twitchAnalyticsLayer = twitchAnalyticsLayerWithoutDependencies.pipe(
  Layer.provide(Cloudflare.AnalyticsEngine.WriteDatasetBinding),
);
