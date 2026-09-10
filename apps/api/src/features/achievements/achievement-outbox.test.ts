import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import {
  EventId,
  IsoTimestamp,
  RedemptionId,
  SpotifyTrackId,
  ViewerId,
} from "@cf-twitch/contracts/identity";
import { SongRequestSuccessEvent } from "@cf-twitch/contracts/domain-event";
import {
  controlledTwitchServiceLayer,
  type ControlledTwitchProviderMode,
} from "../../../test/support/controlled-twitch-service.ts";
import {
  recordingTwitchAnalyticsLayer,
  TwitchAnalyticsRecording,
} from "../../../test/support/recording-twitch-analytics.ts";
import {
  ProviderScenarioTranscript,
  providerScenarioTransportLayer,
} from "../providers/provider-scenario-transport.test-support.ts";
import { Achievements } from "./achievements-service.ts";
import { achievementsLayer } from "./achievements-database.ts";
import {
  AchievementOutbox,
  achievementOutboxLayerWithoutDependencies,
} from "./achievement-outbox.ts";

const outboxTestLayer = (mode: ControlledTwitchProviderMode) =>
  achievementOutboxLayerWithoutDependencies.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        achievementsLayer,
        controlledTwitchServiceLayer(mode),
        recordingTwitchAnalyticsLayer,
        providerScenarioTransportLayer,
      ),
    ),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  );

const request = SongRequestSuccessEvent.make({
  id: EventId.make("00000000-0000-4000-8000-000000000001"),
  v: 1,
  type: "song_request_success",
  source: "SongRequestSagaDO",
  timestamp: IsoTimestamp.make("2026-04-07T14:00:00Z"),
  correlationId: Option.none(),
  userId: ViewerId.make("viewer"),
  userDisplayName: "Viewer",
  sagaId: RedemptionId.make("redemption"),
  trackId: SpotifyTrackId.make("abc123"),
});

