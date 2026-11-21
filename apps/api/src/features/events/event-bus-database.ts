import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import {
  DomainEventType,
  EventBusError,
  EventBusSubscriber,
  EventBusSubscriptionId,
  type EventBusOperation,
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

const TimestampRow = Schema.Struct({ timestamp: Schema.OptionFromNullOr(IsoTimestamp) });

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

/** Page of persistence rows with the total row count for pagination. */
export interface EventBusRowPage<Row> {
  /** Rows in the requested window. */
  readonly rows: ReadonlyArray<Row>;
  /** Total rows across every page. */
  readonly totalCount: number;
}

/**
 * Persistence operations that preserve Event Bus terminal-state transactions.
 *
 * Every operation fails with `EventBusError`: `persistence_unavailable` when storage fails and
 * `stored_row_invalid` when a stored row does not match its schema.
 */
export interface IEventBusDatabase {
  /**
   * Accepts a producer event once, in one transaction.
   *
   * @returns `accepted` after storing a new pending row; `already_delivered` after removing stale
   * pending or dead-letter copies of a delivered event; `already_pending` or `dead_lettered` when the
   * event is already stored. Fails with `EventBusError` when storage is unavailable.
   */
  readonly accept: (input: {
    readonly eventId: EventId;
    readonly encodedEvent: string;
    readonly now: IsoTimestamp;
    readonly firstRetryAt: IsoTimestamp;
  }) => Effect.Effect<EventAcceptance, EventBusError>;
  /**
   * Returns pending rows due at or before `now`, oldest due first.
   *
   * @returns Pending rows due at or before `now`, oldest due first, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly listDue: (
    now: IsoTimestamp,
  ) => Effect.Effect<ReadonlyArray<PendingEventRow>, EventBusError>;
  /**
   * Returns one pending row, or `Option.none()` when the event is not pending.
   *
   * @returns One pending row, or `Option.none()` when the event is not pending, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly findPending: (
    eventId: EventId,
  ) => Effect.Effect<Option.Option<PendingEventRow>, EventBusError>;
  /**
   * Sets a pending row's attempt count and next retry time.
   *
   * @returns Nothing on success, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly reschedule: (input: {
    readonly eventId: EventId;
    readonly attempts: NonNegativeInt;
    readonly nextRetryAt: IsoTimestamp;
  }) => Effect.Effect<void, EventBusError>;
  /**
   * Records a delivery receipt and removes pending and dead-letter copies in one transaction.
   *
   * @returns Nothing on success, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly recordDelivered: (input: {
    readonly eventId: EventId;
    readonly deliveredAt: IsoTimestamp;
  }) => Effect.Effect<void, EventBusError>;
  /**
   * Moves a pending row to the dead-letter queue in one transaction, keeping its original creation time.
   *
   * @returns Nothing on success, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly moveToDeadLetter: (input: {
    readonly pending: PendingEventRow;
    readonly error: string;
    readonly attempts: PositiveInt;
    readonly failedAt: IsoTimestamp;
    readonly expiresAt: IsoTimestamp;
  }) => Effect.Effect<void, EventBusError>;
  /**
   * Returns a page of pending rows, newest first.
   *
   * @returns A page of pending rows, newest first, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly listPending: (
    input: EventBusPageInput,
  ) => Effect.Effect<EventBusRowPage<PendingEventRow>, EventBusError>;
  /**
   * Returns a page of dead-letter rows, most recently failed first.
   *
   * @returns A page of dead-letter rows, most recently failed first, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly listDeadLetters: (
    input: EventBusPageInput,
  ) => Effect.Effect<EventBusRowPage<DeadLetterRow>, EventBusError>;
  /**
   * Returns one dead-letter row, or `Option.none()` when the event is not dead-lettered.
   *
   * @returns One dead-letter row, or `Option.none()` when the event is not dead-lettered, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly findDeadLetter: (
    eventId: EventId,
  ) => Effect.Effect<Option.Option<DeadLetterRow>, EventBusError>;
  /**
   * Records a failed manual replay on a dead-letter row.
   *
   * @returns Nothing on success, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly recordDeadLetterReplayFailure: (input: {
    readonly eventId: EventId;
    readonly error: string;
    readonly failedAt: IsoTimestamp;
  }) => Effect.Effect<void, EventBusError>;
  /**
   * Deletes one dead-letter row and returns whether it existed.
   *
   * @returns Whether the row existed, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly deleteDeadLetter: (eventId: EventId) => Effect.Effect<boolean, EventBusError>;
  /**
   * Deletes dead-letter rows expiring at or before `now` and returns how many were deleted.
   *
   * @returns The number of deleted rows, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly purgeExpiredDeadLetters: (now: IsoTimestamp) => Effect.Effect<number, EventBusError>;
  /**
   * Returns pending, dead-letter, delivered, and subscription row counts.
   *
   * @returns Pending, dead-letter, delivered, and subscription row counts, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly counts: () => Effect.Effect<
    {
      readonly pendingCount: number;
      readonly deadLetterCount: number;
      readonly deliveredCount: number;
      readonly subscriptionCount: number;
    },
    EventBusError
  >;
  /**
   * Returns the earliest retry or dead-letter expiry time, or `Option.none()` when nothing is scheduled.
   *
   * @returns The earliest retry or dead-letter expiry time, or `Option.none()` when nothing is scheduled, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly earliestWakeAt: () => Effect.Effect<Option.Option<IsoTimestamp>, EventBusError>;
  /**
   * Returns the earliest pending retry time, or `Option.none()` when nothing is pending.
   *
   * @returns The earliest pending retry time, or `Option.none()` when nothing is pending, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly earliestRetryAt: () => Effect.Effect<Option.Option<IsoTimestamp>, EventBusError>;
  /**
   * Returns the earliest dead-letter expiry time, or `Option.none()` when the queue is empty.
   *
   * @returns The earliest dead-letter expiry time, or `Option.none()` when the queue is empty, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly earliestDeadLetterExpiryAt: () => Effect.Effect<
    Option.Option<IsoTimestamp>,
    EventBusError
  >;
  /**
   * Returns every subscription row, ordered by subscriber and event type.
   *
   * @returns Every subscription row, ordered by subscriber and event type, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly listSubscriptions: () => Effect.Effect<ReadonlyArray<SubscriptionRow>, EventBusError>;
  /**
   * Adds missing subscriptions for a subscriber and returns all of its rows, ordered by event type.
   *
   * @returns The subscriber's rows, ordered by event type, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly registerSubscriptions: (input: {
    readonly subscriber: EventBusSubscriber;
    readonly eventTypes: ReadonlyArray<DomainEventType>;
    readonly createdAt: IsoTimestamp;
  }) => Effect.Effect<ReadonlyArray<SubscriptionRow>, EventBusError>;
  /**
   * Deletes one subscription row and returns whether it existed.
   *
   * @returns Whether the row existed, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly unregisterSubscription: (
    id: EventBusSubscriptionId,
  ) => Effect.Effect<boolean, EventBusError>;
  /**
   * Deletes pending, dead-letter, and delivered rows in one transaction; subscriptions remain.
   *
   * @returns Nothing on success, or fails with `EventBusError` reason `persistence_unavailable` when storage fails or `stored_row_invalid` when a stored row does not match its schema.
   */
  readonly reset: () => Effect.Effect<void, EventBusError>;
}

/** Service for Event Bus persistence; SQL records stay private to the events feature. */
export class EventBusDatabase extends Context.Service<EventBusDatabase, IEventBusDatabase>()(
  "@cf-twitch/EventBusDatabase",
) {}

// Achievements subscribe to every domain event type from the first migration onward.
const defaultAchievementEventTypes = DomainEventType.literals;

const defaultSubscriptionCreatedAt = IsoTimestamp.make("1970-01-01T00:00:00.000Z");

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

  for (const eventType of defaultAchievementEventTypes) {
    yield* sql`
      INSERT OR IGNORE INTO event_subscriptions (id, subscriber, event_type, created_at)
      VALUES (${`achievements:${eventType}`}, 'achievements', ${eventType}, ${defaultSubscriptionCreatedAt})
    `;
  }
});

