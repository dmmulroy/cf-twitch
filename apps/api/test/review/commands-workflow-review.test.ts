import { NodeCrypto } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Effect, Layer, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { ChannelPointRedemption } from "@cf-twitch/contracts/redemption";
import { RaffleError } from "@cf-twitch/contracts/raffle";
import { SongQueueError } from "@cf-twitch/contracts/song-queue";
import { SpotifyTrack } from "@cf-twitch/contracts/spotify-track";
import type { WorkflowInput } from "@cf-twitch/contracts/workflow";
import { recordingTwitchAnalyticsLayer } from "../support/recording-twitch-analytics.ts";
import {
  WorkflowExecution,
  workflowExecutionLayerWithoutDependencies,
} from "../../src/features/workflows/workflow-execution.ts";
import { workflowJournalLayerWithoutDependencies } from "../../src/features/workflows/workflow-journal.ts";
import { WorkflowAlarm } from "../../src/features/workflows/workflow-alarm.ts";
import { SpotifyService } from "../../src/features/providers/spotify-service.ts";
import { TwitchService } from "../../src/features/providers/twitch-service.ts";
import { SongQueue } from "../../src/features/song-queue/song-queue.ts";
import { Raffle } from "../../src/features/raffle/raffle-service.ts";
import { EventPublisher } from "../../src/features/events/event-publisher.ts";

const redemption = Schema.decodeSync(ChannelPointRedemption)({
  id: "review-redemption",
  broadcasterId: "broadcaster",
  userId: "viewer",
  userLogin: "viewer",
  userDisplayName: "Viewer",
  userInput: "spotify:track:abc",
  reward: { id: "reward", title: "Song", cost: 100, prompt: "" },
  redeemedAt: "2026-01-01T00:00:00Z",
});

const track = Schema.decodeSync(SpotifyTrack)({
  id: "abc",
  name: "Track",
  artists: ["Artist"],
  album: "Album",
  albumCoverUrl: null,
});

const sqlite = SqliteClient.layer({ filename: ":memory:" });

const reviewServices = Effect.gen(function* () {
  const remoteRecordExists = yield* Ref.make(false);
  const refunded = yield* Ref.make(false);
  const messages = yield* Ref.make<readonly string[]>([]);
  const recordWithoutReceipt = Ref.set(remoteRecordExists, true);

  const dependencies = Layer.mergeAll(
    recordingTwitchAnalyticsLayer,
    NodeCrypto.layer,
    Layer.succeed(WorkflowAlarm, { set: () => Effect.void }),
    Layer.mock(SpotifyService, {
      getTrack: () => Effect.succeed(track),
      addToQueue: () => Effect.void,
      removeFromQueue: () => Effect.succeed(true),
    }),
    Layer.mock(SongQueue, {
      persistRequest: () =>
        recordWithoutReceipt.pipe(
          Effect.andThen(
            Effect.fail(
              new SongQueueError({ operation: "persistRequest", reason: "transport_unavailable" }),
            ),
          ),
        ),
      deleteRequest: () => Ref.set(remoteRecordExists, false),
    }),
    Layer.mock(Raffle, {
      getOrCreateRoll: () =>
        recordWithoutReceipt.pipe(
          Effect.andThen(
            Effect.fail(
              new RaffleError({ operation: "getOrCreateRoll", reason: "transport_unavailable" }),
            ),
          ),
        ),
      deleteRollById: () => Ref.set(remoteRecordExists, false),
    }),
    Layer.mock(TwitchService, {
      updateRedemptionStatus: ({ status }) =>
        status === "CANCELED" ? Ref.set(refunded, true) : Effect.void,
      sendChatMessage: ({ message }) => Ref.update(messages, (values) => [...values, message]),
    }),
    Layer.succeed(EventPublisher, { publish: () => Effect.void }),
  );

  const layer = workflowExecutionLayerWithoutDependencies.pipe(
    Layer.provide(workflowJournalLayerWithoutDependencies),
    Layer.provide(dependencies),
  );

  const start = (input: WorkflowInput) =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowExecution;
      yield* workflow.start(input);

      return yield* workflow.getStatus();
    }).pipe(Effect.provide(layer, { local: true }));

  const resume = () =>
    Effect.gen(function* () {
      const workflow = yield* WorkflowExecution;
      yield* workflow.resume();

      return yield* workflow.getStatus();
    }).pipe(Effect.provide(layer, { local: true }));

  return { start, resume, remoteRecordExists, refunded, messages };
});

describe("Independent command-owner workflow review regressions", () => {
  for (const kind of ["SongRequest", "KeyboardRaffle"] as const) {
    it.effect(
      `never refunds ${kind} after remote persistence committed but every response was lost`,
      () =>
        Effect.gen(function* () {
          const services = yield* reviewServices;
          yield* services.start({ _tag: kind, redemption });
          yield* TestClock.adjust("2 seconds");
          yield* services.resume();
          // Safe implementations either compensate by the already-known redemption ID, or hold the uncertain run.
          expect(
            (yield* Ref.get(services.remoteRecordExists)) && (yield* Ref.get(services.refunded)),
          ).toBe(false);
        }).pipe(Effect.provide(sqlite)),
    );
  }

  it.effect(
    "retains invalid-track cause across the failed-step to compensation transition storage gap",
    () =>
      Effect.gen(function* () {
        const services = yield* reviewServices;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE saga_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,params_json TEXT NOT NULL,fulfilled_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT)`;
        yield* sql`CREATE TRIGGER reject_compensation_transition BEFORE UPDATE ON saga_runs WHEN NEW.status='COMPENSATING' BEGIN SELECT RAISE(FAIL,'review transition outage'); END`;
        expect(
          yield* services
            .start({
              _tag: "SongRequest",
              redemption: { ...redemption, userInput: "invalid input" },
            })
            .pipe(Effect.result),
        ).toMatchObject({ failure: { reason: "storage" } });
        yield* sql`DROP TRIGGER reject_compensation_transition`;
        yield* services.resume();
        expect(yield* Ref.get(services.refunded)).toBe(true);
        expect(yield* Ref.get(services.messages)).toEqual([
          "@Viewer your song request was invalid and your points have been refunded. Did you use a valid Spotify track link?",
        ]);
      }).pipe(Effect.provide(sqlite)),
  );
});
