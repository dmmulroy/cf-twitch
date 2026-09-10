import { SqliteClient } from "@effect/sql-sqlite-node";
import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { WorkflowHttpApi } from "./workflow-http-api.ts";
import { workflowHttpHandlersLayer } from "./workflow-http-handlers.ts";
import { recordingTwitchAnalyticsLayer } from "../../../test/support/recording-twitch-analytics.ts";
import { DomainEvent } from "@cf-twitch/contracts/domain-event";
import { EventBusError } from "@cf-twitch/contracts/event-bus";
import { ProviderError } from "@cf-twitch/contracts/provider";
import { SpotifyTrack } from "@cf-twitch/contracts/spotify-track";
import { WorkflowInput } from "@cf-twitch/contracts/workflow";
import { RaffleRecordResult } from "@cf-twitch/contracts/raffle";
import { EventPublisher } from "../events/event-publisher.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { SpotifyService } from "../providers/spotify-service.ts";
import { TwitchService } from "../providers/twitch-service.ts";
import { WorkflowAlarm } from "./workflow-alarm.ts";
import { workflowJournalLayerWithoutDependencies } from "./workflow-journal.ts";
import {
  WorkflowExecution,
  workflowExecutionLayerWithoutDependencies,
} from "./workflow-execution.ts";

const song = Schema.decodeUnknownSync(WorkflowInput)({
  _tag: "SongRequest",
  redemption: {
    id: "redemption-1",
    broadcasterId: "broadcaster",
    userId: "viewer",
    userLogin: "viewer",
    userDisplayName: "Viewer",
    userInput: "spotify:track:abc",
    reward: { id: "reward", title: "Song", cost: 100, prompt: "" },
    redeemedAt: "2026-01-01T00:00:00Z",
  },
});

const track = Schema.decodeUnknownSync(SpotifyTrack)({
  id: "abc",
  name: "Track",
  artists: ["Artist"],
  album: "Album",
  albumCoverUrl: null,
});

const raffleResult = Schema.decodeUnknownSync(RaffleRecordResult)({
  roll: {
    id: "redemption-1",
    userId: "viewer",
    displayName: "Viewer",
    roll: 770,
    winningNumber: 777,
    distance: 7,
    isWinner: false,
    isNewRecord: true,
    rolledAt: "2026-01-01T00:00:00Z",
  },
});

const providerError = (kind: ProviderError["kind"], operation: string) =>
  new ProviderError({
    provider: "twitch",
    operation,
    kind,
    status: kind === "rejected" ? 400 : 0,
    retryAfterMs: Option.none(),
  });

const sqlite = SqliteClient.layer({ filename: ":memory:" });

const recordingServices = Effect.gen(function* () {
  const calls = yield* Ref.make<readonly string[]>([]);
  const events = yield* Ref.make<readonly DomainEvent[]>([]);
  const rejectFulfill = yield* Ref.make(false);
  const rejectPublish = yield* Ref.make(false);
  const rejectRemove = yield* Ref.make(false);
  const unknownChat = yield* Ref.make(false);
  const slowChat = yield* Ref.make(false);
  const chatStarted = yield* Deferred.make<void>();
  const chatFinalized = yield* Ref.make(false);
  const record = (name: string) => Ref.update(calls, (values) => [...values, name]);

  const dependencies = Layer.mergeAll(
    Layer.mock(SpotifyService, {
      getTrack: () => record("track").pipe(Effect.as(track)),
      addToQueue: () => record("spotify-add"),
      removeFromQueue: () =>
        record("spotify-remove").pipe(
          Effect.andThen(Ref.get(rejectRemove)),
          Effect.map((reject) => !reject),
        ),
    }),
    Layer.mock(TwitchService, {
      updateRedemptionStatus: (input) =>
        record(input.status).pipe(
          Effect.andThen(Ref.get(rejectFulfill)),
          Effect.flatMap((reject) =>
            reject && input.status === "FULFILLED"
              ? Effect.fail(providerError("rejected", "fulfill"))
              : Effect.void,
          ),
        ),
      sendChatMessage: () =>
        Effect.gen(function* () {
          yield* record("chat");
          yield* Deferred.succeed(chatStarted, undefined);

          if (yield* Ref.get(slowChat))
            return yield* Effect.never.pipe(Effect.ensuring(Ref.set(chatFinalized, true)));

          if (yield* Ref.get(unknownChat)) return yield* providerError("outcome-unknown", "chat");
        }),
      createShoutout: () => record("shoutout"),
    }),
    Layer.mock(SongQueue, {
      persistRequest: () => record("persist-request"),
      deleteRequest: () => record("delete-request"),
    }),
    Layer.mock(Raffle, {
      getOrCreateRoll: () => record("record-roll").pipe(Effect.as(raffleResult)),
      deleteRollById: () => record("delete-roll"),
    }),
    Layer.succeed(EventPublisher, {
      publish: (event) =>
        record("publish").pipe(
          Effect.andThen(Ref.update(events, (values) => [...values, event])),
          Effect.andThen(Ref.get(rejectPublish)),
          Effect.flatMap((reject) =>
            reject
              ? Effect.fail(
                  new EventBusError({
                    operation: "publish",
                    reason: "persistence_unavailable",
                    eventId: Option.some(event.id),
                  }),
                )
              : Effect.void,
          ),
        ),
    }),
    Layer.succeed(WorkflowAlarm, { set: () => Effect.void }),
    NodeCrypto.layer,
    recordingTwitchAnalyticsLayer,
  );

  const executionLayer = workflowExecutionLayerWithoutDependencies.pipe(
    Layer.provide(workflowJournalLayerWithoutDependencies),
    Layer.provide(dependencies),
  );

  const use = <A, E, R>(effect: Effect.Effect<A, E, R | WorkflowExecution>) =>
    effect.pipe(Effect.provide(executionLayer, { local: true }));

  const start = (input = song) =>
    use(
      Effect.gen(function* () {
        const execution = yield* WorkflowExecution;
        yield* execution.start(input);

        return yield* execution.getStatus();
      }),
    );

  const resume = () =>
    use(
      Effect.gen(function* () {
        const execution = yield* WorkflowExecution;
        yield* execution.resume();

        return yield* execution.getStatus();
      }),
    );

  return {
    calls,
    events,
    rejectFulfill,
    rejectPublish,
    rejectRemove,
    unknownChat,
    slowChat,
    chatStarted,
    chatFinalized,
    start,
    resume,
    executionLayer,
  };
});