describe("Achievement application outbox with real SQL and production Twitch HTTP parsing", () => {
  it.effect(
    "all thirteen definitions produce exactly one announcement and metric through the real application interfaces",
    () =>
      Effect.gen(function* () {
        const achievements = yield* Achievements;
        const outbox = yield* AchievementOutbox;
        const transcript = yield* ProviderScenarioTranscript;
        const analytics = yield* TwitchAnalyticsRecording;
        const definitions = yield* achievements.getDefinitions();

        for (const [index, definition] of definitions.entries()) {
          yield* achievements.recordEvent({
            userId: request.userId,
            userDisplayName: request.userDisplayName,
            event: definition.triggerEvent,
            eventId: EventId.make(`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`),
            increment: Option.getOrElse(definition.threshold, () => 1),
            metadata: Option.none(),
          });
        }

        expect(
          yield* achievements.getUnlockedAchievements({ userDisplayName: "Viewer" }),
        ).toHaveLength(13);
        yield* outbox.flush();
        yield* outbox.flush();
        expect(yield* transcript.readRequestCount()).toBe(13);
        expect(yield* analytics.readRecordedTwitchAnalyticsCalls()).toHaveLength(13);
        expect(yield* achievements.getUnannounced()).toEqual([]);
      }).pipe(Effect.provide(outboxTestLayer("normal"))),
  );
  it.effect(
    "concurrent delivery sends and claims metrics once; event replay and repeat callbacks remain inert",
    () =>
      Effect.gen(function* () {
        const achievements = yield* Achievements;
        const outbox = yield* AchievementOutbox;
        const transcript = yield* ProviderScenarioTranscript;
        const analytics = yield* TwitchAnalyticsRecording;
        const sql = yield* SqlClient.SqlClient;
        yield* achievements.handleEvent(request);
        yield* Effect.all([outbox.flush(), outbox.flush()], { concurrency: "unbounded" });
        yield* achievements.handleEvent(request);
        yield* outbox.flush();
        expect(yield* transcript.readRequestCount()).toBe(1);
        expect(yield* analytics.readRecordedTwitchAnalyticsCalls()).toEqual([
          {
            _tag: "AchievementUnlockMetric",
            metric: {
              effectId: `${request.id}:first_request`,
              user: "Viewer",
              achievementId: "first_request",
              achievementName: "First Timer",
              category: "song_request",
            },
          },
        ]);
        expect(
          yield* sql`SELECT metric_state,announcement_state,announcement_attempts FROM achievement_unlock_outbox`,
        ).toEqual([
          { metric_state: "claimed", announcement_state: "sent", announcement_attempts: 0 },
        ]);
        expect(yield* achievements.getUnannounced()).toEqual([]);
        expect(yield* outbox.hasPending()).toBe(false);
      }).pipe(Effect.provide(outboxTestLayer("normal"))),
  );
  it.effect(
    "rate-limit retries persist their deadline, honor Retry-After and exhaust after three safe retries",
    () =>
      Effect.gen(function* () {
        const achievements = yield* Achievements;
        const outbox = yield* AchievementOutbox;
        const transcript = yield* ProviderScenarioTranscript;
        const analytics = yield* TwitchAnalyticsRecording;
        const sql = yield* SqlClient.SqlClient;
        yield* achievements.handleEvent(request);
        yield* outbox.flush();
        expect(yield* transcript.readRequestCount()).toBe(1);
        yield* TestClock.adjust("11999 millis");
        yield* outbox.flush();
        expect(yield* transcript.readRequestCount()).toBe(1);
        yield* TestClock.adjust("1 millis");
        yield* outbox.flush();
        expect(yield* transcript.readRequestCount()).toBe(2);

        for (let retry = 0; retry < 2; retry++) {
          yield* TestClock.adjust("12 seconds");
          yield* outbox.flush();
        }

        expect(yield* transcript.readRequestCount()).toBe(4);
        expect(
          yield* sql`SELECT announcement_state,announcement_attempts FROM achievement_unlock_outbox`,
        ).toEqual([{ announcement_state: "abandoned", announcement_attempts: 3 }]);
        yield* TestClock.adjust("1 day");
        yield* outbox.flush();
        expect(yield* transcript.readRequestCount()).toBe(4);
        expect(yield* analytics.readRecordedTwitchAnalyticsCalls()).toHaveLength(1);
        expect(yield* outbox.hasPending()).toBe(false);
      }).pipe(Effect.provide(outboxTestLayer("rate-limited"))),
  );

  for (const mode of ["unknown", "malformed-chat"] as const) {
    it.effect(
      `${mode} outcome is uncertain and never retried, including after SQL authority restart`,
      () =>
        Effect.gen(function* () {
          const achievements = yield* Achievements;
          const outbox = yield* AchievementOutbox;
          const transcript = yield* ProviderScenarioTranscript;
          const analytics = yield* TwitchAnalyticsRecording;
          const sql = yield* SqlClient.SqlClient;
          yield* achievements.handleEvent(request);
          yield* outbox.flush();
          expect(yield* sql`SELECT announcement_state FROM achievement_unlock_outbox`).toEqual([
            { announcement_state: "uncertain" },
          ]);
          yield* Effect.gen(function* () {
            const restored = yield* Achievements;
            yield* restored.handleEvent(request);
          }).pipe(Effect.provide(Layer.fresh(achievementsLayer)));
          yield* TestClock.adjust("1 day");
          yield* outbox.flush();
          expect(yield* transcript.readRequestCount()).toBe(1);
          expect(yield* analytics.readRecordedTwitchAnalyticsCalls()).toHaveLength(1);
          expect(yield* outbox.hasPending()).toBe(false);
        }).pipe(Effect.provide(outboxTestLayer(mode))),
    );
  }

  it.effect(
    "confirmed provider send followed by failed SQL finalization becomes uncertain on restart without duplicate chat or metrics",
    () =>
      Effect.gen(function* () {
        const achievements = yield* Achievements;
        const outbox = yield* AchievementOutbox;
        const transcript = yield* ProviderScenarioTranscript;
        const analytics = yield* TwitchAnalyticsRecording;
        const sql = yield* SqlClient.SqlClient;
        yield* achievements.handleEvent(request);
        yield* sql`CREATE TRIGGER fail_announcement_finalization BEFORE UPDATE ON achievement_unlock_outbox WHEN NEW.announcement_state='sent' BEGIN SELECT RAISE(ABORT,'simulated lost completion commit'); END`;
        expect((yield* outbox.flush().pipe(Effect.flip)).reason).toBe("persistence_unavailable");
        expect(yield* transcript.readRequestCount()).toBe(1);
        expect(
          yield* sql`SELECT announcement_state,metric_state FROM achievement_unlock_outbox`,
        ).toEqual([{ announcement_state: "sending", metric_state: "claimed" }]);
        yield* sql`DROP TRIGGER fail_announcement_finalization`;
        yield* Effect.gen(function* () {
          const restored = yield* Achievements;
          expect(
            (yield* restored.getUnlockedAchievements({ userDisplayName: "Viewer" }))[0]?.id,
          ).toBe("first_request");
        }).pipe(Effect.provide(Layer.fresh(achievementsLayer)));
        yield* outbox.flush();
        yield* achievements.handleEvent(request);
        yield* outbox.flush();
        expect(
          yield* sql`SELECT announcement_state,metric_state FROM achievement_unlock_outbox`,
        ).toEqual([{ announcement_state: "uncertain", metric_state: "claimed" }]);
        expect(yield* transcript.readRequestCount()).toBe(1);
        expect(yield* analytics.readRecordedTwitchAnalyticsCalls()).toHaveLength(1);
      }).pipe(Effect.provide(outboxTestLayer("normal"))),
  );
  it.effect("oversized announcement text is abandoned before Twitch HTTP delivery", () =>
    Effect.gen(function* () {
      const achievements = yield* Achievements;
      const outbox = yield* AchievementOutbox;
      const transcript = yield* ProviderScenarioTranscript;
      const sql = yield* SqlClient.SqlClient;
      yield* achievements.handleEvent({ ...request, userDisplayName: "V".repeat(600) });
      yield* outbox.flush();
      expect(yield* transcript.readRequestCount()).toBe(0);
      expect(
        yield* sql`SELECT announcement_state,announcement_attempts FROM achievement_unlock_outbox`,
      ).toEqual([{ announcement_state: "abandoned", announcement_attempts: 0 }]);
    }).pipe(Effect.provide(outboxTestLayer("normal"))),
  );
  it.effect("dropped chat is abandoned without retry or duplicate metric delivery", () =>
    Effect.gen(function* () {
      const achievements = yield* Achievements;
      const outbox = yield* AchievementOutbox;
      const transcript = yield* ProviderScenarioTranscript;
      const sql = yield* SqlClient.SqlClient;
      yield* achievements.handleEvent(request);
      yield* outbox.flush();
      yield* TestClock.adjust("1 day");
      yield* outbox.flush();
      expect(yield* transcript.readRequestCount()).toBe(1);
      expect(
        yield* sql`SELECT announcement_state,announcement_attempts FROM achievement_unlock_outbox`,
      ).toEqual([{ announcement_state: "abandoned", announcement_attempts: 0 }]);
    }).pipe(Effect.provide(outboxTestLayer("dropped-chat"))),
  );
});
