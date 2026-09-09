import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { IsoTimestamp, NonNegativeInt } from "@cf-twitch/contracts/identity";
import {
  StreamLifecycleError,
  ViewerCountSnapshot,
  type ViewerHistoryInput,
} from "@cf-twitch/contracts/stream";
import {
  PersistedStreamState,
  decodePersistedStreamState,
  initialStreamState,
} from "./stream-state.ts";

const StoredStateRow = Schema.Struct({ state: Schema.String });

const CountRow = Schema.Struct({ count: NonNegativeInt });

const ViewerSnapshotRow = Schema.Struct({
  timestamp: IsoTimestamp,
  viewer_count: NonNegativeInt,
});

const LegacyViewerScheduleRow = Schema.Struct({
  callback: Schema.Literal("pollViewerCountTick"),
  type: Schema.Literal("scheduled"),
  time: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(253_402_300_799),
  ),
});

type EncodedViewerSnapshotRow = typeof ViewerSnapshotRow.Encoded;

/** Stream state and viewer evidence persistence operations. */
export interface IStreamDatabase {
  readonly getState: () => Effect.Effect<PersistedStreamState, StreamLifecycleError>;
  readonly saveState: (state: PersistedStreamState) => Effect.Effect<void, StreamLifecycleError>;
  readonly recordViewerCount: (input: {
    readonly state: PersistedStreamState;
    readonly count: NonNegativeInt;
    readonly recordedAt: IsoTimestamp;
  }) => Effect.Effect<PersistedStreamState, StreamLifecycleError>;
  readonly getViewerHistory: (input: ViewerHistoryInput) => Effect.Effect<
    {
      readonly snapshots: ReadonlyArray<ViewerCountSnapshot>;
      readonly totalCount: NonNegativeInt;
    },
    StreamLifecycleError
  >;
  readonly getViewerSnapshotCount: () => Effect.Effect<NonNegativeInt, StreamLifecycleError>;
  readonly reset: () => Effect.Effect<PersistedStreamState, StreamLifecycleError>;
}

/** Parsed Stream Lifecycle persistence with atomic state/checkpoint writes. */
export class StreamDatabase extends Context.Service<StreamDatabase, IStreamDatabase>()(
  "@cf-twitch/StreamDatabase",
) {}

