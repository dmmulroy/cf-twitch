import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Layer, Option, Predicate } from "effect";
import { SqlClient } from "effect/sql";
import { IsoTimestamp, NonNegativeInt, StreamId } from "@cf-twitch/contracts/identity";
import {
  makeStreamDatabase,
  StreamDatabase,
  streamDatabaseLayerWithoutDependencies,
  streamDatabaseTestLayer,
} from "./stream-database.ts";
import { LiveStreamState } from "./stream-state.ts";

type LegacyTransitionIntent = Data.TaggedEnum<{
  readonly StreamOnlineIntent: {
    readonly eventId: string;
    readonly streamSessionId: string;
    readonly transitionAt: string;
    readonly viewerPollScheduleId: string | null;
    readonly spotifyTokenNotified: boolean;
    readonly twitchTokenNotified: boolean;
    readonly lifecycleEventPublished: boolean;
    readonly viewerPollingUpdated: boolean;
  };
}>;

const LegacyTransitionIntent = Data.taggedEnum<LegacyTransitionIntent>();

type LegacyStreamState = Data.TaggedEnum<{
  readonly LiveStream: {
    readonly streamSessionId: string;
    readonly startedAt: string;
    readonly peakViewerCount: number;
    readonly viewerPollScheduleId: string | null;
    readonly transitionIntent: LegacyTransitionIntent;
  };
}>;

const LegacyStreamState = Data.taggedEnum<LegacyStreamState>();

const legacyState = LegacyStreamState.LiveStream({
  streamSessionId: "stream-123",
  startedAt: "2026-01-30T11:55:00.000Z",
  peakViewerCount: 41,
  viewerPollScheduleId: "viewer-poll-1",
  transitionIntent: LegacyTransitionIntent.StreamOnlineIntent({
    eventId: "550e8400-e29b-41d4-a716-446655440002",
    streamSessionId: "stream-123",
    transitionAt: "2026-01-30T11:55:00.000Z",
    viewerPollScheduleId: null,
    spotifyTokenNotified: true,
    twitchTokenNotified: false,
    lifecycleEventPublished: false,
    viewerPollingUpdated: false,
  }),
});

const corruptCurrentState =
  '{"_tag":"OfflineStream","lastStartedAt":"2026-01-30T11:55:00.000Z","endedAt":"2026-01-30T14:00:00.000Z","peakViewerCount":41,"transitionCheckpoint":{"eventId":"550e8400-e29b-41d4-a716-446655440002","streamId":"stream-123","transition":"online","transitionAt":"2026-01-30T14:00:00.000Z","viewerPollScheduleId":null,"spotifyTokenNotified":true,"twitchTokenNotified":false,"lifecycleEventPublished":false,"viewerPollingUpdated":false}}';

const incompleteCurrentState =
  '{"_tag":"OfflineStream","lastStartedAt":null,"endedAt":null,"peakViewerCount":0}';

const corruptHybridLegacyState =
  '{"_tag":"OfflineStream","lastStartedAt":"2026-01-30T11:55:00.000Z","endedAt":"2026-01-30T14:00:00.000Z","peakViewerCount":41,"transitionIntent":{"_tag":"MalformedTransitionIntent"},"isLive":false,"startedAt":"2026-01-30T11:55:00.000Z","streamSessionId":null,"viewerPollScheduleId":null}';