const migrationLoader = SqliteMigrator.fromRecord({
  "1_preserve_event_bus_authority": initialMigration,
});

const decodeLegacyAgentState = Schema.decodeEffect(Schema.fromJsonString(LegacyEventBusAgentState));

const parseLegacyStateRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ state: Schema.String })),
);

const parsePendingRows = Schema.decodeUnknownEffect(Schema.Array(PendingEventRow));

const parseDeadLetterRows = Schema.decodeUnknownEffect(Schema.Array(DeadLetterRow));

const parseSubscriptionRows = Schema.decodeUnknownEffect(Schema.Array(SubscriptionRow));

const parseCountRows = Schema.decodeUnknownEffect(Schema.Array(CountRow));

const parseTimestampRows = Schema.decodeUnknownEffect(Schema.Array(TimestampRow));

// Database failures carry the business operation and the event the failing statement concerned.
const withDatabaseErrors = <A>(
  operation: EventBusOperation,
  effect: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError | EventBusError>,
  eventId: Option.Option<EventId> = Option.none(),
): Effect.Effect<A, EventBusError> =>
  effect.pipe(
    Effect.catchTags({
      EventBusError: (error) => Effect.fail(error),
      SchemaError: () =>
        Effect.fail(new EventBusError({ operation, reason: "stored_row_invalid", eventId })),
      SqlError: () =>
        Effect.fail(new EventBusError({ operation, reason: "persistence_unavailable", eventId })),
    }),
  );

