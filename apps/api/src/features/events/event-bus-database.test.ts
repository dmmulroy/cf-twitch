import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { PageSize } from "@cf-twitch/contracts/identity";
import { SqlClient } from "effect/unstable/sql";
import { makeEventBusDatabase } from "./event-bus-database.ts";

const eventJson = JSON.stringify({
  id: "550e8400-e29b-41d4-a716-446655440000",
  type: "song_request_success",
  v: 1,
  timestamp: "2026-01-30T12:00:00.000Z",
  source: "SongRequestSagaDO",
  userId: "viewer-1",
  userDisplayName: "Viewer",
  sagaId: "redemption-1",
  trackId: "abc123",
});

describe("Event Bus database migration", () => {
  it.effect("adopts baseline SQL rows and validates historical schedule state", () => {
    const sqlLayer = SqliteClient.layer({ filename: ":memory:" });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE pending_events (id TEXT PRIMARY KEY NOT NULL,event TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_retry_at TEXT NOT NULL,created_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE dead_letter_queue (id TEXT PRIMARY KEY NOT NULL,event TEXT NOT NULL,error TEXT NOT NULL,attempts INTEGER NOT NULL,first_failed_at TEXT NOT NULL,last_failed_at TEXT NOT NULL,expires_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE delivered_events (id TEXT PRIMARY KEY NOT NULL,delivered_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY NOT NULL,state TEXT)`;
      yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${JSON.stringify({ retrySweepScheduleId: "legacy-retry", retrySweepDueAt: "2026-01-30T12:00:01.000Z", dlqPurgeScheduleId: null, dlqPurgeDueAt: null })})`;
      yield* sql`INSERT INTO pending_events VALUES ('550e8400-e29b-41d4-a716-446655440000',${eventJson},0,'2026-01-30T12:00:01.000Z','2026-01-30T12:00:00.000Z')`;

      const database = yield* makeEventBusDatabase;
      expect(yield* database.counts()).toMatchObject({
        pendingCount: 1,
        deadLetterCount: 0,
        deliveredCount: 0,
        subscriptionCount: 4,
      });
      expect(
        (yield* database.listPending({ limit: PageSize.make(10), offset: 0 })).rows[0]?.event,
      ).toBe(eventJson);
    }).pipe(Effect.provide(sqlLayer));
  });

  it.effect("blocks corrupt historical schedule state instead of resetting it", () => {
    const sqlLayer = SqliteClient.layer({ filename: ":memory:" });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const corrupt = "{not-json";
      yield* sql`CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY NOT NULL,state TEXT)`;
      yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${corrupt})`;
      const result = yield* makeEventBusDatabase.pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* sql`SELECT state FROM cf_agents_state`).toEqual([{ state: corrupt }]);
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'event_bus_schema_migrations'`,
      ).toEqual([]);
    }).pipe(Effect.provide(sqlLayer));
  });
});
