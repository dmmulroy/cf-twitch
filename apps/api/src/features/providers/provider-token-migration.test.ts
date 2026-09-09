import { SqliteClient } from "@effect/sql-sqlite-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  ProviderTokenDatabase,
  TokenProviderIdentity,
  providerTokenDatabaseLayerWithoutDependencies,
} from "./provider-token-database.ts";

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });

for (const provider of ["spotify", "twitch"] as const) {
  for (const version of ["legacy", "versioned"] as const) {
    it.effect(
      `${provider} imports ${version} Agent credentials and exact retry deadline without deleting source tables`,
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const historical = {
            token: {
              accessToken: "legacy-access",
              refreshToken: "rotated-refresh",
              tokenType: "Bearer",
              expiresIn: 3600,
              expiresAt: "2026-01-01T01:00:00+01:00",
            },
            isStreamLive: true,
            refreshScheduleId: "refresh-retry-2",
            refreshRetryCount: 2,
          };

          const state = JSON.stringify(
            version === "versioned"
              ? { ...historical, version: 1, authorizationStatus: "authorized" }
              : historical,
          );

          yield* sql`CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY NOT NULL, state TEXT)`;
          yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${state})`;
          yield* sql`INSERT INTO cf_agents_state VALUES ('cf_schema_version', '2')`;
          yield* sql`CREATE TABLE cf_agents_schedules(id TEXT PRIMARY KEY, callback TEXT, type TEXT, time INTEGER)`;
          yield* sql`INSERT INTO cf_agents_schedules VALUES ('refresh-retry-2', 'refreshTokenTick', 'delayed', 1767225500)`;

          const layer = providerTokenDatabaseLayerWithoutDependencies.pipe(
            Layer.provide(Layer.succeed(TokenProviderIdentity, provider)),
          );

          const imported = yield* Effect.gen(function* () {
            const database = yield* ProviderTokenDatabase;

            return yield* database.readState();
          }).pipe(Effect.provide(layer));

          expect(imported.authorizationStatus).toBe("authorized");
          expect(imported.isStreamLive).toBe(true);
          expect(imported.refreshRetryCount).toBe(2);
          expect(imported.nextRefreshAtMs).toEqual(Option.some(1_767_225_500_000));
          const token = Option.getOrThrow(imported.token);
          expect(Redacted.value(token.accessToken)).toBe("legacy-access");
          expect(Redacted.value(Option.getOrThrow(token.refreshToken))).toBe("rotated-refresh");
          expect(token.expiresAtMs).toBe(Date.parse("2026-01-01T00:00:00Z"));
          expect(JSON.stringify(imported)).not.toContain("rotated-refresh");
          expect(
            yield* sql`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id'`,
          ).toEqual([{ state }]);
          expect(yield* sql`SELECT time FROM cf_agents_schedules`).toEqual([{ time: 1767225500 }]);
          // A restart reads the new authoritative state, never re-imports the obsolete source row.
          yield* Effect.gen(function* () {
            const database = yield* ProviderTokenDatabase;
            yield* database.writeState({
              ...imported,
              isStreamLive: false,
              nextRefreshAtMs: Option.none(),
            });
          }).pipe(Effect.provide(layer, { local: true }));

          const restored = yield* Effect.gen(function* () {
            const database = yield* ProviderTokenDatabase;

            return yield* database.readState();
          }).pipe(Effect.provide(layer, { local: true }));

          expect(restored.isStreamLive).toBe(false);
          expect(restored.nextRefreshAtMs).toEqual(Option.none());
        }).pipe(Effect.provide(sqliteLayer)),
    );
  }

  for (const missingScheduleEvidence of ["table", "referenced-row"] as const) {
    for (const isStreamLive of [true, false]) {
      it.effect(
        `${provider} rejects a ${isStreamLive ? "live" : "offline"} legacy refresh schedule when its ${missingScheduleEvidence} is missing`,
        () =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            const state = JSON.stringify({
              token: {
                accessToken: "legacy-access",
                refreshToken: "legacy-refresh",
                tokenType: "Bearer",
                expiresIn: 3600,
                expiresAt: "2026-01-01T00:00:00Z",
              },
              isStreamLive,
              refreshScheduleId: "missing-refresh-schedule",
              refreshRetryCount: 0,
            });

            yield* sql`CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY NOT NULL, state TEXT)`;
            yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${state})`;

            if (missingScheduleEvidence === "referenced-row")
              yield* sql`CREATE TABLE cf_agents_schedules(id TEXT PRIMARY KEY, callback TEXT, type TEXT, time INTEGER)`;

            const result = yield* Effect.gen(function* () {
              const database = yield* ProviderTokenDatabase;

              return yield* database.readState();
            }).pipe(
              Effect.provide(
                providerTokenDatabaseLayerWithoutDependencies.pipe(
                  Layer.provide(Layer.succeed(TokenProviderIdentity, provider)),
                ),
              ),
              Effect.result,
            );

            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { operation: "LegacyAgentStateImportRequired", kind: "persistence" },
            });
            expect(yield* sql`SELECT state FROM cf_agents_state`).toEqual([{ state }]);
            expect(
              yield* sql`SELECT name FROM sqlite_master WHERE name = 'provider_token_state'`,
            ).toEqual([]);
          }).pipe(Effect.provide(sqliteLayer)),
      );
    }
  }

  for (const authorizationStatus of ["not-configured", "reauthorization-required"] as const) {
    it.effect(
      `${provider} preserves ${authorizationStatus} without resurrecting proactive refresh`,
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const state = JSON.stringify({
            version: 1,
            token:
              authorizationStatus === "not-configured"
                ? null
                : {
                    accessToken: "revoked-access",
                    refreshToken: "revoked-refresh",
                    tokenType: "Bearer",
                    expiresIn: 3600,
                    expiresAt: "2026-01-01T00:00:00Z",
                  },
            isStreamLive: true,
            authorizationStatus,
            refreshScheduleId: null,
            refreshRetryCount: 0,
          });

          yield* sql`CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY NOT NULL, state TEXT)`;
          yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${state})`;

          const imported = yield* Effect.gen(function* () {
            const database = yield* ProviderTokenDatabase;

            return yield* database.readState();
          }).pipe(
            Effect.provide(
              providerTokenDatabaseLayerWithoutDependencies.pipe(
                Layer.provide(Layer.succeed(TokenProviderIdentity, provider)),
              ),
            ),
          );

          expect(imported.authorizationStatus).toBe(authorizationStatus);
          expect(imported.nextRefreshAtMs).toEqual(Option.none());
        }).pipe(Effect.provide(sqliteLayer)),
    );
  }
}
