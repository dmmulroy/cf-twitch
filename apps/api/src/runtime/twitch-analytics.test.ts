import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  TwitchAnalytics,
  TwitchAnalyticsRecording,
  twitchAnalyticsTestLayer,
} from "./twitch-analytics.ts";

it.effect(
  "twitchAnalyticsTestLayer records every analytics write in order and clears on request",
  () =>
    Effect.gen(function* () {
      const analytics = yield* TwitchAnalytics;
      const recording = yield* TwitchAnalyticsRecording;

      yield* analytics.writeAchievementUnlockMetric({
        effectId: "event:achievement",
        user: "viewer",
        achievementId: "first_request",
        achievementName: "First Timer",
        category: "song_request",
      });
      yield* analytics.writeChatCommandMetric({
        command: "song",
        userId: "viewer-id",
        userName: "viewer",
        status: "success",
        durationMs: 12,
        error: Option.none(),
      });
      yield* analytics.writeSagaLifecycleMetric({
        sagaType: "song-request-saga",
        sagaId: "redemption-id",
        event: "step_completed",
        stepName: Option.some("queue-track"),
        error: Option.none(),
        durationMs: Option.some(5),
      });
      yield* analytics.writeSongRequestMetric({
        requester: "viewer",
        trackId: "spotify-track-id",
        trackName: "Track",
        status: "fulfilled",
        latencyMs: 250,
      });
      yield* analytics.writeRaffleRollMetric({
        user: "viewer",
        roll: 40,
        winningNumber: 42,
        distance: 2,
        status: "loss",
      });

      const calls = yield* recording.readRecordedTwitchAnalyticsCalls();
      expect(calls.map((call) => call._tag)).toEqual([
        "AchievementUnlockMetric",
        "ChatCommandMetric",
        "SagaLifecycleMetric",
        "SongRequestMetric",
        "RaffleRollMetric",
      ]);

      yield* recording.clearRecordedTwitchAnalyticsCalls();
      expect(yield* recording.readRecordedTwitchAnalyticsCalls()).toEqual([]);
    }).pipe(Effect.provide(twitchAnalyticsTestLayer)),
);
