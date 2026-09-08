import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { OAuthProvider, ProviderError, ProviderTokens } from "@cf-twitch/contracts/provider";
import { IsoTimestamp } from "@cf-twitch/contracts/identity";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Durable token state stores the next alarm intent so restart repairs interrupted scheduling. */
export const ProviderTokenState = Schema.Struct({
  token: Schema.OptionFromNullOr(
    Schema.Struct({ ...ProviderTokens.fields, expiresAtMs: Schema.Number }),
  ),
  isStreamLive: Schema.Boolean,
  authorizationStatus: Schema.Literals([
    "not-configured",
    "authorized",
    "reauthorization-required",
  ]),
  refreshRetryCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  nextRefreshAtMs: Schema.OptionFromNullOr(Schema.Number),
}).check(
  Schema.makeFilter((state) =>
    state.authorizationStatus === "authorized"
      ? Option.isSome(state.token)
      : state.authorizationStatus === "not-configured"
        ? Option.isNone(state.token)
        : true,
  ),
);
/** Parsed durable token state keeps both credentials redacted. */
export type ProviderTokenState = typeof ProviderTokenState.Type;
/** Durable token database belongs to exactly one provider namespace. */
export interface IProviderTokenDatabase {
  readonly readState: () => Effect.Effect<ProviderTokenState, ProviderError>;
  readonly writeState: (state: ProviderTokenState) => Effect.Effect<void, ProviderError>;
}
/** Token persistence authority, separate from provider refresh I/O. */
export class ProviderTokenDatabase extends Context.Service<
  ProviderTokenDatabase,
  IProviderTokenDatabase
>()("@cf-twitch/ProviderTokenDatabase") {}
/** Provider selected by the physical token server, never by caller payload. */
export class TokenProviderIdentity extends Context.Service<
  TokenProviderIdentity,
  typeof OAuthProvider.Type