const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS viewer_snapshots (
      timestamp TEXT PRIMARY KEY NOT NULL,
      viewer_count INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS stream_lifecycle_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL
    )
  `;
});

const migrationLoader = SqliteMigrator.fromRecord({
  "1_preserve_stream_lifecycle_authority": migration,
});

const parseStateRows = Schema.decodeUnknownEffect(Schema.Array(StoredStateRow));

const parseCountRows = Schema.decodeUnknownEffect(Schema.Array(CountRow));

const parseViewerRows = Schema.decodeUnknownEffect(Schema.Array(ViewerSnapshotRow));

const parseLegacyViewerScheduleRows = Schema.decodeUnknownEffect(
  Schema.Array(LegacyViewerScheduleRow),
);

const decodeLegacyStoredJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

const decodeCurrentStoredState = Schema.decodeEffect(Schema.fromJsonString(PersistedStreamState));

const encodeState = Schema.encodeEffect(Schema.fromJsonString(PersistedStreamState));

const streamError = (
  operation: StreamLifecycleError["operation"],
  reason: StreamLifecycleError["reason"],
) => new StreamLifecycleError({ operation, reason });

const withDatabaseErrors = <A>(
  operation: StreamLifecycleError["operation"],
  effect: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError | StreamLifecycleError>,
): Effect.Effect<A, StreamLifecycleError> =>
  effect.pipe(
    Effect.catchTags({
      StreamLifecycleError: (error) => Effect.fail(error),
      SchemaError: () => Effect.fail(streamError(operation, "stored_state_invalid")),
      SqlError: () => Effect.fail(streamError(operation, "persistence_unavailable")),
    }),
  );

/** Construct stream persistence and migrate historical Agent JSON exactly once. */
export const makeStreamDatabase: Effect.Effect<
  StreamDatabase["Service"],
  SqliteMigrator.MigrationError | SqlError.SqlError | Schema.SchemaError | StreamLifecycleError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const migrateLegacyViewerSchedule = Effect.fn("StreamDatabase.migrateLegacyViewerSchedule")(
    function* (state: PersistedStreamState) {
      if (state._tag !== "LiveStream" || state.viewerPollScheduleId === null) return state;
      const scheduleId = state.viewerPollScheduleId;

      const scheduleTable = yield* sql`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_agents_schedules'
    `.pipe(Effect.flatMap(parseCountRows));

      if ((scheduleTable[0]?.count ?? 0) === 0) {
        return yield* streamError("getState", "stored_state_invalid");
      }

      const schedules = yield* sql`
      SELECT callback, type, time FROM cf_agents_schedules WHERE id = ${scheduleId}
    `.pipe(Effect.flatMap(parseLegacyViewerScheduleRows));

      const schedule = schedules[0];

      if (schedule === undefined) return yield* streamError("getState", "stored_state_invalid");

      const dueAt = yield* Schema.decodeEffect(IsoTimestamp)(
        new Date(schedule.time * 1_000).toISOString(),
      );

      const checkpoint = state.transitionCheckpoint;

      return {
        ...state,
        viewerPollScheduleId: dueAt,
        transitionCheckpoint:
          checkpoint !== null && checkpoint.viewerPollScheduleId === scheduleId
            ? { ...checkpoint, viewerPollScheduleId: dueAt }
            : checkpoint,
      };
    },
  );

  // Decode whichever historical representation is authoritative before migrations write.
  // sqlite_master distinguishes an absent table from a storage failure, which must fail closed.
  const stateToInsert = yield* Effect.gen(function* () {
    const currentTable = yield* sql`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'stream_lifecycle_state'
    `.pipe(Effect.flatMap(parseCountRows));

    if ((currentTable[0]?.count ?? 0) > 0) {
      const currentRows = yield* sql`SELECT state FROM stream_lifecycle_state WHERE id = 1`.pipe(
        Effect.flatMap(parseStateRows),
      );

      if (currentRows[0] !== undefined) {
        return yield* decodeCurrentStoredState(currentRows[0].state);
      }
    }

    const legacyTable = yield* sql`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_agents_state'
    `.pipe(Effect.flatMap(parseCountRows));

    if ((legacyTable[0]?.count ?? 0) === 0) return initialStreamState();

    const legacyRows =
      yield* sql`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id' LIMIT 1`.pipe(
        Effect.flatMap(parseStateRows),
      );

    if (legacyRows[0] === undefined) return initialStreamState();

    const legacyState = yield* decodeLegacyStoredJson(legacyRows[0].state).pipe(
      Effect.flatMap(decodePersistedStreamState),
    );

    return yield* migrateLegacyViewerSchedule(legacyState);
  });

  yield* SqliteMigrator.run({ loader: migrationLoader, table: "stream_schema_migrations" });

  const currentRows = yield* sql`SELECT state FROM stream_lifecycle_state WHERE id = 1`.pipe(
    Effect.flatMap(parseStateRows),
  );

  if (currentRows[0] === undefined) {
    const encoded = yield* encodeState(stateToInsert);
    yield* sql`INSERT INTO stream_lifecycle_state (id, state) VALUES (1, ${encoded})`;
  }

  const getState: IStreamDatabase["getState"] = () =>
    withDatabaseErrors(
      "getState",
      Effect.gen(function* () {
        const rows = yield* sql`SELECT state FROM stream_lifecycle_state WHERE id = 1`.pipe(
          Effect.flatMap(parseStateRows),
        );

        if (rows[0] === undefined) return yield* streamError("getState", "stored_state_invalid");

        return yield* decodeCurrentStoredState(rows[0].state);
      }),
    );

  const saveState: IStreamDatabase["saveState"] = (state) =>
    withDatabaseErrors(
      "getState",
      encodeState(state).pipe(
        Effect.flatMap(
          (encoded) => sql`UPDATE stream_lifecycle_state SET state = ${encoded} WHERE id = 1`,
        ),
        Effect.asVoid,
      ),
    );

  const recordViewerCount: IStreamDatabase["recordViewerCount"] = (input) =>
    withDatabaseErrors(
      "recordViewerCount",
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT OR REPLACE INTO viewer_snapshots (timestamp, viewer_count)
            VALUES (${input.recordedAt}, ${input.count})
          `;

          const next =
            input.count > input.state.peakViewerCount
              ? { ...input.state, peakViewerCount: input.count }
              : input.state;

          if (next !== input.state) {
            const encoded = yield* encodeState(next);
            yield* sql`UPDATE stream_lifecycle_state SET state = ${encoded} WHERE id = 1`;
          }

          return next;
        }),
      ),
    );

  const getViewerHistory: IStreamDatabase["getViewerHistory"] = (input) =>
    withDatabaseErrors(
      "getViewerHistory",
      Effect.gen(function* () {
        const since = Option.getOrElse(input.since, () => "0000-01-01T00:00:00.000Z");
        const until = Option.getOrElse(input.until, () => "9999-12-31T23:59:59.999Z");

        const rows = yield* sql<EncodedViewerSnapshotRow>`
          SELECT timestamp, viewer_count FROM viewer_snapshots
          WHERE timestamp >= ${since} AND timestamp <= ${until}
          ORDER BY timestamp LIMIT ${input.limit} OFFSET ${input.offset}
        `.pipe(Effect.flatMap(parseViewerRows));

        const counts = yield* sql`
          SELECT COUNT(*) AS count FROM viewer_snapshots
          WHERE timestamp >= ${since} AND timestamp <= ${until}
        `.pipe(Effect.flatMap(parseCountRows));

        const snapshots: ReadonlyArray<ViewerCountSnapshot> = rows.map((row) => ({
          timestamp: row.timestamp,
          viewerCount: row.viewer_count,
        }));

        return { snapshots, totalCount: counts[0]?.count ?? 0 };
      }),
    );

  const getViewerSnapshotCount: IStreamDatabase["getViewerSnapshotCount"] = () =>
    withDatabaseErrors(
      "getDebugState",
      sql`SELECT COUNT(*) AS count FROM viewer_snapshots`.pipe(
        Effect.flatMap(parseCountRows),
        Effect.map((rows) => rows[0]?.count ?? 0),
      ),
    );

  const reset: IStreamDatabase["reset"] = () =>
    withDatabaseErrors(
      "reset",
      sql.withTransaction(
        Effect.gen(function* () {
          const state = initialStreamState();
          const encoded = yield* encodeState(state);
          yield* sql`DELETE FROM viewer_snapshots`;
          yield* sql`UPDATE stream_lifecycle_state SET state = ${encoded} WHERE id = 1`;

          return state;
        }),
      ),
    );

  return StreamDatabase.of({
    getState,
    saveState,
    recordViewerCount,
    getViewerHistory,
    getViewerSnapshotCount,
    reset,
  });
});

/** Stream persistence Layer that keeps its SQL client requirement visible. */
export const streamDatabaseLayerWithoutDependencies = Layer.effect(
  StreamDatabase,
  makeStreamDatabase,
);
