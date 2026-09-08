import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import {
  DomainEventType,
  EventBusError,
  EventBusSubscriber,
  EventBusSubscriptionId,
  type EventBusPageInput,
} from "@cf-twitch/contracts/event-bus";
import { EventId, IsoTimestamp, NonNegativeInt, PositiveInt } from "@cf-twitch/contracts/identity";

const PendingEventRow = Schema.Struct({
  id: EventId,
  event: Schema.String,
  attempts: NonNegativeInt,
  next_retry_at: IsoTimestamp,
  created_at: IsoTimestamp,
});

const DeadLetterRow = Schema.Struct({
  id: EventId,
  event: Schema.String,
  error: Schema.String,
  attempts: PositiveInt,
  first_failed_at: IsoTimestamp,
  last_failed_at: IsoTimestamp,
  expires_at: IsoTimestamp,
});

const SubscriptionRow = Schema.Struct({
  id: EventBusSubscriptionId,
  subscriber: EventBusSubscriber,
  event_type: DomainEventType,
  created_at: IsoTimestamp,
});

const CountRow = Schema.Struct({ count: NonNegativeInt });
const TimestampRow = Schema.Struct({ timestamp: Schema.NullOr(IsoTimestamp) });
const LegacyEventBusAgentState = Schema.Struct({
  retrySweepScheduleId: Schema.NullOr(Schema.String),
  retrySweepDueAt: Schema.NullOr(IsoTimestamp),
  dlqPurgeScheduleId: Schema.NullOr(Schema.String),
  dlqPurgeDueAt: Schema.NullOr(IsoTimestamp),
});

/** Parsed private pending-delivery persistence row. */
export type PendingEventRow = typeof PendingEventRow.Type;
type EncodedPendingEventRow = typeof PendingEventRow.Encoded;

/** Parsed private dead-letter persistence row. */
export type DeadLetterRow = typeof DeadLetterRow.Type;
type EncodedDeadLetterRow = typeof DeadLetterRow.Encoded;

/** Parsed private Event Bus subscription row. */
export type SubscriptionRow = typeof SubscriptionRow.Type;
type EncodedSubscriptionRow = typeof SubscriptionRow.Encoded;

/** Result of transactionally accepting a producer event identity. */
export type EventAcceptance =
  | "accepted"
  | "already_pending"
  | "already_delivered"
  | "dead_lettered";

/** Persistence operations that preserve Event Bus terminal-state transactions. */
export interface IEventBusDatabase {
  readonly accept: (input: {
    readonly eventId: EventId;
    readonly encodedEvent: string;
    readonly now: IsoTimestamp;
    readonly firstRetryAt: IsoTimestamp;
  }) => Effect.Effect<EventAcceptance, EventBusError>;
  readonly listDue: (
    now: IsoTimestamp,
  ) => Effect.Effect<ReadonlyArray<PendingEventRow>, EventBusError>;
  readonly findPending: (
    eventId: EventId,
  ) => Effect.Effect<Option.Option<PendingEventRow>, EventBusError>;
  readonly reschedule: (input: {
    readonly eventId: EventId;
    readonly attempts: NonNegativeInt;
    readonly nextRetryAt: IsoTimestamp;
  }) => Effect.Effect<void, EventBusError>;
  readonly recordDelivered: (input: {
    readonly eventId: EventId;
    readonly deliveredAt: IsoTimestamp;
  }) => Effect.Effect<void, EventBusError>;
  readonly moveToDeadLetter: (input: {
    readonly pending: PendingEventRow;
    readonly error: string;
    readonly attempts: PositiveInt;
    readonly failedAt: IsoTimestamp;
    readonly expiresAt: IsoTimestamp;
  }) => Effect.Effect<void, EventBusError>;
  readonly listPending: (input: EventBusPageInput) => Effect.Effect<
    {
      readonly rows: ReadonlyArray<PendingEventRow>;
      readonly totalCount: number;
    },
    EventBusError
  >;
  readonly listDeadLetters: (input: EventBusPageInput) => Effect.Effect<
    {
      readonly rows: ReadonlyArray<DeadLetterRow>;
      readonly totalCount: number;
    },
    EventBusError
  >;
  readonly findDeadLetter: (
    eventId: EventId,
  ) => Effect.Effect<Option.Option<DeadLetterRow>, EventBusError>;
  readonly recordDeadLetterReplayFailure: (input: {
    readonly eventId: EventId;
    readonly error: string;
    readonly failedAt: IsoTimestamp;
  }) => Effect.Effect<void, EventBusError>;
  readonly deleteDeadLetter: (eventId: EventId) => Effect.Effect<boolean, EventBusError>;
  readonly purgeExpiredDeadLetters: (now: IsoTimestamp) => Effect.Effect<number, EventBusError>;
  readonly counts: () => Effect.Effect<
    {
      readonly pendingCount: number;
      readonly deadLetterCount: number;
      readonly deliveredCount: number;
      readonly subscriptionCount: number;
    },
    EventBusError
  >;
  readonly earliestWakeAt: () => Effect.Effect<Option.Option<IsoTimestamp>, EventBusError>;
  readonly earliestRetryAt: () => Effect.Effect<Option.Option<IsoTimestamp>, EventBusError>;
  readonly earliestDeadLetterExpiryAt: () => Effect.Effect<
    Option.Option<IsoTimestamp>,
    EventBusError
  >;
  readonly listSubscriptions: () => Effect.Effect<ReadonlyArray<SubscriptionRow>, EventBusError>;
  readonly registerSubscriptions: (input: {
    readonly subscriber: EventBusSubscriber;
    readonly eventTypes: ReadonlyArray<DomainEventType>;
    readonly createdAt: IsoTimestamp;
  }) => Effect.Effect<ReadonlyArray<SubscriptionRow>, EventBusError>;
  readonly unregisterSubscription: (
    id: EventBusSubscriptionId,
  ) => Effect.Effect<boolean, EventBusError>;
  readonly reset: () => Effect.Effect<void, EventBusError>;
}

