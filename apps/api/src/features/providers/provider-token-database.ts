import { SqliteMigrator } from "@effect/sql-sqlite-do";
import {
  ProviderError,
  ProviderTokens,
  type ProviderFailureReason,
  type ProviderOperation,
} from "@cf-twitch/contracts/provider";
import { IsoTimestamp } from "@cf-twitch/contracts/identity";
import { Clock, Context, Effect, Layer, Option, Ref, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { ProviderTokenIdentity } from "./provider-token-identity.ts";
import { ProviderTokenState, initialProviderTokenState } from "./provider-token-state.ts";

/** Durable token state store that belongs to exactly one provider token Durable Object. */
export interface IProviderTokenDatabase {
  /**
   * Reads the current token state, or the initial unconfigured state when nothing is stored.
   *
   * @returns The parsed state, or fails with `ProviderError` reason `persistence` when SQL fails, or `stored-state-invalid` when the stored row cannot be parsed.
   */
  readonly readState: () => Effect.Effect<ProviderTokenState, ProviderError>;
  /**
   * Replaces the stored token state.
   *
   * @returns Nothing, or fails with `ProviderError` reason `persistence` when SQL fails, or `stored-state-invalid` when the state violates its invariants.
   */
  readonly writeState: (state: ProviderTokenState) => Effect.Effect<void, ProviderError>;
}

/** Service that persists provider token state, separate from provider refresh I/O. */
export class ProviderTokenDatabase extends Context.Service<
  ProviderTokenDatabase,
  IProviderTokenDatabase
>()("@cf-twitch/ProviderTokenDatabase") {}

const encodeProviderTokenStateJson = Schema.encodeEffect(Schema.fromJsonString(ProviderTokenState));

const parseProviderTokenStateRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ state_json: Schema.fromJsonString(ProviderTokenState) })),
);

const LegacyAgentTokenState = Schema.Struct({
  version: Schema.OptionFromOptionalKey(Schema.Literal(1)),
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
  authorizationStatus: Schema.OptionFromOptionalKey(ProviderTokenState.fields.authorizationStatus),
  refreshScheduleId: Schema.OptionFromNullOr(Schema.NonEmptyString),
  refreshRetryCount: ProviderTokenState.fields.refreshRetryCount,
}).check(
  Schema.makeFilter(
    (state) =>
      (Option.isNone(state.version) || Option.isSome(state.authorizationStatus)) &&
      (!Option.contains(state.authorizationStatus, "authorized") || Option.isSome(state.token)) &&
      (!Option.contains(state.authorizationStatus, "not-configured") || Option.isNone(state.token)),
  ),
);

type LegacyAgentTokenState = typeof LegacyAgentTokenState.Type;

const parseLegacyAgentTokenRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ state: Schema.fromJsonString(LegacyAgentTokenState) })),
);

const parseLegacyAgentSchedules = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      callback: Schema.Literal("refreshTokenTick"),
      type: Schema.Literals(["scheduled", "delayed"]),
      time: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
);

