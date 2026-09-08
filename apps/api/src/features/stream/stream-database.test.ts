import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { makeStreamDatabase } from "./stream-database.ts";

const legacyState = {
  _tag: "LiveStream",
  streamSessionId: "stream-123",
  startedAt: "2026-01-30T11:55:00.000Z",
  peakViewerCount: 41,
  viewerPollScheduleId: "viewer-poll-1",
  transitionIntent: {
    _tag: "StreamOnlineIntent",
    eventId: "550e8400-e29b-41d4-a716-446655440002",
    streamSessionId: "stream-123",
    transitionAt: "2026-01-30T11:55:00.000Z",
    viewerPollScheduleId: null,
    spotifyTokenNotified: true,
    twitchTokenNotified: false,
    lifecycleEventPublished: false,
    viewerPollingUpdated: false,
  },
};

const corruptCurrentState = JSON.stringify({
  _tag: "OfflineStream",
  lastStartedAt: "2026-01-30T11:55:00.000Z",
  endedAt: "2026-01-30T14:00:00.000Z",
  peakViewerCount: 41,
  transitionCheckpoint: {
    eventId: "550e8400-e29b-41d4-a716-446655440002",
    streamId: "stream-123",
    transition: "online",
    transitionAt: "2026-01-30T14:00:00.000Z",
    viewerPollScheduleId: null,
    spotifyTokenNotified: true,
    twitchTokenNotified: false,
    lifecycleEventPublished: false,
    viewerPollingUpdated: false,
  },
});

const incompleteCurrentState = JSON.stringify({
  _tag: "OfflineStream",
  lastStartedAt: null,
  endedAt: null,
  peakViewerCount: 0,
});

const corruptHybridLegacyState = JSON.stringify({
  _tag: "OfflineStream",
  lastStartedAt: "2026-01-30T11:55:00.000Z",
  endedAt: "2026-01-30T14:00:00.000Z",
  peakViewerCount: 41,
  transitionIntent: { _tag: "MalformedTransitionIntent" },
  isLive: false,
  startedAt: "2026-01-30T11:55:00.000Z",
  streamSessionId: null,
  viewerPollScheduleId: null,
});

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
      expect(yield* database.getState()).toMatchObject({
        _tag: "LiveStream",
        streamId: "stream-123",
        peakViewerCount: 41,
        viewerPollScheduleId: "2026-01-30T12:00:00.000Z",
        transitionCheckpoint: {
          spotifyTokenNotified: true,
          twitchTokenNotified: false,
          lifecycleEventPublished: false,
          viewerPollingUpdated: false,
        },
      });
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