/** Parsed Event Bus persistence with SQL records kept private to the feature. */
export class EventBusDatabase extends Context.Service<EventBusDatabase, IEventBusDatabase>()(
  "@cf-twitch/EventBusDatabase",
) {}

const initialMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pending_events (
      id TEXT PRIMARY KEY NOT NULL,
      event TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pending_next_retry ON pending_events(next_retry_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS dead_letter_queue (
      id TEXT PRIMARY KEY NOT NULL,
      event TEXT NOT NULL,
      error TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      first_failed_at TEXT NOT NULL,
      last_failed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_dlq_expires_at ON dead_letter_queue(expires_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS delivered_events (
      id TEXT PRIMARY KEY NOT NULL,
      delivered_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS event_subscriptions (
      id TEXT PRIMARY KEY NOT NULL,
      subscriber TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(subscriber, event_type)
    )
  `;
  for (const eventType of [
    "song_request_success",
    "raffle_roll",
    "stream_online",
    "stream_offline",
  ] as const) {
    yield* sql`
      INSERT OR IGNORE INTO event_subscriptions (id, subscriber, event_type, created_at)
      VALUES (${`achievements:${eventType}`}, 'achievements', ${eventType}, '1970-01-01T00:00:00.000Z')
    `;
  }
});

const migrationLoader = SqliteMigrator.fromRecord({
  "1_preserve_event_bus_authority": initialMigration,
});

const parsePendingRows = Schema.decodeUnknownEffect(Schema.Array(PendingEventRow));
const parseDeadLetterRows = Schema.decodeUnknownEffect(Schema.Array(DeadLetterRow));
const parseSubscriptionRows = Schema.decodeUnknownEffect(Schema.Array(SubscriptionRow));
const parseCountRows = Schema.decodeUnknownEffect(Schema.Array(CountRow));
const parseTimestampRows = Schema.decodeUnknownEffect(Schema.Array(TimestampRow));

const operationError = (
  operation: EventBusError["operation"],
  reason: EventBusError["reason"] = "persistence_unavailable",
  eventId: Option.Option<EventId> = Option.none(),
) => new EventBusError({ operation, reason, eventId });

const withDatabaseErrors = <A>(
  operation: EventBusError["operation"],
  effect: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError | EventBusError>,
): Effect.Effect<A, EventBusError> =>
  effect.pipe(
    Effect.catchTags({
      EventBusError: (error) => Effect.fail(error),
      SchemaError: () => Effect.fail(operationError(operation, "stored_event_invalid")),
      SqlError: () => Effect.fail(operationError(operation)),
    }),
  );

/** Construct Event Bus persistence after compatibility migrations and Agent-state validation. */
export const makeEventBusDatabase: Effect.Effect<
  EventBusDatabase["Service"],
  SqliteMigrator.MigrationError | SqlError.SqlError | Schema.SchemaError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Validate historical Agent state before migrations write anything. A missing table is
  // distinguishable from a storage failure, which must never be treated as empty state.
  const legacyTable = yield* sql`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'cf_agents_state'
  `.pipe(Effect.flatMap(parseCountRows));
  if ((legacyTable[0]?.count ?? 0) > 0) {
    const legacyRows = yield* sql<{ readonly state: string }>`
      SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id' LIMIT 1
    `;
    if (legacyRows[0] !== undefined) {
      yield* Schema.decodeEffect(Schema.fromJsonString(LegacyEventBusAgentState))(
        legacyRows[0].state,
      );
    }
  }

  yield* SqliteMigrator.run({ loader: migrationLoader, table: "event_bus_schema_migrations" });

  const accept: IEventBusDatabase["accept"] = (input) =>
    withDatabaseErrors(
      "publish",
      sql.withTransaction(
        Effect.gen(function* () {
          const delivered = yield* parseCountRows(
            yield* sql`SELECT COUNT(*) AS count FROM delivered_events WHERE id = ${input.eventId}`,
          );
          if ((delivered[0]?.count ?? 0) > 0) {
            yield* sql`DELETE FROM pending_events WHERE id = ${input.eventId}`;
            yield* sql`DELETE FROM dead_letter_queue WHERE id = ${input.eventId}`;
            return "already_delivered" as const;
          }
          const pending = yield* parseCountRows(
            yield* sql`SELECT COUNT(*) AS count FROM pending_events WHERE id = ${input.eventId}`,
          );
          if ((pending[0]?.count ?? 0) > 0) return "already_pending" as const;
          const dead = yield* parseCountRows(
            yield* sql`SELECT COUNT(*) AS count FROM dead_letter_queue WHERE id = ${input.eventId}`,
          );
          if ((dead[0]?.count ?? 0) > 0) return "dead_lettered" as const;
          yield* sql`
            INSERT INTO pending_events (id, event, attempts, next_retry_at, created_at)
            VALUES (${input.eventId}, ${input.encodedEvent}, 0, ${input.firstRetryAt}, ${input.now})
          `;
          return "accepted" as const;
        }),
      ),
    );

  const listDue: IEventBusDatabase["listDue"] = (now) =>
    withDatabaseErrors(
      "retryDue",
      sql<EncodedPendingEventRow>`
        SELECT id, event, attempts, next_retry_at, created_at
        FROM pending_events WHERE next_retry_at <= ${now} ORDER BY next_retry_at, id
      `.pipe(Effect.flatMap(parsePendingRows)),
    );

  const findPending: IEventBusDatabase["findPending"] = (eventId) =>
    withDatabaseErrors(
      "retryPending",
      sql<EncodedPendingEventRow>`
        SELECT id, event, attempts, next_retry_at, created_at FROM pending_events WHERE id = ${eventId} LIMIT 1
      `.pipe(
        Effect.flatMap(parsePendingRows),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
      ),
    );

  const reschedule: IEventBusDatabase["reschedule"] = (input) =>
    withDatabaseErrors(
      "retryDue",
      sql`UPDATE pending_events SET attempts = ${input.attempts}, next_retry_at = ${input.nextRetryAt} WHERE id = ${input.eventId}`.pipe(
        Effect.asVoid,
      ),
    );

  const recordDelivered: IEventBusDatabase["recordDelivered"] = (input) =>
    withDatabaseErrors(
      "retryDue",
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT OR IGNORE INTO delivered_events (id, delivered_at) VALUES (${input.eventId}, ${input.deliveredAt})`;
          yield* sql`DELETE FROM pending_events WHERE id = ${input.eventId}`;
          yield* sql`DELETE FROM dead_letter_queue WHERE id = ${input.eventId}`;
        }),
      ),
    );

  const moveToDeadLetter: IEventBusDatabase["moveToDeadLetter"] = (input) =>
    withDatabaseErrors(
      "retryDue",
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT OR REPLACE INTO dead_letter_queue
              (id, event, error, attempts, first_failed_at, last_failed_at, expires_at)
            VALUES (${input.pending.id}, ${input.pending.event}, ${input.error}, ${input.attempts},
              ${input.pending.created_at}, ${input.failedAt}, ${input.expiresAt})
          `;
          yield* sql`DELETE FROM pending_events WHERE id = ${input.pending.id}`;
        }),
      ),
    );

  const listPending: IEventBusDatabase["listPending"] = (input) =>
    withDatabaseErrors(
      "listPending",
      Effect.gen(function* () {
        const rows = yield* sql<EncodedPendingEventRow>`
          SELECT id, event, attempts, next_retry_at, created_at FROM pending_events
          ORDER BY created_at DESC LIMIT ${input.limit} OFFSET ${input.offset}
        `.pipe(Effect.flatMap(parsePendingRows));
        const counts = yield* sql`SELECT COUNT(*) AS count FROM pending_events`.pipe(
          Effect.flatMap(parseCountRows),
        );
        return { rows, totalCount: counts[0]?.count ?? 0 };
      }),
    );

  const listDeadLetters: IEventBusDatabase["listDeadLetters"] = (input) =>
    withDatabaseErrors(
      "listDeadLetters",
      Effect.gen(function* () {
        const rows = yield* sql<EncodedDeadLetterRow>`
          SELECT id, event, error, attempts, first_failed_at, last_failed_at, expires_at
          FROM dead_letter_queue ORDER BY last_failed_at DESC LIMIT ${input.limit} OFFSET ${input.offset}
        `.pipe(Effect.flatMap(parseDeadLetterRows));
        const counts = yield* sql`SELECT COUNT(*) AS count FROM dead_letter_queue`.pipe(
          Effect.flatMap(parseCountRows),
        );
        return { rows, totalCount: counts[0]?.count ?? 0 };
      }),
    );

  const findDeadLetter: IEventBusDatabase["findDeadLetter"] = (eventId) =>
    withDatabaseErrors(
      "replayDeadLetter",
      sql<EncodedDeadLetterRow>`
        SELECT id, event, error, attempts, first_failed_at, last_failed_at, expires_at
        FROM dead_letter_queue WHERE id = ${eventId} LIMIT 1
      `.pipe(
        Effect.flatMap(parseDeadLetterRows),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
      ),
    );

  const recordDeadLetterReplayFailure: IEventBusDatabase["recordDeadLetterReplayFailure"] = (
    input,
  ) =>
    withDatabaseErrors(
      "replayDeadLetter",
      sql`
        UPDATE dead_letter_queue
        SET error = ${input.error}, last_failed_at = ${input.failedAt}
        WHERE id = ${input.eventId}
      `.pipe(Effect.asVoid),
    );

  const deleteDeadLetter: IEventBusDatabase["deleteDeadLetter"] = (eventId) =>
    withDatabaseErrors(
      "deleteDeadLetter",
      Effect.gen(function* () {
        const before = yield* parseCountRows(
          yield* sql`SELECT COUNT(*) AS count FROM dead_letter_queue WHERE id = ${eventId}`,
        );
        yield* sql`DELETE FROM dead_letter_queue WHERE id = ${eventId}`;
        return (before[0]?.count ?? 0) > 0;
      }),
    );

  const purgeExpiredDeadLetters: IEventBusDatabase["purgeExpiredDeadLetters"] = (now) =>
    withDatabaseErrors(
      "purgeExpiredDeadLetters",
      Effect.gen(function* () {
        const before = yield* parseCountRows(
          yield* sql`SELECT COUNT(*) AS count FROM dead_letter_queue WHERE expires_at <= ${now}`,
        );
        yield* sql`DELETE FROM dead_letter_queue WHERE expires_at <= ${now}`;
        return before[0]?.count ?? 0;
      }),
    );

  const counts: IEventBusDatabase["counts"] = () =>
    withDatabaseErrors(
      "getStats",
      Effect.gen(function* () {
        const [pending, dead, delivered, subscriptions] = yield* Effect.all([
          sql`SELECT COUNT(*) AS count FROM pending_events`.pipe(Effect.flatMap(parseCountRows)),
          sql`SELECT COUNT(*) AS count FROM dead_letter_queue`.pipe(Effect.flatMap(parseCountRows)),
          sql`SELECT COUNT(*) AS count FROM delivered_events`.pipe(Effect.flatMap(parseCountRows)),
          sql`SELECT COUNT(*) AS count FROM event_subscriptions`.pipe(
            Effect.flatMap(parseCountRows),
          ),
        ]);
        return {
          pendingCount: pending[0]?.count ?? 0,
          deadLetterCount: dead[0]?.count ?? 0,
          deliveredCount: delivered[0]?.count ?? 0,
          subscriptionCount: subscriptions[0]?.count ?? 0,
        };
      }),
    );

  const earliestWakeAt: IEventBusDatabase["earliestWakeAt"] = () =>
    withDatabaseErrors(
      "getStatus",
      sql`
        SELECT MIN(timestamp) AS timestamp FROM (
          SELECT MIN(next_retry_at) AS timestamp FROM pending_events
          UNION ALL SELECT MIN(expires_at) AS timestamp FROM dead_letter_queue
        )
      `.pipe(
        Effect.flatMap(parseTimestampRows),
        Effect.map((rows) => Option.fromNullOr(rows[0]?.timestamp ?? null)),
      ),
    );

  const earliestRetryAt: IEventBusDatabase["earliestRetryAt"] = () =>
    withDatabaseErrors(
      "getStatus",
      sql`SELECT MIN(next_retry_at) AS timestamp FROM pending_events`.pipe(
        Effect.flatMap(parseTimestampRows),
        Effect.map((rows) => Option.fromNullOr(rows[0]?.timestamp ?? null)),
      ),
    );

  const earliestDeadLetterExpiryAt: IEventBusDatabase["earliestDeadLetterExpiryAt"] = () =>
    withDatabaseErrors(
      "getStatus",
      sql`SELECT MIN(expires_at) AS timestamp FROM dead_letter_queue`.pipe(
        Effect.flatMap(parseTimestampRows),
        Effect.map((rows) => Option.fromNullOr(rows[0]?.timestamp ?? null)),
      ),
    );

  const listSubscriptions: IEventBusDatabase["listSubscriptions"] = () =>
    withDatabaseErrors(
      "listSubscriptions",
      sql<EncodedSubscriptionRow>`
        SELECT id, subscriber, event_type, created_at FROM event_subscriptions ORDER BY subscriber, event_type
      `.pipe(Effect.flatMap(parseSubscriptionRows)),
    );

  const registerSubscriptions: IEventBusDatabase["registerSubscriptions"] = (input) =>
    withDatabaseErrors(
      "registerSubscription",
      sql.withTransaction(
        Effect.gen(function* () {
          for (const eventType of input.eventTypes) {
            yield* sql`
              INSERT OR IGNORE INTO event_subscriptions (id, subscriber, event_type, created_at)
              VALUES (${`${input.subscriber}:${eventType}`}, ${input.subscriber}, ${eventType}, ${input.createdAt})
            `;
          }
          return yield* sql<EncodedSubscriptionRow>`
            SELECT id, subscriber, event_type, created_at FROM event_subscriptions
            WHERE subscriber = ${input.subscriber} ORDER BY event_type
          `.pipe(Effect.flatMap(parseSubscriptionRows));
        }),
      ),
    );

  const unregisterSubscription: IEventBusDatabase["unregisterSubscription"] = (id) =>
    withDatabaseErrors(
      "unregisterSubscription",
      Effect.gen(function* () {
        const before = yield* parseCountRows(
          yield* sql`SELECT COUNT(*) AS count FROM event_subscriptions WHERE id = ${id}`,
        );
        yield* sql`DELETE FROM event_subscriptions WHERE id = ${id}`;
        return (before[0]?.count ?? 0) > 0;
      }),
    );

  const reset: IEventBusDatabase["reset"] = () =>
    withDatabaseErrors(
      "reset",
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM pending_events`;
          yield* sql`DELETE FROM dead_letter_queue`;
          yield* sql`DELETE FROM delivered_events`;
        }),
      ),
    );

  return EventBusDatabase.of({
    accept,
    listDue,
    findPending,
    reschedule,
    recordDelivered,
    moveToDeadLetter,
    listPending,
    listDeadLetters,
    findDeadLetter,
    recordDeadLetterReplayFailure,
    deleteDeadLetter,
    purgeExpiredDeadLetters,
    counts,
    earliestWakeAt,
    earliestRetryAt,
    earliestDeadLetterExpiryAt,
    listSubscriptions,
    registerSubscriptions,
    unregisterSubscription,
    reset,
  });
});

/** Event Bus persistence Layer that keeps its SQL client requirement visible. */
export const eventBusDatabaseLayerWithoutDependencies = Layer.effect(
  EventBusDatabase,
  makeEventBusDatabase,
);
