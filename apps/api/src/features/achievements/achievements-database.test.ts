import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { SqlClient } from "effect/unstable/sql";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AchievementEventInput } from "@cf-twitch/contracts/achievement";
import { RaffleDistance, RaffleNumber } from "@cf-twitch/contracts/raffle";
import {
  EventId,
  IsoTimestamp,
  PageSize,
  RedemptionId,
  SpotifyTrackId,
  StreamId,
  ViewerId,
} from "@cf-twitch/contracts/identity";
import {
  SongRequestSuccessEvent,
  RaffleRollEvent,
  StreamOnlineEvent,
  StreamOfflineEvent,
} from "@cf-twitch/contracts/domain-event";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { Achievements } from "./achievements-service.ts";
import { achievementsLayer } from "./achievements-database.ts";
import { AchievementsHttpApi } from "./achievements-http-api.ts";
import { achievementsHttpHandlersLayer } from "./achievements-http-handlers.ts";

const AchievementHttpTestPayload = Schema.Json;

type AchievementHttpTestPayload = typeof AchievementHttpTestPayload.Type;

const parseAchievementHttpTestPayload = Schema.decodeUnknownEffect(AchievementHttpTestPayload);

const sqlLayer = SqliteClient.layer({ filename: ":memory:" });

const database = achievementsLayer.pipe(Layer.provideMerge(sqlLayer));

const instant = (seconds: number) =>
  IsoTimestamp.make(new Date(Date.UTC(2026, 3, 7, 14, 0, seconds)).toISOString());

const eventId = (index: number) =>
  EventId.make(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);

const request = (index: number, seconds = index, viewer = "viewer", name = "Viewer") =>
  SongRequestSuccessEvent.make({
    id: eventId(index),
    v: 1,
    type: "song_request_success",
    source: "SongRequestSagaDO",
    timestamp: instant(seconds),
    correlationId: Option.none(),
    userId: ViewerId.make(viewer),
    userDisplayName: name,
    sagaId: RedemptionId.make(`redemption-${index}`),
    trackId: SpotifyTrackId.make("abc123"),
  });

const online = (index: number, seconds: number, stream = "stream") =>
  StreamOnlineEvent.make({
    id: eventId(index),
    v: 1,
    type: "stream_online",
    source: "StreamLifecycleDO",
    timestamp: instant(seconds),
    correlationId: Option.none(),
    streamId: StreamId.make(stream),
    startedAt: instant(seconds),
  });

const offline = (index: number, seconds: number, stream = "stream") =>
  StreamOfflineEvent.make({
    id: eventId(index),
    v: 1,
    type: "stream_offline",
    source: "StreamLifecycleDO",
    timestamp: instant(seconds),
    correlationId: Option.none(),
    streamId: StreamId.make(stream),
    endedAt: instant(seconds),
  });

const raffle = (index: number, roll: number, winningNumber: number, isNewRecord = false) =>
  RaffleRollEvent.make({
    id: eventId(index),
    v: 1,
    type: "raffle_roll",
    source: "KeyboardRaffleSagaDO",
    timestamp: instant(index),
    correlationId: Option.none(),
    userId: ViewerId.make("viewer"),
    userDisplayName: "Viewer",
    sagaId: RedemptionId.make(`raffle-${index}`),
    roll: RaffleNumber.make(roll),
    winningNumber: RaffleNumber.make(winningNumber),
    distance: RaffleDistance.make(Math.abs(roll - winningNumber)),
    isWinner: roll === winningNumber,
    isNewRecord,
  });

const parseOutbox = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      effect_id: Schema.String,
      announcement_state: Schema.String,
      metric_state: Schema.String,
    }),
  ),
);