describe("Workflow execution public service with real SQLite restarts", () => {
  it.effect(
    "exhausts unconfirmed Spotify compensation after five attempts without deleting attribution or refunding",
    () =>
      Effect.gen(function* () {
        const controls = yield* recordingServices;
        yield* Ref.set(controls.rejectFulfill, true);
        yield* Ref.set(controls.rejectRemove, true);
        yield* controls.start();

        for (const delay of [2, 4, 8, 16]) {
          yield* TestClock.adjust(`${delay} seconds`);
          yield* controls.resume();
        }

        expect(yield* controls.resume()).toMatchObject({
          value: { status: "COMPENSATION_FAILED" },
        });
        const calls = yield* Ref.get(controls.calls);
        expect(calls.filter((call) => call === "spotify-remove")).toHaveLength(5);
        expect(calls).not.toContain("delete-request");
        expect(calls).not.toContain("CANCELED");
        yield* controls.start();
        expect((yield* Ref.get(controls.calls)).length).toBe(calls.length);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect("thanks and shouts out one raid exactly once using its EventSub message identity", () =>
    Effect.gen(function* () {
      const controls = yield* recordingServices;

      const input = Schema.decodeUnknownSync(WorkflowInput)({
        _tag: "RaidShoutout",
        raid: {
          messageId: "raid-success",
          receivedAt: "2026-01-01T00:00:00Z",
          raider: { userId: "raider", login: "raider", displayName: "Raider" },
          viewers: 42,
        },
      });

      expect(yield* controls.start(input)).toMatchObject({
        value: { sagaId: "raid-success", status: "COMPLETED" },
      });
      yield* controls.start(input);
      expect(yield* Ref.get(controls.calls)).toEqual(["chat", "shoutout"]);
    }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "enforces the baseline ten-second raid chat deadline and never retries the unknown send",
    () =>
      Effect.gen(function* () {
        const controls = yield* recordingServices;
        yield* Ref.set(controls.slowChat, true);

        const input = Schema.decodeUnknownSync(WorkflowInput)({
          _tag: "RaidShoutout",
          raid: {
            messageId: "raid-timeout",
            receivedAt: "2026-01-01T00:00:00Z",
            raider: { userId: "raider", login: "raider", displayName: "Raider" },
            viewers: 42,
          },
        });

        const result = yield* Effect.gen(function* () {
          const execution = yield* WorkflowExecution;
          const completed = yield* Ref.make(false);
          const duplicateCompleted = yield* Ref.make(false);

          const fiber = yield* execution.start(input).pipe(
            Effect.tap(() => Ref.set(completed, true)),
            Effect.forkChild,
          );

          yield* Deferred.await(controls.chatStarted);

          const duplicate = yield* execution.start(input).pipe(
            Effect.tap(() => Ref.set(duplicateCompleted, true)),
            Effect.forkChild,
          );

          yield* Effect.yieldNow;
          expect(yield* Ref.get(duplicateCompleted)).toBe(false);
          yield* TestClock.adjust("9 seconds");
          expect(yield* Ref.get(completed)).toBe(false);
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(fiber);
          yield* Fiber.join(duplicate);

          return yield* execution.getStatus();
        }).pipe(Effect.provide(controls.executionLayer, { local: true }));

        expect(result).toMatchObject({ value: { status: "OUTCOME_UNKNOWN" } });
        expect(yield* Ref.get(controls.chatFinalized)).toBe(true);
        expect(yield* Ref.get(controls.calls)).toEqual(["chat"]);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "roundtrips durable workflow start/status/conflict through generated HTTP client and real SQL handlers",
    () =>
      Effect.gen(function* () {
        if (song._tag !== "SongRequest") return;
        const controls = yield* recordingServices;
        const sql = yield* SqlClient.SqlClient;

        const httpLayer = HttpApiBuilder.layer(WorkflowHttpApi).pipe(
          Layer.provide(
            workflowHttpHandlersLayer.pipe(
              Layer.provide(
                controls.executionLayer.pipe(
                  Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
                ),
              ),
            ),
          ),
          Layer.provide(cloudflareHttpServerLayer),
        );

        const app = yield* Effect.acquireRelease(
          Effect.sync(() => HttpRouter.toWebHandler(httpLayer, { disableLogger: true })),
          (app) => Effect.promise(() => app.dispose()),
        );

        const fetchLayer = FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
              app.handler(new Request(input, init)),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const httpClient = yield* HttpClient.HttpClient;

          const client = yield* HttpApiClient.makeWith(WorkflowHttpApi, {
            baseUrl: "http://workflow.test",
            httpClient,
          });

          expect(yield* client.workflow.getStatus()).toEqual(Option.none());
          yield* client.workflow.start({ payload: song });
          expect(yield* client.workflow.getStatus()).toMatchObject({
            value: { status: "COMPLETED", fulfilledAt: { _tag: "Some" } },
          });
          yield* client.workflow.start({ payload: song });
          expect(
            yield* client.workflow
              .start({
                payload: {
                  ...song,
                  redemption: { ...song.redemption, userInput: "spotify:track:different" },
                },
              })
              .pipe(Effect.result),
          ).toMatchObject({ failure: { _tag: "WorkflowError", reason: "conflict" } });
          expect(
            (yield* Ref.get(controls.calls)).filter((call) => call === "spotify-add"),
          ).toHaveLength(1);
        }).pipe(Effect.provide(fetchLayer));
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "completes a song once and preserves exact domain event identity across restart and duplicate start",
    () =>
      Effect.gen(function* () {
        const services = yield* recordingServices;
        expect(yield* services.start()).toMatchObject({
          value: { status: "COMPLETED", fulfilledAt: { _tag: "Some" } },
        });
        expect(yield* services.start()).toMatchObject({ value: { status: "COMPLETED" } });
        expect(yield* services.resume()).toMatchObject({ value: { status: "COMPLETED" } });
        expect(yield* Ref.get(services.calls)).toEqual([
          "track",
          "persist-request",
          "spotify-add",
          "FULFILLED",
          "chat",
          "publish",
        ]);
        expect(yield* Ref.get(services.events)).toMatchObject([
          {
            type: "song_request_success",
            id: "2fa3ce58-eae6-5fdf-a30e-4a2085d0606e",
            sagaId: "redemption-1",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ]);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect("preserves a leading-zero deterministic workflow event identity vector", () =>
    Effect.gen(function* () {
      if (song._tag !== "SongRequest") return;

      const services = yield* recordingServices;

      const vectorInput = Schema.decodeUnknownSync(WorkflowInput)({
        ...song,
        redemption: { ...song.redemption, id: "vector-49" },
      });

      yield* services.start(vectorInput);
      expect(yield* Ref.get(services.events)).toMatchObject([
        { id: "0031595e-11f3-5357-a933-6811faeee12f", sagaId: "vector-49" },
      ]);
    }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "resumes compensation in strict reverse order and withholds refund until Spotify removal confirmed",
    () =>
      Effect.gen(function* () {
        const services = yield* recordingServices;
        yield* Ref.set(services.rejectFulfill, true);
        yield* Ref.set(services.rejectRemove, true);
        expect(yield* services.start()).toMatchObject({ value: { status: "COMPENSATING" } });
        expect(yield* Ref.get(services.calls)).toEqual([
          "track",
          "persist-request",
          "spotify-add",
          "FULFILLED",
          "spotify-remove",
        ]);
        yield* Ref.set(services.rejectRemove, false);
        yield* TestClock.adjust("2 seconds");
        expect(yield* services.resume()).toMatchObject({
          value: { status: "FAILED", fulfilledAt: { _tag: "None" } },
        });
        expect(yield* Ref.get(services.calls)).toEqual([
          "track",
          "persist-request",
          "spotify-add",
          "FULFILLED",
          "spotify-remove",
          "spotify-remove",
          "delete-request",
          "CANCELED",
          "chat",
        ]);
        yield* services.start();
        expect(
          (yield* Ref.get(services.calls)).filter((call) => call === "spotify-add"),
        ).toHaveLength(1);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "reports POST_COMMIT_FAILED after five publication attempts without undo or refund",
    () =>
      Effect.gen(function* () {
        const services = yield* recordingServices;
        yield* Ref.set(services.rejectPublish, true);
        expect(yield* services.start()).toMatchObject({ value: { status: "RUNNING" } });

        for (const delay of [2, 4, 8, 16]) {
          yield* TestClock.adjust(`${delay} seconds`);
          yield* services.resume();
        }

        expect(yield* services.resume()).toMatchObject({
          value: { status: "POST_COMMIT_FAILED", fulfilledAt: { _tag: "Some" } },
        });
        const calls = yield* Ref.get(services.calls);
        expect(calls.filter((call) => call === "publish")).toHaveLength(5);
        expect(calls).not.toContain("CANCELED");
        expect(calls).not.toContain("spotify-remove");
        const events = yield* Ref.get(services.events);
        expect(new Set(events.map((event) => event.id)).size).toBe(1);
        expect(new Set(events.map((event) => event.timestamp)).size).toBe(1);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect("holds unknown Spotify commit-gap outcomes and never blindly repeats or refunds", () =>
    Effect.gen(function* () {
      const services = yield* recordingServices;
      const sql = yield* SqlClient.SqlClient;
      // Schema tables are created by the same production journal; install a real SQLite failure at the commit boundary.
      yield* sql`CREATE TABLE saga_steps(saga_id TEXT NOT NULL,step_name TEXT NOT NULL,state TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,result_json TEXT,undo_json TEXT,next_retry_at TEXT,last_error TEXT,PRIMARY KEY(saga_id,step_name))`;
      yield* sql`CREATE TRIGGER lose_spotify_checkpoint BEFORE UPDATE ON saga_steps WHEN NEW.step_name='add-to-spotify-queue' AND NEW.state='SUCCEEDED' BEGIN SELECT RAISE(FAIL,'simulated disk failure'); END`;
      expect(yield* services.start().pipe(Effect.result)).toMatchObject({
        failure: { reason: "storage" },
      });
      yield* sql`DROP TRIGGER lose_spotify_checkpoint`;
      expect(yield* services.resume()).toMatchObject({ value: { status: "OUTCOME_UNKNOWN" } });
      yield* services.start();
      expect(yield* Ref.get(services.calls)).toEqual(["track", "persist-request", "spotify-add"]);
    }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "keeps optional ambiguous chat at most once while still publishing required domain event",
    () =>
      Effect.gen(function* () {
        const services = yield* recordingServices;
        yield* Ref.set(services.unknownChat, true);
        expect(yield* services.start()).toMatchObject({ value: { status: "COMPLETED" } });
        yield* services.start();
        expect((yield* Ref.get(services.calls)).filter((call) => call === "chat")).toHaveLength(1);
        expect(yield* Ref.get(services.events)).toHaveLength(1);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect("persists raffle result, fulfills, publishes and chats once across restart", () =>
    Effect.gen(function* () {
      if (song._tag !== "SongRequest") return;
      const services = yield* recordingServices;
      const raffleInput: WorkflowInput = { _tag: "KeyboardRaffle", redemption: song.redemption };
      expect(yield* services.start(raffleInput)).toMatchObject({ value: { status: "COMPLETED" } });
      yield* services.start(raffleInput);
      expect(yield* Ref.get(services.calls)).toEqual([
        "record-roll",
        "FULFILLED",
        "publish",
        "chat",
      ]);
      expect(yield* Ref.get(services.events)).toMatchObject([
        { type: "raffle_roll", roll: 770, winningNumber: 777, distance: 7, isNewRecord: true },
      ]);
    }).pipe(Effect.provide(sqlite)),
  );

  it.effect("native raid chat unknown outcome is terminal and shoutout is not issued", () =>
    Effect.gen(function* () {
      const services = yield* recordingServices;
      yield* Ref.set(services.unknownChat, true);

      const input = Schema.decodeUnknownSync(WorkflowInput)({
        _tag: "RaidShoutout",
        raid: {
          messageId: "raid-1",
          receivedAt: "2026-01-01T00:00:00Z",
          raider: { userId: "raider", login: "raider", displayName: "Raider" },
          viewers: 42,
        },
      });

      expect(yield* services.start(input)).toMatchObject({ value: { status: "OUTCOME_UNKNOWN" } });
      yield* services.start(input);
      expect(yield* Ref.get(services.calls)).toEqual(["chat"]);
    }).pipe(Effect.provide(sqlite)),
  );
});