const migrationLoader = SqliteMigrator.fromRecord({
  "1_provider_token_state": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE provider_token_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state_json TEXT NOT NULL)`;
  }),
});

const translateLegacyProviderTokenState = (
  legacy: LegacyAgentTokenState,
  referencedScheduleAtMs: Option.Option<number>,
  now: number,
): ProviderTokenState => {
  const authorizationStatus = Option.getOrElse(
    legacy.authorizationStatus,
    (): ProviderTokenState["authorizationStatus"] =>
      Option.isSome(legacy.token) ? "authorized" : "not-configured",
  );

  const token = Option.map(legacy.token, (stored) => ({
    accessToken: stored.accessToken,
    refreshToken: Option.some(stored.refreshToken),
    tokenType: stored.tokenType,
    expiresIn: stored.expiresIn,
    scopes: [],
    expiresAtMs: Date.parse(stored.expiresAt),
  }));

  const nextRefreshAtMs =
    legacy.isStreamLive && authorizationStatus === "authorized" && Option.isSome(token)
      ? Option.orElse(referencedScheduleAtMs, () =>
          Option.some(Math.max(now + 1000, token.value.expiresAtMs - 300_000)),
        )
      : Option.none<number>();

  return {
    token,
    isStreamLive: legacy.isStreamLive,
    authorizationStatus,
    refreshRetryCount: legacy.refreshRetryCount,
    nextRefreshAtMs,
  };
};

/**
 * Creates the provider token database over the Durable Object's SQLite storage, importing historical Agent state once.
 *
 * **Details**
 *
 * Historical credentials are never silently reset or overwritten. Source evidence is parsed before destination tables are created.
 *
 * @returns The database, or fails with `ProviderError` operation `importLegacyTokenState` reason `stored-state-invalid` when historical Agent state is missing or malformed, or reason `persistence` when SQL or migration fails.
 */
export const makeProviderTokenDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const provider = yield* ProviderTokenIdentity;

  const failure = (operation: ProviderOperation, reason: ProviderFailureReason) =>
    new ProviderError({
      provider,
      operation,
      reason,
      status: Option.none(),
      retryAfterMs: Option.none(),
    });

  const readLegacyRefreshSchedule = Effect.fn("ProviderTokenDatabase.readLegacyRefreshSchedule")(
    function* (scheduleId: Option.Option<string>) {
      if (Option.isNone(scheduleId)) return Option.none<number>();

      const tables =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_schedules'`;

      if (tables.length === 0)
        return yield* Effect.fail(failure("importLegacyTokenState", "stored-state-invalid"));

      const schedules =
        yield* sql`SELECT callback, type, time FROM cf_agents_schedules WHERE id = ${scheduleId.value}`.pipe(
          Effect.flatMap(parseLegacyAgentSchedules),
        );

      const schedule = schedules[0];

      if (schedule === undefined)
        return yield* Effect.fail(failure("importLegacyTokenState", "stored-state-invalid"));

      return Option.some(schedule.time * 1000);
    },
  );

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
            Effect.flatMap(parseProviderTokenStateRows),
          );

        if (rows[0] !== undefined) return Option.none<ProviderTokenState>();
      }

      const legacyTables =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_state'`;

      if (legacyTables.length === 0) return Option.none<ProviderTokenState>();

      const rows = yield* sql`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id'`.pipe(
        Effect.flatMap(parseLegacyAgentTokenRows),
      );

      // An Agent table without its application row cannot establish safe token lifecycle state.
      if (rows[0] === undefined)
        return yield* Effect.fail(failure("importLegacyTokenState", "stored-state-invalid"));
      const legacy = rows[0].state;
      const referencedScheduleAtMs = yield* readLegacyRefreshSchedule(legacy.refreshScheduleId);
      const now = yield* Clock.currentTimeMillis;

      return Option.some(translateLegacyProviderTokenState(legacy, referencedScheduleAtMs, now));
    },
    Effect.catchTags({
      ProviderError: (error) => Effect.fail(error),
      SchemaError: () => Effect.fail(failure("importLegacyTokenState", "stored-state-invalid")),
      SqlError: () => Effect.fail(failure("importLegacyTokenState", "persistence")),
    }),
  );

  const imported = yield* readLegacyImport();
  yield* SqliteMigrator.run({ loader: migrationLoader, table: "provider_token_migrations" }).pipe(
    Effect.catchTags({
      MigrationError: () => Effect.fail(failure("migrateTokenState", "persistence")),
      SqlError: () => Effect.fail(failure("migrateTokenState", "persistence")),
    }),
  );

  const readState = Effect.fn("ProviderTokenDatabase.readState")(
    function* () {
      const rows = yield* sql`SELECT state_json FROM provider_token_state WHERE singleton = 1`.pipe(
        Effect.flatMap(parseProviderTokenStateRows),
      );

      if (rows[0] !== undefined) return rows[0].state_json;

      return initialProviderTokenState;
    },
    Effect.catchTags({
      SchemaError: () => Effect.fail(failure("readTokenState", "stored-state-invalid")),
      SqlError: () => Effect.fail(failure("readTokenState", "persistence")),
    }),
  );

  const writeState = Effect.fn("ProviderTokenDatabase.writeState")(
    function* (state: ProviderTokenState) {
      const encoded = yield* encodeProviderTokenStateJson(state);
      yield* sql`INSERT INTO provider_token_state(singleton, state_json) VALUES(1, ${encoded}) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json`;
    },
    Effect.catchTags({
      SchemaError: () => Effect.fail(failure("writeTokenState", "stored-state-invalid")),
      SqlError: () => Effect.fail(failure("writeTokenState", "persistence")),
    }),
  );

  if (Option.isSome(imported)) {
    const encoded = yield* encodeProviderTokenStateJson(imported.value).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(failure("importLegacyTokenState", "stored-state-invalid")),
      ),
    );

    yield* sql`INSERT INTO provider_token_state(singleton, state_json) VALUES(1, ${encoded}) ON CONFLICT(singleton) DO NOTHING`.pipe(
      Effect.catchTag("SqlError", () =>
        Effect.fail(failure("importLegacyTokenState", "persistence")),
      ),
    );
  }

  yield* readState();

  return ProviderTokenDatabase.of({ readState, writeState });
});

/** Layer that provides the provider token database with SQLite client and provider identity requirements visible. */
export const providerTokenDatabaseLayerWithoutDependencies = Layer.effect(
  ProviderTokenDatabase,
  makeProviderTokenDatabase,
);

/** Production provider token database Layer; the SQLite client comes from the Durable Object runtime, not an application dependency. */
export const providerTokenDatabaseLayer = providerTokenDatabaseLayerWithoutDependencies;

const validateProviderTokenState = Schema.encodeEffect(ProviderTokenState);

/**
 * Layer that provides an in-memory provider token database for the provider named by `ProviderTokenIdentity`.
 *
 * **Details**
 *
 * Starts unconfigured and rejects writes that violate the same state invariants as SQL storage. It has no historical Agent import.
 */
export const providerTokenDatabaseTestLayer = Layer.effect(
  ProviderTokenDatabase,
  Effect.gen(function* () {
    const provider = yield* ProviderTokenIdentity;
    const stored = yield* Ref.make(initialProviderTokenState);

    return ProviderTokenDatabase.of({
      readState: Effect.fn("ProviderTokenDatabaseTest.readState")(() => Ref.get(stored)),
      writeState: Effect.fn("ProviderTokenDatabaseTest.writeState")(function* (
        state: ProviderTokenState,
      ) {
        yield* validateProviderTokenState(state).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.fail(
              new ProviderError({
                provider,
                operation: "writeTokenState",
                reason: "stored-state-invalid",
                status: Option.none(),
                retryAfterMs: Option.none(),
              }),
            ),
          ),
        );
        yield* Ref.set(stored, state);
      }),
    });
  }),
);