/**
 * Creates SQLite Event Bus persistence after validating legacy Agent state and running migrations.
 *
 * **Details**
 *
 * The legacy `cf_agents_state` row is validated before any migration writes; a missing table is
 * distinguished from a storage failure, which is never treated as empty state. Must run only in
 * the Durable Object runtime phase.
 *
 * @returns The database service, or fails with `SchemaError` when legacy Agent state is invalid,
 * and `SqlError` or `MigrationError` when storage or migration fails.
 */
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
    const legacyRows = yield* sql`
      SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id' LIMIT 1
    `.pipe(Effect.flatMap(parseLegacyStateRows));

    if (legacyRows[0] !== undefined) yield* decodeLegacyAgentState(legacyRows[0].state);
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
      Option.some(input.eventId),
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
      Option.some(eventId),
    );

  const reschedule: IEventBusDatabase["reschedule"] = (input) =>
    withDatabaseErrors(
      "retryDue",
      sql`UPDATE pending_events SET attempts = ${input.attempts}, next_retry_at = ${input.nextRetryAt} WHERE id = ${input.eventId}`.pipe(
        Effect.asVoid,
      ),
      Option.some(input.eventId),
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
      Option.some(input.eventId),
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
      Option.some(input.pending.id),
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
      Option.some(eventId),
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
      Option.some(input.eventId),
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
      Option.some(eventId),
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
        Effect.map((rows) => Option.flatMap(Option.fromNullishOr(rows[0]), (row) => row.timestamp)),
      ),
    );

  const earliestRetryAt: IEventBusDatabase["earliestRetryAt"] = () =>
    withDatabaseErrors(
      "getStatus",
      sql`SELECT MIN(next_retry_at) AS timestamp FROM pending_events`.pipe(
        Effect.flatMap(parseTimestampRows),
        Effect.map((rows) => Option.flatMap(Option.fromNullishOr(rows[0]), (row) => row.timestamp)),
      ),
    );

  const earliestDeadLetterExpiryAt: IEventBusDatabase["earliestDeadLetterExpiryAt"] = () =>
    withDatabaseErrors(
      "getStatus",
      sql`SELECT MIN(expires_at) AS timestamp FROM dead_letter_queue`.pipe(
        Effect.flatMap(parseTimestampRows),
        Effect.map((rows) => Option.flatMap(Option.fromNullishOr(rows[0]), (row) => row.timestamp)),
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

/** Layer that provides SQLite Event Bus persistence and keeps its Durable Object SQL client requirement visible. */
export const eventBusDatabaseLayerWithoutDependencies = Layer.effect(
  EventBusDatabase,
  makeEventBusDatabase,
);

/** Production Event Bus persistence Layer; the SQL client is a Durable Object runtime binding supplied by `EventBusServer`. */
export const eventBusDatabaseLayer = eventBusDatabaseLayerWithoutDependencies;

interface InMemoryEventBusRows {
  readonly pending: ReadonlyMap<EventId, PendingEventRow>;
  readonly deadLetters: ReadonlyMap<EventId, DeadLetterRow>;
  readonly delivered: ReadonlyMap<EventId, IsoTimestamp>;
  readonly subscriptions: ReadonlyMap<EventBusSubscriptionId, SubscriptionRow>;
}

const subscriptionRow = (
  subscriber: EventBusSubscriber,
  eventType: DomainEventType,
  createdAt: IsoTimestamp,
): SubscriptionRow => ({
  id: EventBusSubscriptionId.make(`${subscriber}:${eventType}`),
  subscriber,
  event_type: eventType,
  created_at: createdAt,
});

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> =>
  new Map(map).set(key, value);

const withoutEntry = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map);
  next.delete(key);

  return next;
};