>()("@cf-twitch/TokenProviderIdentity") {}
const encodeState = Schema.encodeEffect(Schema.fromJsonString(ProviderTokenState));
const parseRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ state_json: Schema.fromJsonString(ProviderTokenState) })),
);
const LegacyAgentTokenState = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  token: Schema.OptionFromNullOr(
    Schema.Struct({
      accessToken: ProviderTokens.fields.accessToken,
      refreshToken: Schema.RedactedFromValue(Schema.NonEmptyString),
      tokenType: ProviderTokens.fields.tokenType,
      expiresIn: ProviderTokens.fields.expiresIn,
      expiresAt: IsoTimestamp,
    }),
  ),
  isStreamLive: Schema.Boolean,
  authorizationStatus: Schema.optionalKey(ProviderTokenState.fields.authorizationStatus),
  refreshScheduleId: Schema.OptionFromNullOr(Schema.NonEmptyString),
  refreshRetryCount: ProviderTokenState.fields.refreshRetryCount,
}).check(
  Schema.makeFilter(
    (state) =>
      (state.version === undefined || state.authorizationStatus !== undefined) &&
      (state.authorizationStatus === "authorized"
        ? Option.isSome(state.token)
        : state.authorizationStatus === "not-configured"
          ? Option.isNone(state.token)
          : true),
  ),
);
const parseLegacyRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ state: Schema.fromJsonString(LegacyAgentTokenState) })),
);
const parseLegacySchedules = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      callback: Schema.Literal("refreshTokenTick"),
      type: Schema.Literals(["scheduled", "delayed"]),
      time: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
);
const initialState: ProviderTokenState = {
  token: Option.none(),
  isStreamLive: false,
  authorizationStatus: "not-configured",
  refreshRetryCount: 0,
  nextRefreshAtMs: Option.none(),
};
const migrationLoader = SqliteMigrator.fromRecord({
  "1_provider_token_state": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE provider_token_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state_json TEXT NOT NULL)`;
  }),
});

/** Initialize token SQL without silently resetting or overwriting historical Agent credentials. */
export const makeProviderTokenDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const provider = yield* TokenProviderIdentity;
  const failure = () =>
    new ProviderError({
      provider,
      operation: "tokenPersistence",
      kind: "persistence",
      status: 0,
      retryAfterMs: Option.none(),
    });
  // agents@0.9.0 stores cf_state_row_id as JSON; schedule.time is Unix SECONDS.
  // Parse all source evidence before creating destination tables. Never invoke Agent.state,
  // whose malformed-JSON recovery overwrites historical credentials with initialState.
  const readLegacyImport = Effect.fn("ProviderTokenDatabase.readLegacyImport")(
    function* () {
      const destination =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_token_state'`;
      if (destination.length > 0) {
        const rows =
          yield* sql`SELECT state_json FROM provider_token_state WHERE singleton = 1`.pipe(
            Effect.flatMap(parseRows),
          );
        if (rows[0] !== undefined) return Option.none<ProviderTokenState>();
      }
      const legacyTables =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_state'`;
      if (legacyTables.length === 0) return Option.none<ProviderTokenState>();
      const rows = yield* sql`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id'`.pipe(
        Effect.flatMap(parseLegacyRows),
      );
      // An Agent table without its application row cannot establish safe token lifecycle state.
      if (rows[0] === undefined) return yield* Effect.fail(failure());
      const legacy = rows[0].state;
      const authorizationStatus =
        legacy.authorizationStatus ??
        (Option.isSome(legacy.token) ? "authorized" : "not-configured");
      const token = Option.map(legacy.token, (stored) => ({
        accessToken: stored.accessToken,
        refreshToken: Option.some(stored.refreshToken),
        tokenType: stored.tokenType,
        expiresIn: stored.expiresIn,
        scopes: [],
        expiresAtMs: Date.parse(stored.expiresAt),
      }));
      const now = yield* Clock.currentTimeMillis;
      let referencedScheduleAtMs = Option.none<number>();
      if (Option.isSome(legacy.refreshScheduleId)) {
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_schedules'`;
        if (tables.length === 0) return yield* Effect.fail(failure());
        const schedules =
          yield* sql`SELECT callback, type, time FROM cf_agents_schedules WHERE id = ${legacy.refreshScheduleId.value}`.pipe(
            Effect.flatMap(parseLegacySchedules),
          );
        const schedule = schedules[0];
        if (schedule === undefined) return yield* Effect.fail(failure());
        referencedScheduleAtMs = Option.some(schedule.time * 1000);
      }
      const nextRefreshAtMs =
        legacy.isStreamLive && authorizationStatus === "authorized" && Option.isSome(token)
          ? Option.orElse(referencedScheduleAtMs, () =>
              Option.some(Math.max(now + 1000, token.value.expiresAtMs - 300_000)),
            )
          : Option.none<number>();
      return Option.some({
        token,
        isStreamLive: legacy.isStreamLive,
        authorizationStatus,
        refreshRetryCount: legacy.refreshRetryCount,
        nextRefreshAtMs,
      });
    },
    Effect.mapError(
      () =>
        new ProviderError({
          provider,
          operation: "LegacyAgentStateImportRequired",
          kind: "persistence",
          status: 0,
          retryAfterMs: Option.none(),
        }),
    ),
  );
  const imported = yield* readLegacyImport();
  yield* SqliteMigrator.run({ loader: migrationLoader, table: "provider_token_migrations" }).pipe(
    Effect.mapError(failure),
  );
  const readState = Effect.fn("ProviderTokenDatabase.readState")(function* () {
    const rows = yield* sql`SELECT state_json FROM provider_token_state WHERE singleton = 1`.pipe(
      Effect.flatMap(parseRows),
    );
    if (rows[0] !== undefined) return rows[0].state_json;
    return initialState;
  }, Effect.mapError(failure));
  const writeState = Effect.fn("ProviderTokenDatabase.writeState")(function* (
    state: ProviderTokenState,
  ) {
    const encoded = yield* encodeState(state);
    yield* sql`INSERT INTO provider_token_state(singleton, state_json) VALUES(1, ${encoded}) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json`;
  }, Effect.mapError(failure));
  if (Option.isSome(imported)) {
    const encoded = yield* encodeState(imported.value).pipe(Effect.mapError(failure));
    yield* sql`INSERT INTO provider_token_state(singleton, state_json) VALUES(1, ${encoded}) ON CONFLICT(singleton) DO NOTHING`.pipe(
      Effect.mapError(failure),
    );
  }
  yield* readState();
  return ProviderTokenDatabase.of({ readState, writeState });
});
/** Token SQL persistence requires a real SQLite client and physical provider identity. */
export const providerTokenDatabaseLayerWithoutDependencies = Layer.effect(
  ProviderTokenDatabase,
  makeProviderTokenDatabase,
);