describe("Stream Lifecycle database migration", () => {
  it.effect("preserves baseline viewer evidence and partial Agent checkpoints", () => {
    const sqlLayer = SqliteClient.layer({ filename: ":memory:" });

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE viewer_snapshots (timestamp TEXT PRIMARY KEY NOT NULL,viewer_count INTEGER NOT NULL)`;
      yield* sql`INSERT INTO viewer_snapshots VALUES ('2026-01-30T12:00:00.000Z', 39)`;
      yield* sql`CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY NOT NULL,state TEXT)`;
      yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${JSON.stringify(legacyState)})`;
      yield* sql`CREATE TABLE cf_agents_schedules (id TEXT PRIMARY KEY,callback TEXT,type TEXT,time INTEGER)`;
      yield* sql`INSERT INTO cf_agents_schedules VALUES ('viewer-poll-1','pollViewerCountTick','scheduled',1769774400)`;

      const database = yield* makeStreamDatabase;
      const state = yield* database.getState();
      expect(state._tag).toBe("LiveStream");
      expect(state).toMatchObject({
        streamId: "stream-123",
        peakViewerCount: 41,
        viewerPollScheduleId: Option.some("2026-01-30T12:00:00.000Z"),
      });
      expect(Option.getOrThrow(state.transitionCheckpoint)).toMatchObject({
        spotifyTokenNotified: true,
        twitchTokenNotified: false,
        lifecycleEventPublished: false,
        viewerPollingUpdated: false,
      });
      // Option fields keep the historical JSON representation: absence is stored as null.
      expect(yield* sql`SELECT state FROM stream_lifecycle_state`).toEqual([
        {
          state: expect.stringContaining('"viewerPollScheduleId":null,"spotifyTokenNotified":true'),
        },
      ]);
      expect(yield* database.getViewerSnapshotCount()).toBe(1);
      expect(yield* sql`SELECT callback, type, time FROM cf_agents_schedules`).toEqual([
        { callback: "pollViewerCountTick", type: "scheduled", time: 1769774400 },
      ]);
    }).pipe(Effect.provide(sqlLayer));
  });

  it.effect("blocks an opaque schedule with mismatched callback metadata", () => {
    const sqlLayer = SqliteClient.layer({ filename: ":memory:" });

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY NOT NULL,state TEXT)`;
      yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${JSON.stringify(legacyState)})`;
      yield* sql`CREATE TABLE cf_agents_schedules (id TEXT PRIMARY KEY,callback TEXT,type TEXT,time INTEGER)`;
      yield* sql`INSERT INTO cf_agents_schedules VALUES ('viewer-poll-1','wrongCallback','scheduled',1769774400)`;

      expect((yield* makeStreamDatabase.pipe(Effect.result))._tag).toBe("Failure");
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'stream_schema_migrations'`,
      ).toEqual([]);
    }).pipe(Effect.provide(sqlLayer));
  });

  it.effect("blocks corrupt Agent state before writing migration metadata", () => {
    const sqlLayer = SqliteClient.layer({ filename: ":memory:" });

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const corrupt = "{not-json";
      yield* sql`CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY NOT NULL,state TEXT)`;
      yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${corrupt})`;

      const result = yield* makeStreamDatabase.pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* sql`SELECT state FROM cf_agents_state`).toEqual([{ state: corrupt }]);
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'stream_schema_migrations'`,
      ).toEqual([]);
    }).pipe(Effect.provide(sqlLayer));
  });

  it.effect("rejects malformed tagged legacy evidence instead of falling back to boolean", () => {
    const sqlLayer = SqliteClient.layer({ filename: ":memory:" });

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY NOT NULL,state TEXT)`;
      yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${corruptHybridLegacyState})`;

      const result = yield* makeStreamDatabase.pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      expect(yield* sql`SELECT state FROM cf_agents_state`).toEqual([
        { state: corruptHybridLegacyState },
      ]);
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'stream_schema_migrations'`,
      ).toEqual([]);
    }).pipe(Effect.provide(sqlLayer));
  });

  it.effect("rejects a current row missing its required checkpoint field", () => {
    const sqlLayer = SqliteClient.layer({ filename: ":memory:" });

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE stream_lifecycle_state (id INTEGER PRIMARY KEY CHECK (id = 1),state TEXT NOT NULL)`;
      yield* sql`INSERT INTO stream_lifecycle_state VALUES (1, ${incompleteCurrentState})`;

      const result = yield* makeStreamDatabase.pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      expect(yield* sql`SELECT state FROM stream_lifecycle_state`).toEqual([
        { state: incompleteCurrentState },
      ]);
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'stream_schema_migrations'`,
      ).toEqual([]);
    }).pipe(Effect.provide(sqlLayer));
  });

  it.effect("rejects corrupt current checkpoint evidence before migration writes", () => {
    const sqlLayer = SqliteClient.layer({ filename: ":memory:" });

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE stream_lifecycle_state (id INTEGER PRIMARY KEY CHECK (id = 1),state TEXT NOT NULL)`;
      yield* sql`INSERT INTO stream_lifecycle_state VALUES (1, ${corruptCurrentState})`;

      const result = yield* makeStreamDatabase.pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      expect(yield* sql`SELECT state FROM stream_lifecycle_state`).toEqual([
        { state: corruptCurrentState },
      ]);
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'stream_schema_migrations'`,
      ).toEqual([]);
    }).pipe(Effect.provide(sqlLayer));
  });

  it.effect("rejects corrupt current checkpoint evidence on later reads", () => {
    const sqlLayer = SqliteClient.layer({ filename: ":memory:" });

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const database = yield* makeStreamDatabase;
      yield* sql`UPDATE stream_lifecycle_state SET state = ${corruptCurrentState} WHERE id = 1`;

      const result = yield* database.getState().pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      expect(yield* sql`SELECT state FROM stream_lifecycle_state`).toEqual([
        { state: corruptCurrentState },
      ]);
    }).pipe(Effect.provide(sqlLayer));
  });
});