const earliest = (timestamps: ReadonlyArray<IsoTimestamp>): Option.Option<IsoTimestamp> =>
  Option.fromNullishOr([...timestamps].sort()[0]);

const pageOf = <Row>(rows: ReadonlyArray<Row>, input: EventBusPageInput): EventBusRowPage<Row> => ({
  rows: rows.slice(input.offset, input.offset + input.limit),
  totalCount: rows.length,
});

// SQLite orders TEXT with binary collation, so compare code units rather than locale order.
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const byText =
  <Row>(key: (row: Row) => string, direction: "ascending" | "descending") =>
  (left: Row, right: Row): number =>
    direction === "ascending"
      ? compareText(key(left), key(right))
      : compareText(key(right), key(left));

/**
 * Layer that provides in-memory Event Bus persistence with the same transactions, ordering, and
 * default Achievement subscriptions as the SQLite tables.
 *
 * **Details**
 *
 * Each operation applies atomically to one immutable snapshot, matching the SQLite transactions.
 * Timestamps compare as ISO text, as SQLite compares them.
 */
export const eventBusDatabaseTestLayer = Layer.effect(
  EventBusDatabase,
  Effect.gen(function* () {
    const rows = yield* Ref.make<InMemoryEventBusRows>({
      pending: new Map(),
      deadLetters: new Map(),
      delivered: new Map(),
      subscriptions: new Map(
        defaultAchievementEventTypes.map((eventType) => {
          const row = subscriptionRow("achievements", eventType, defaultSubscriptionCreatedAt);

          return [row.id, row];
        }),
      ),
    });

    const read = <A>(project: (state: InMemoryEventBusRows) => A) =>
      Ref.get(rows).pipe(Effect.map(project));

    return EventBusDatabase.of({
      accept: (input) =>
        Ref.modify(rows, (state): [EventAcceptance, InMemoryEventBusRows] => {
          if (state.delivered.has(input.eventId))
            return [
              "already_delivered",
              {
                ...state,
                pending: withoutEntry(state.pending, input.eventId),
                deadLetters: withoutEntry(state.deadLetters, input.eventId),
              },
            ];

          if (state.pending.has(input.eventId)) return ["already_pending", state];

          if (state.deadLetters.has(input.eventId)) return ["dead_lettered", state];

          return [
            "accepted",
            {
              ...state,
              pending: withEntry(state.pending, input.eventId, {
                id: input.eventId,
                event: input.encodedEvent,
                attempts: 0,
                next_retry_at: input.firstRetryAt,
                created_at: input.now,
              }),
            },
          ];
        }),
      listDue: (now) =>
        read((state) =>
          [...state.pending.values()]
            .filter((row) => row.next_retry_at <= now)
            .sort(byText((row) => `${row.next_retry_at}\u0000${row.id}`, "ascending")),
        ),
      findPending: (eventId) => read((state) => Option.fromNullishOr(state.pending.get(eventId))),
      reschedule: (input) =>
        Ref.update(rows, (state) =>
          Option.match(Option.fromNullishOr(state.pending.get(input.eventId)), {
            onNone: () => state,
            onSome: (row) => ({
              ...state,
              pending: withEntry(state.pending, input.eventId, {
                ...row,
                attempts: input.attempts,
                next_retry_at: input.nextRetryAt,
              }),
            }),
          }),
        ),
      recordDelivered: (input) =>
        Ref.update(rows, (state) => ({
          ...state,
          delivered: state.delivered.has(input.eventId)
            ? state.delivered
            : withEntry(state.delivered, input.eventId, input.deliveredAt),
          pending: withoutEntry(state.pending, input.eventId),
          deadLetters: withoutEntry(state.deadLetters, input.eventId),
        })),
      moveToDeadLetter: (input) =>
        Ref.update(rows, (state) => ({
          ...state,
          deadLetters: withEntry(state.deadLetters, input.pending.id, {
            id: input.pending.id,
            event: input.pending.event,
            error: input.error,
            attempts: input.attempts,
            first_failed_at: input.pending.created_at,
            last_failed_at: input.failedAt,
            expires_at: input.expiresAt,
          }),
          pending: withoutEntry(state.pending, input.pending.id),
        })),
      listPending: (input) =>
        read((state) =>
          pageOf(
            [...state.pending.values()].sort(byText((row) => row.created_at, "descending")),
            input,
          ),
        ),
      listDeadLetters: (input) =>
        read((state) =>
          pageOf(
            [...state.deadLetters.values()].sort(byText((row) => row.last_failed_at, "descending")),
            input,
          ),
        ),
      findDeadLetter: (eventId) =>
        read((state) => Option.fromNullishOr(state.deadLetters.get(eventId))),
      recordDeadLetterReplayFailure: (input) =>
        Ref.update(rows, (state) =>
          Option.match(Option.fromNullishOr(state.deadLetters.get(input.eventId)), {
            onNone: () => state,
            onSome: (row) => ({
              ...state,
              deadLetters: withEntry(state.deadLetters, input.eventId, {
                ...row,
                error: input.error,
                last_failed_at: input.failedAt,
              }),
            }),
          }),
        ),
      deleteDeadLetter: (eventId) =>
        Ref.modify(rows, (state): [boolean, InMemoryEventBusRows] => [
          state.deadLetters.has(eventId),
          { ...state, deadLetters: withoutEntry(state.deadLetters, eventId) },
        ]),
      purgeExpiredDeadLetters: (now) =>
        Ref.modify(rows, (state): [number, InMemoryEventBusRows] => {
          const kept = [...state.deadLetters].filter(([, row]) => row.expires_at > now);

          return [state.deadLetters.size - kept.length, { ...state, deadLetters: new Map(kept) }];
        }),
      counts: () =>
        read((state) => ({
          pendingCount: state.pending.size,
          deadLetterCount: state.deadLetters.size,
          deliveredCount: state.delivered.size,
          subscriptionCount: state.subscriptions.size,
        })),
      earliestWakeAt: () =>
        read((state) =>
          earliest([
            ...[...state.pending.values()].map((row) => row.next_retry_at),
            ...[...state.deadLetters.values()].map((row) => row.expires_at),
          ]),
        ),
      earliestRetryAt: () =>
        read((state) => earliest([...state.pending.values()].map((row) => row.next_retry_at))),
      earliestDeadLetterExpiryAt: () =>
        read((state) => earliest([...state.deadLetters.values()].map((row) => row.expires_at))),
      listSubscriptions: () =>
        read((state) =>
          [...state.subscriptions.values()].sort(
            byText((row) => `${row.subscriber}\u0000${row.event_type}`, "ascending"),
          ),
        ),
      registerSubscriptions: (input) =>
        Ref.modify(rows, (state): [ReadonlyArray<SubscriptionRow>, InMemoryEventBusRows] => {
          const subscriptions = new Map(state.subscriptions);

          for (const eventType of input.eventTypes) {
            const row = subscriptionRow(input.subscriber, eventType, input.createdAt);

            if (!subscriptions.has(row.id)) subscriptions.set(row.id, row);
          }

          return [
            [...subscriptions.values()]
              .filter((row) => row.subscriber === input.subscriber)
              .sort(byText((row) => row.event_type, "ascending")),
            { ...state, subscriptions },
          ];
        }),
      unregisterSubscription: (id) =>
        Ref.modify(rows, (state): [boolean, InMemoryEventBusRows] => [
          state.subscriptions.has(id),
          { ...state, subscriptions: withoutEntry(state.subscriptions, id) },
        ]),
      reset: () =>
        Ref.update(rows, (state) => ({
          ...state,
          pending: new Map(),
          deadLetters: new Map(),
          delivered: new Map(),
        })),
    });
  }),
);
