import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  ProviderTokenDatabase,
  TokenProviderIdentity,
  providerTokenDatabaseLayerWithoutDependencies,
  type ProviderTokenState,
} from "./provider-token-database.ts";

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
const databaseLayer = providerTokenDatabaseLayerWithoutDependencies.pipe(
  Layer.provide(Layer.succeed(TokenProviderIdentity, "spotify")),
  Layer.provideMerge(sqliteLayer),
);
const authorizedState: ProviderTokenState = {
  token: Option.some({
    accessToken: Redacted.make("synthetic-access"),
    refreshToken: Option.some(Redacted.make("synthetic-refresh")),
    tokenType: "Bearer",
    expiresIn: 3600,
    scopes: ["user-read-playback-state"],
    expiresAtMs: 3_600_000,
  }),
  isStreamLive: true,
  authorizationStatus: "authorized",
  refreshRetryCount: 2,
  nextRefreshAtMs: Option.some(120_000),
};

describe("Provider token real SQLite persistence", () => {
  it.effect("fresh local storage starts unconfigured without inventing credentials", () =>
    Effect.gen(function* () {
      const database = yield* ProviderTokenDatabase;
      expect(yield* database.readState()).toEqual({
        token: Option.none(),
        isStreamLive: false,
        authorizationStatus: "not-configured",
        refreshRetryCount: 0,
        nextRefreshAtMs: Option.none(),
      });
    }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "rehydrates redacted tokens, scopes, retry count and exact alarm intent across Layer restarts",
    () =>
      Effect.gen(function* () {
        const database = yield* ProviderTokenDatabase;
        yield* database.writeState(authorizedState);
        const restarted = yield* Effect.gen(function* () {
          const restored = yield* ProviderTokenDatabase;
          return yield* restored.readState();
        }).pipe(
          Effect.provide(
            providerTokenDatabaseLayerWithoutDependencies.pipe(
              Layer.provide(Layer.succeed(TokenProviderIdentity, "spotify")),
            ),
            { local: true },
          ),
        );
        expect(restarted).toEqual(authorizedState);
        expect(JSON.stringify(restarted)).not.toContain("synthetic-access");
        expect(JSON.stringify(restarted)).not.toContain("synthetic-refresh");
      }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "persists revoked authorization durably without discarding credentials or rescheduling",
    () =>
      Effect.gen(function* () {
        const database = yield* ProviderTokenDatabase;
        yield* database.writeState({
          ...authorizedState,
          authorizationStatus: "reauthorization-required",
          refreshRetryCount: 0,
          nextRefreshAtMs: Option.none(),
        });
        const stored = yield* database.readState();
        expect(stored.authorizationStatus).toBe("reauthorization-required");
        expect(stored.nextRefreshAtMs).toEqual(Option.none());
        expect(Option.isSome(stored.token)).toBe(true);
      }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "corrupt persisted credentials fail closed without resetting or exposing raw JSON",
    () =>
      Effect.gen(function* () {
        const database = yield* ProviderTokenDatabase;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO provider_token_state VALUES (1, '{"secret":"must-not-leak"}')`;
        const result = yield* database.readState().pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "persistence" } });
        expect(JSON.stringify(result)).not.toContain("must-not-leak");
        const rows = yield* sql`SELECT state_json FROM provider_token_state`;
        expect(rows).toEqual([{ state_json: '{"secret":"must-not-leak"}' }]);
      }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "a real SQLite write failure never claims token acceptance or replaces the previous state",
    () =>
      Effect.gen(function* () {
        const database = yield* ProviderTokenDatabase;
        const sql = yield* SqlClient.SqlClient;
        yield* database.writeState(authorizedState);
        yield* sql`CREATE TRIGGER fail_token BEFORE UPDATE ON provider_token_state BEGIN SELECT RAISE(FAIL, 'token write refused'); END`;
        const result = yield* database
          .writeState({ ...authorizedState, isStreamLive: false })
          .pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "persistence" } });
        expect((yield* database.readState()).isStreamLive).toBe(true);
      }).pipe(Effect.provide(databaseLayer)),
  );
});

for (const state of [
  JSON.stringify({ token: { accessToken: "partial-must-not-reset" } }),
  JSON.stringify({
    version: 99,
    token: null,
    isStreamLive: false,
    refreshScheduleId: null,
    refreshRetryCount: 0,
  }),
  "invalid-json-must-not-be-reset",
]) {
  it.effect(
    "blocks historical Agent cutover before creating new state and preserves every historical byte",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY NOT NULL, state TEXT)`;
        yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${state})`;
        yield* sql`CREATE TABLE cf_agents_schedules(id TEXT PRIMARY KEY, callback TEXT)`;
        yield* sql`INSERT INTO cf_agents_schedules VALUES ('old-schedule', 'refreshTokenTick')`;
        const result = yield* Effect.gen(function* () {
          const database = yield* ProviderTokenDatabase;
          return yield* database.readState();
        }).pipe(
          Effect.provide(
            providerTokenDatabaseLayerWithoutDependencies.pipe(
              Layer.provide(Layer.succeed(TokenProviderIdentity, "twitch")),
            ),
          ),
          Effect.result,
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { operation: "LegacyAgentStateImportRequired", kind: "persistence" },
        });
        expect(yield* sql`SELECT state FROM cf_agents_state`).toEqual([{ state }]);
        expect(yield* sql`SELECT callback FROM cf_agents_schedules`).toEqual([
          { callback: "refreshTokenTick" },
        ]);
        expect(
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'provider_token_state'`,
        ).toEqual([]);
      }).pipe(Effect.provide(sqliteLayer)),
  );
}
