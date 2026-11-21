import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Context, Effect, Layer, Option, Predicate, Ref, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
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

/** One viewer-count observation to record against the state it was observed in. */
export interface StreamDatabaseViewerCount {
  /** State read before the observation; its peak is raised when `count` exceeds it. */
  readonly state: PersistedStreamState;
  readonly count: NonNegativeInt;
  /** Source time of the observation; a second observation at the same time replaces it. */
  readonly recordedAt: IsoTimestamp;
}

/** Page of viewer-count observations with the total matching count before pagination. */
export interface StreamDatabaseViewerHistoryPage {
  readonly snapshots: ReadonlyArray<ViewerCountSnapshot>;
  readonly totalCount: NonNegativeInt;
}

/**
 * Stream Lifecycle persistence: the tagged state with its transition checkpoint, and viewer counts.
 *
 * **Details**
 *
 * Each operation fails with `StreamLifecycleError` whose reason is `persistence_unavailable` when
 * SQL fails and `stored_state_invalid` when the stored state does not parse.
 */
export interface IStreamDatabase {
  /**
   * Returns the persisted state.
   *
   * @returns The state, or fails with `StreamLifecycleError` when storage fails or the row is
   *   missing or invalid.
   */
  readonly getState: () => Effect.Effect<PersistedStreamState, StreamLifecycleError>;
  /**
   * Replaces the persisted state, including its checkpoint, in one write.
   *
   * @returns Nothing, or fails with `StreamLifecycleError` when storage fails.
   */
  readonly saveState: (state: PersistedStreamState) => Effect.Effect<void, StreamLifecycleError>;
  /**
   * Atomically records a viewer count and raises the state's peak when it is exceeded.
   *
   * @returns The state after the peak update, or fails with `StreamLifecycleError` when storage
   *   fails.
   */
  readonly recordViewerCount: (
    input: StreamDatabaseViewerCount,
  ) => Effect.Effect<PersistedStreamState, StreamLifecycleError>;
  /**
   * Returns viewer counts within inclusive time bounds, oldest first.
   *
   * @returns The page and total count, or fails with `StreamLifecycleError` when storage fails or
   *   stored rows are invalid.
   */
  readonly getViewerHistory: (
    input: ViewerHistoryInput,
  ) => Effect.Effect<StreamDatabaseViewerHistoryPage, StreamLifecycleError>;
  /**
   * Returns how many viewer counts are stored.
   *
   * @returns The count, or fails with `StreamLifecycleError` when storage fails.
   */
  readonly getViewerSnapshotCount: () => Effect.Effect<NonNegativeInt, StreamLifecycleError>;
  /**
   * Deletes every viewer count and restores the initial offline state in one transaction.
   *
   * @returns The initial state, or fails with `StreamLifecycleError` when storage fails.
   */
  readonly reset: () => Effect.Effect<PersistedStreamState, StreamLifecycleError>;
}

/** Service for Stream Lifecycle persistence; SQL representations stay private to this module. */
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

const decodeComputedIsoTimestamp = Schema.decodeEffect(IsoTimestamp);

const streamError = (
  operation: StreamLifecycleError["operation"],
  reason: StreamLifecycleError["reason"],
) => new StreamLifecycleError({ operation, reason });

/**
 * Classifies SQL and stored-state failures of one Stream Lifecycle database operation.
 *
 * @returns The operation's result, or fails with `StreamLifecycleError` whose reason is
 *   `persistence_unavailable` for SQL failures and `stored_state_invalid` for parse failures.
 */
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

/**
 * Creates Stream Lifecycle persistence over SQLite, importing historical Agent JSON exactly once.
 *
 * **Details**
 *
 * The authoritative representation is decoded before migrations write, so corrupt current or
 * legacy state blocks startup instead of being reset. A legacy viewer poll schedule ID is
 * replaced by its due instant from `cf_agents_schedules`.
 *
 * @returns The database service, or fails with `MigrationError`, `SqlError`, `SchemaError`, or
 *   `StreamLifecycleError` (reason `stored_state_invalid`) when adoption cannot proceed.
 */