describe("Achievements real SQLite authority", () => {
  it.effect(
    "invalid direct streak metadata rolls back inbox instead of persisting invalid progress",
    () =>
      Effect.gen(function* () {
        const service = yield* Achievements;

        const input = AchievementEventInput.make({
          userId: ViewerId.make("viewer"),
          userDisplayName: "Viewer",
          event: "request_streak",
          eventId: eventId(1),
          increment: 1,
          metadata: Option.some({ streakCount: -1 }),
        });

        expect((yield* service.recordEvent(input).pipe(Effect.flip)).reason).toBe("invalid_input");
        expect(yield* service.getDebugTableCounts()).toMatchObject({
          eventHistory: 0,
          userAchievements: 0,
        });
      }).pipe(Effect.provide(database)),
  );
  it.effect("preserves exactly thirteen historical definitions and all thresholds/scopes", () =>
    Effect.gen(function* () {
      const service = yield* Achievements;
      const definitions = yield* service.getDefinitions();
      expect(
        definitions.map((row) => [row.id, Option.getOrNull(row.threshold), row.scope]),
      ).toEqual([
        ["first_request", 1, "cumulative"],
        ["request_10", 10, "cumulative"],
        ["request_50", 50, "cumulative"],
        ["request_100", 100, "cumulative"],
        ["stream_opener", null, "session"],
        ["first_roll", 1, "cumulative"],
        ["roll_25", 25, "cumulative"],
        ["roll_100", 100, "cumulative"],
        ["first_win", 1, "cumulative"],
        ["close_call", null, "cumulative"],
        ["closest_ever", null, "cumulative"],
        ["streak_3", 3, "session"],
        ["streak_5", 5, "session"],
      ]);
      expect(
        (yield* service.getUserAchievements({ userDisplayName: "Unknown" })).every(
          (row) => row.progress === 0 && !row.unlocked,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(database)),
  );
  it.effect(
    "deduplicates concurrent events transactionally and follows stable Viewer ID across renames",
    () =>
      Effect.gen(function* () {
        const service = yield* Achievements;
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.all(
          Array.from({ length: 12 }, () =>
            service.handleEvent(request(1, 1, "stable", "Old_Name")),
          ),
          { concurrency: "unbounded" },
        );
        yield* service.handleEvent(request(2, 2, "stable", "New_Name"));
        const rows = yield* service.getUserAchievements({ userDisplayName: "New_Name" });
        expect(rows.find((row) => row.achievementId === "request_10")?.progress).toBe(2);
        expect(
          (yield* service.getUserAchievements({ userDisplayName: "Old_Name" })).every(
            (row) => row.progress === 0,
          ),
        ).toBe(true);
        expect(yield* service.getDebugTableCounts()).toMatchObject({
          eventHistory: 2,
          userStreaks: 1,
          unlockedAchievements: 1,
        });

        const outbox = yield* parseOutbox(
          yield* sql`SELECT effect_id,announcement_state,metric_state FROM achievement_unlock_outbox`,
        );

        expect(outbox).toEqual([
          {
            effect_id: `${eventId(1)}:first_request`,
            announcement_state: "pending",
            metric_state: "pending",
          },
        ]);
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "awards Stream Opener only to the first request strictly after session source time",
    () =>
      Effect.gen(function* () {
        const service = yield* Achievements;
        yield* service.handleEvent(online(100, 10));
        yield* service.handleEvent(request(1, 9, "early", "Early"));
        yield* service.handleEvent(request(2, 10, "equal", "Equal"));
        yield* service.handleEvent(request(3, 11, "first", "First"));
        yield* service.handleEvent(request(4, 12, "second", "Second"));

        for (const name of ["Early", "Equal", "Second"])
          expect(
            (yield* service.getUnlockedAchievements({ userDisplayName: name })).map(
              (row) => row.id,
            ),
          ).not.toContain("stream_opener");
        expect(
          (yield* service.getUnlockedAchievements({ userDisplayName: "First" })).map(
            (row) => row.id,
          ),
        ).toContain("stream_opener");
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "rejects stale, duplicate-stream and mismatched offline transitions without resetting progress",
    () =>
      Effect.gen(function* () {
        const service = yield* Achievements;
        yield* service.handleEvent(online(100, 0, "first"));

        for (let index = 1; index <= 5; index++) yield* service.handleEvent(request(index));
        yield* service.handleEvent(offline(101, 20, "wrong"));
        yield* service.handleEvent(online(102, 30, "first"));
        yield* service.handleEvent(online(103, -1, "older"));
        expect(
          (yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
            (row) => row.id,
          ),
        ).toEqual(
          expect.arrayContaining(["stream_opener", "streak_3", "streak_5", "first_request"]),
        );
        yield* service.handleEvent(offline(104, 40, "first"));
        yield* service.handleEvent(online(105, 10, "first"));
        yield* service.handleEvent(online(106, 50, "next"));
        expect(
          (yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
            (row) => row.id,
          ),
        ).toEqual(["first_request"]);
        yield* service.handleEvent(request(6, 51));
        yield* service.handleEvent(request(7, 52));
        expect(
          (yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
            (row) => row.id,
          ),
        ).not.toContain("streak_3");
        yield* service.handleEvent(request(8, 53));
        expect(
          (yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
            (row) => row.id,
          ),
        ).toContain("streak_3");
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT session_streak,longest_streak FROM user_streaks`).toMatchObject([
          { session_streak: 3, longest_streak: 5 },
        ]);
        expect(
          yield* sql`SELECT announcement_state FROM achievement_unlock_outbox WHERE effect_id=${`${eventId(1)}:stream_opener`}`,
        ).toMatchObject([{ announcement_state: "abandoned" }]);
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "all thirteen achievements unlock through domain events, including streak set semantics",
    () =>
      Effect.gen(function* () {
        const service = yield* Achievements;
        yield* service.handleEvent(online(1000, 0));

        for (let index = 1; index <= 100; index++) yield* service.handleEvent(request(index));

        for (let index = 101; index <= 199; index++)
          yield* service.handleEvent(raffle(index, 9_900, 10_000, index === 101));
        yield* service.handleEvent(raffle(200, 10_000, 10_000));
        const unlocked = yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" });
        expect(unlocked).toHaveLength(13);
        expect(
          (yield* service.getUserAchievements({ userDisplayName: "Viewer" })).find(
            (row) => row.achievementId === "streak_5",
          )?.progress,
        ).toBe(5);
        expect(
          (yield* service.getUserAchievements({ userDisplayName: "Viewer" })).find(
            (row) => row.achievementId === "close_call",
          )?.progress,
        ).toBe(99);
        expect(yield* service.getLeaderboard({ limit: Option.some(PageSize.make(1)) })).toEqual([
          { userDisplayName: "Viewer", count: 13 },
        ]);
        expect(yield* service.getUnannounced()).toHaveLength(13);
      }).pipe(Effect.provide(database)),
  );
  it.effect("winners never unlock close-call or closest-ever and distance 101 is excluded", () =>
    Effect.gen(function* () {
      const service = yield* Achievements;
      yield* service.handleEvent(raffle(1, 10_000, 10_000));
      yield* service.handleEvent(raffle(2, 9_899, 10_000));
      expect(
        (yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
          (row) => row.id,
        ),
      ).toEqual(expect.arrayContaining(["first_roll", "first_win"]));
      expect(
        (yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
          (row) => row.id,
        ),
      ).not.toContain("close_call");
      yield* service.handleEvent(raffle(3, 9_900, 10_000));
      expect(
        (yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
          (row) => row.id,
        ),
      ).toContain("close_call");
    }).pipe(Effect.provide(database)),
  );
  it.effect(
    "one-time reset preserves cumulative/session unlocks and cancels stale announcements",
    () =>
      Effect.gen(function* () {
        const service = yield* Achievements;
        const sql = yield* SqlClient.SqlClient;
        yield* service.handleEvent(online(100, 0));
        yield* service.handleEvent(request(1));
        yield* service.handleEvent(raffle(2, 9_999, 10_000, true));
        expect(
          yield* service.resetOneTimeAchievements({ userDisplayName: Option.some("Other") }),
        ).toMatchObject({ deleted: 0 });
        const reset = yield* service.resetOneTimeAchievements({ userDisplayName: Option.none() });
        expect(reset).toEqual({ deleted: 2, achievementIds: ["close_call", "closest_ever"] });
        expect(
          (yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
            (row) => row.id,
          ),
        ).toEqual(expect.arrayContaining(["first_request", "first_roll", "stream_opener"]));
        yield* service.handleEvent(raffle(2, 9_999, 10_000, true));
        expect(
          (yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
            (row) => row.id,
          ),
        ).not.toContain("close_call");
        yield* service.handleEvent(raffle(3, 9_998, 10_000, true));
        expect(
          (yield* service.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
            (row) => row.id,
          ),
        ).toContain("close_call");
        expect(
          yield* sql`SELECT announcement_state FROM achievement_unlock_outbox WHERE effect_id=${`${eventId(2)}:close_call`}`,
        ).toMatchObject([{ announcement_state: "abandoned" }]);
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "failure writing an outbox intent rolls back inbox, progress and streak; retry succeeds",
    () =>
      Effect.gen(function* () {
        const service = yield* Achievements;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER reject_unlock BEFORE INSERT ON achievement_unlock_outbox BEGIN SELECT RAISE(ABORT,'outbox rejected'); END`;
        expect((yield* service.handleEvent(request(1)).pipe(Effect.flip)).reason).toBe(
          "persistence_unavailable",
        );
        expect(yield* service.getDebugTableCounts()).toMatchObject({
          eventHistory: 0,
          userAchievements: 0,
          userStreaks: 0,
        });
        yield* sql`DROP TRIGGER reject_unlock`;
        yield* service.handleEvent(request(1));
        expect(yield* service.getDebugTableCounts()).toMatchObject({
          eventHistory: 1,
          unlockedAchievements: 1,
          userStreaks: 1,
        });
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "direct events share the inbox and set request streak counts without additive inflation",
    () =>
      Effect.gen(function* () {
        const service = yield* Achievements;

        const input = AchievementEventInput.make({
          userId: ViewerId.make("viewer"),
          userDisplayName: "Viewer",
          event: "request_streak",
          eventId: eventId(1),
          increment: 1,
          metadata: Option.some({ streakCount: 3 }),
        });

        expect((yield* service.recordEvent(input)).map((row) => row.id)).toEqual(["streak_3"]);
        expect(yield* service.recordEvent(input)).toEqual([]);
        yield* service.recordEvent({
          ...input,
          eventId: eventId(2),
          metadata: Option.some({ streakCount: 4 }),
        });
        expect(
          (yield* service.getUserAchievements({ userDisplayName: "Viewer" })).find(
            (row) => row.achievementId === "streak_5",
          )?.progress,
        ).toBe(4);
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "diagnostic normalization includes exact/case/underscore matches without merging viewer IDs",
    () =>
      Effect.gen(function* () {
        const service = yield* Achievements;
        yield* service.handleEvent(request(1, 1, "a", "Some_User"));
        yield* service.handleEvent(request(2, 2, "b", "SomeUser"));
        const debug = yield* service.getDebugUserSnapshot({ userDisplayName: " @some_user " });
        expect(debug.normalizedUser).toBe("some_user");
        expect(debug.exactUserAchievementRows).toBe(0);
        expect(debug.caseInsensitiveUserAchievementRows).toBe(4);
        expect(debug.similarUsers).toEqual(["Some_User", "SomeUser"]);
        expect(debug.recentEvents).toHaveLength(1);
      }).pipe(Effect.provide(database)),
  );
  it.effect("generated redelivery permutations advance each event once", () =>
    Effect.gen(function* () {
      const service = yield* Achievements;

      const ids = FastCheck.sample(FastCheck.integer({ min: 1, max: 20 }), {
        seed: 871,
        numRuns: 100,
      });

      for (const id of ids) yield* service.handleEvent(request(id));
      const unique = new Set(ids).size;
      expect(
        (yield* service.getUserAchievements({ userDisplayName: "Viewer" })).find(
          (row) => row.achievementId === "request_50",
        )?.progress,
      ).toBe(unique);
      expect((yield* service.getDebugTableCounts()).eventHistory).toBe(unique);
    }).pipe(Effect.provide(database)),
  );
  it.effect("corrupt definitions fail with typed stored-data errors", () =>
    Effect.gen(function* () {
      const service = yield* Achievements;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE achievement_definitions SET category='corrupt' WHERE id='first_request'`;
      expect((yield* service.getDefinitions().pipe(Effect.flip)).reason).toBe(
        "invalid_stored_data",
      );
    }).pipe(Effect.provide(database)),
  );
  it.effect(
    "SQL rehydration retains definitions/progress/streaks/inbox/watermark/outbox and fences interrupted sends",
    () =>
      Effect.gen(function* () {
        const original = yield* Achievements;
        const sql = yield* SqlClient.SqlClient;
        yield* original.handleEvent(online(100, 0));

        for (let index = 1; index <= 3; index++) yield* original.handleEvent(request(index));
        yield* sql`UPDATE achievement_unlock_outbox SET announcement_state='sending',metric_state='claimed' WHERE effect_id=${`${eventId(1)}:first_request`}`;
        const before = yield* original.getDebugTableCounts();
        yield* Effect.gen(function* () {
          const recovered = yield* Achievements;
          expect(yield* recovered.getDebugTableCounts()).toEqual(before);
          expect(
            (yield* recovered.getUnlockedAchievements({ userDisplayName: "Viewer" })).map(
              (row) => row.id,
            ),
          ).toEqual(expect.arrayContaining(["first_request", "stream_opener", "streak_3"]));
          yield* recovered.handleEvent(online(101, -1, "older"));
          yield* recovered.handleEvent(request(3));
          expect(
            (yield* recovered.getUserAchievements({ userDisplayName: "Viewer" })).find(
              (row) => row.achievementId === "request_10",
            )?.progress,
          ).toBe(3);
        }).pipe(Effect.provide(Layer.fresh(achievementsLayer)));
        expect(
          yield* sql`SELECT announcement_state,metric_state FROM achievement_unlock_outbox WHERE effect_id=${`${eventId(1)}:first_request`}`,
        ).toEqual([{ announcement_state: "uncertain", metric_state: "claimed" }]);
        expect(yield* sql`SELECT status,stream_id FROM achievement_stream_session`).toEqual([
          { status: "online", stream_id: "stream" },
        ]);
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "real HTTP definitions, event intake, viewer, debug and reset preserve JSON options",
    () =>
      Effect.gen(function* () {
        const web = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              HttpApiBuilder.layer(AchievementsHttpApi).pipe(
                Layer.provide(achievementsHttpHandlersLayer),
                Layer.provide(database),
                Layer.provide(cloudflareHttpServerLayer),
              ),
              { disableLogger: true },
            ),
          ),
          (web) => Effect.promise(() => web.dispose()),
        );

        const send = Effect.fn("AchievementsTest.send")(function* (
          operation: string,
          payload: AchievementHttpTestPayload,
        ) {
          const body = yield* parseAchievementHttpTestPayload(payload);

          return yield* Effect.promise(() =>
            web.handler(
              new Request(`http://achievements.internal/v1/${operation}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
            ),
          );
        });

        const event = Schema.encodeSync(SongRequestSuccessEvent)(request(1));
        expect((yield* send("handleEvent", { event })).status).toBe(200);
        const viewer = yield* send("getUserAchievements", { userDisplayName: "Viewer" });
        expect(viewer.status).toBe(200);
        const body = yield* Effect.promise(() => viewer.json());
        expect(body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ achievementId: "first_request", unlocked: true }),
            expect.objectContaining({
              achievementId: "stream_opener",
              threshold: null,
              unlockedAt: null,
            }),
          ]),
        );
        expect((yield* send("getLeaderboard", { limit: 101 })).status).toBeGreaterThanOrEqual(400);
        expect((yield* send("resetOneTimeAchievements", { userDisplayName: null })).status).toBe(
          200,
        );
      }).pipe(Effect.scoped),
  );
});