const at = (value: string) => IsoTimestamp.make(value);

const liveState = LiveStreamState.make({
  streamId: StreamId.make("stream-123"),
  startedAt: at("2026-01-30T11:55:00.000Z"),
  peakViewerCount: 5,
  viewerPollScheduleId: Option.none(),
  transitionCheckpoint: Option.none(),
  supersededStartedAt: Option.none(),
});

// The in-memory test Layer must stay observably equivalent to SQLite for every shared behavior.
const streamDatabaseImplementations = [
  [
    "real SQLite",
    streamDatabaseLayerWithoutDependencies.pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  ],
  ["in-memory test Layer", streamDatabaseTestLayer],
] as const;

for (const [implementation, layer] of streamDatabaseImplementations) {
  describe(`Stream Lifecycle persistence contract (${implementation})`, () => {
    it.effect("raises the peak only when exceeded and replaces a count at the same instant", () =>
      Effect.gen(function* () {
        const database = yield* StreamDatabase;
        yield* database.saveState(liveState);

        const lower = yield* database.recordViewerCount({
          state: liveState,
          count: NonNegativeInt.make(3),
          recordedAt: at("2026-01-30T12:00:00.000Z"),
        });

        expect(lower).toBe(liveState);

        const higher = yield* database.recordViewerCount({
          state: liveState,
          count: NonNegativeInt.make(9),
          recordedAt: at("2026-01-30T12:00:00.000Z"),
        });

        expect(higher.peakViewerCount).toBe(9);
        expect((yield* database.getState()).peakViewerCount).toBe(9);
        expect(yield* database.getViewerSnapshotCount()).toBe(1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("pages viewer history oldest first within inclusive bounds and resets", () =>
      Effect.gen(function* () {
        const database = yield* StreamDatabase;

        for (const [minute, count] of [
          ["03", 30],
          ["01", 10],
          ["02", 20],
        ] as const) {
          yield* database.recordViewerCount({
            state: liveState,
            count: NonNegativeInt.make(count),
            recordedAt: at(`2026-01-30T12:${minute}:00.000Z`),
          });
        }

        const page = yield* database.getViewerHistory({
          since: Option.some(at("2026-01-30T12:01:00.000Z")),
          until: Option.some(at("2026-01-30T12:02:00.000Z")),
          limit: 1,
          offset: 1,
        });

        expect(page).toEqual({
          snapshots: [{ timestamp: "2026-01-30T12:02:00.000Z", viewerCount: 20 }],
          totalCount: 2,
        });

        const reset = yield* database.reset();
        expect(Predicate.isTagged("OfflineStream")(reset)).toBe(true);
        expect(yield* database.getState()).toEqual(reset);
        expect(yield* database.getViewerSnapshotCount()).toBe(0);
      }).pipe(Effect.provide(layer)),
    );
  });
}