export const makeStreamDatabase: Effect.Effect<
  StreamDatabase["Service"],
  SqliteMigrator.MigrationError | SqlError.SqlError | Schema.SchemaError | StreamLifecycleError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const migrateLegacyViewerSchedule = Effect.fn("StreamDatabase.migrateLegacyViewerSchedule")(
    function* (state: PersistedStreamState) {
      if (!Predicate.isTagged("LiveStream")(state) || Option.isNone(state.viewerPollScheduleId))
        return state;
      const scheduleId = state.viewerPollScheduleId.value;

      const scheduleTable = yield* sql`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_agents_schedules'
    `.pipe(Effect.flatMap(parseCountRows));

      if ((scheduleTable[0]?.count ?? 0) === 0) {
        return yield* streamError("migrateLegacyState", "stored_state_invalid");
      }

      const schedules = yield* sql`
      SELECT callback, type, time FROM cf_agents_schedules WHERE id = ${scheduleId}
    `.pipe(Effect.flatMap(parseLegacyViewerScheduleRows));

      const schedule = schedules[0];

      if (schedule === undefined)
        return yield* streamError("migrateLegacyState", "stored_state_invalid");

      const dueAt = yield* decodeComputedIsoTimestamp(
        new Date(schedule.time * 1_000).toISOString(),
      );

      return {
        ...state,
        viewerPollScheduleId: Option.some(dueAt),
        transitionCheckpoint: Option.map(state.transitionCheckpoint, (checkpoint) =>
          Option.contains(checkpoint.viewerPollScheduleId, scheduleId)
            ? { ...checkpoint, viewerPollScheduleId: Option.some(dueAt) }
            : checkpoint,
        ),
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
      "saveState",
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

/** Layer that provides Stream Lifecycle persistence, leaving the SQL client visible. */
export const streamDatabaseLayerWithoutDependencies = Layer.effect(
  StreamDatabase,
  makeStreamDatabase,
);

/** Layer that provides Stream Lifecycle persistence; the SQL client is the Durable Object's runtime binding. */
export const streamDatabaseLayer = streamDatabaseLayerWithoutDependencies;

/** Creates in-memory Stream Lifecycle persistence that follows the SQL implementation's semantics. */
const makeStreamDatabaseTest = Effect.gen(function* () {
  const state = yield* Ref.make(initialStreamState());
  // Keyed by the exact timestamp text, like the SQL primary key; ordering compares text too.
  const snapshots = yield* Ref.make<ReadonlyMap<IsoTimestamp, NonNegativeInt>>(new Map());

  return StreamDatabase.of({
    getState: () => Ref.get(state),
    saveState: (next) => Ref.set(state, next),
    recordViewerCount: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(
          snapshots,
          (current) => new Map([...current, [input.recordedAt, input.count]]),
        );

        if (input.count <= input.state.peakViewerCount) return input.state;
        const next = { ...input.state, peakViewerCount: input.count };
        yield* Ref.set(state, next);

        return next;
      }),
    getViewerHistory: (input) =>
      Ref.get(snapshots).pipe(
        Effect.map((current) => {
          const since = Option.getOrElse(input.since, () => "0000-01-01T00:00:00.000Z");
          const until = Option.getOrElse(input.until, () => "9999-12-31T23:59:59.999Z");

          const matching = [...current]
            .filter(([timestamp]) => timestamp >= since && timestamp <= until)
            .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

          return {
            snapshots: matching
              .slice(input.offset, input.offset + input.limit)
              .map(([timestamp, viewerCount]) => ({ timestamp, viewerCount })),
            totalCount: matching.length,
          };
        }),
      ),
    getViewerSnapshotCount: () => Ref.get(snapshots).pipe(Effect.map((current) => current.size)),
    reset: () =>
      Effect.gen(function* () {
        const initial = initialStreamState();
        yield* Ref.set(snapshots, new Map());
        yield* Ref.set(state, initial);

        return initial;
      }),
  });
});

/**
 * Layer that provides in-memory Stream Lifecycle persistence, starting from the initial state.
 *
 * **Details**
 *
 * Historical Agent adoption and storage failures are SQL-only; the database contract tests run the
 * remaining behavior against both implementations.
 */
export const streamDatabaseTestLayer = Layer.effect(StreamDatabase, makeStreamDatabaseTest);
