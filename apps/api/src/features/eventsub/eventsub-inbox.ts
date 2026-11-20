import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-do";
import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { SqlClient, SqlError } from "effect/sql";
import type { SchemaError } from "effect/Schema";
import {
  AcceptedEventSubReceipt,
  EventSubReceiptConflict,
  EventSubReceiptError,
  type EventSubReceiptOperation,
  EventSubReceiptStatus,
} from "@cf-twitch/contracts/eventsub";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import { NonNegativeInt } from "@cf-twitch/contracts/identity";
import { TwitchService } from "../providers/twitch-service.ts";
import {
  WorkflowAlarm,
  WorkflowAlarmError,
  workflowAlarmLayer,
  workflowAlarmTestLayer,
} from "../workflows/workflow-alarm.ts";
import { EventSubChatResponse, EventSubDispatch } from "./eventsub-dispatch.ts";
import { parseEventSubMessage } from "./eventsub-message.ts";

const StoredReceipt = Schema.Struct({
  receipt: AcceptedEventSubReceipt,
  status: EventSubReceiptStatus.fields.status,
  attempts: NonNegativeInt,
  generation: NonNegativeInt,
  startedAt: Schema.Number,
  leaseUntil: Schema.OptionFromNullOr(Schema.Number),
  nextAttemptAt: Schema.Number,
  lastError: Schema.OptionFromNullOr(Schema.String),
  chatResponse: Schema.OptionFromNullOr(EventSubChatResponse),
  chatDelivery: EventSubReceiptStatus.fields.chatCommandDelivery,
});

type StoredReceipt = typeof StoredReceipt.Type;

const parseStoredReceipt = Schema.decodeEffect(Schema.fromJsonString(StoredReceipt));

const encodeStoredReceipt = Schema.encodeEffect(Schema.fromJsonString(StoredReceipt));

const parseRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ receipt_json: Schema.String })),
);

const MAX_EVENTSUB_ATTEMPTS = 20;

const EVENTSUB_LEASE_MS = 60_000;

const migrationLoader = SqliteMigrator.fromRecord({
  "1_eventsub_inbox": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE eventsub_receipts (singleton INTEGER PRIMARY KEY CHECK(singleton=1), message_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL CHECK(generation>=0), receipt_json TEXT NOT NULL)`;
    yield* sql`CREATE TABLE eventsub_metric_claims (identity TEXT PRIMARY KEY)`;
  }),
});

/** Creates `Effect.catchTags` handlers translating inbox SQL and codec failures into `EventSubReceiptError`. */
const eventSubInboxStorageErrorHandlers = (operation: EventSubReceiptOperation) => ({
  SqlError: (_: SqlError.SqlError) =>
    Effect.fail(
      new EventSubReceiptError({ operation, reason: "storage", messageId: Option.none() }),
    ),
  SchemaError: (_: SchemaError) =>
    Effect.fail(
      new EventSubReceiptError({ operation, reason: "corrupt", messageId: Option.none() }),
    ),
});

/** Creates `Effect.catchTags` handlers translating inbox SQL, codec, and alarm failures into `EventSubReceiptError`. */
const eventSubInboxBoundaryErrorHandlers = (operation: EventSubReceiptOperation) => ({
  ...eventSubInboxStorageErrorHandlers(operation),
  WorkflowAlarmError: (_: WorkflowAlarmError) =>
    Effect.fail(
      new EventSubReceiptError({ operation, reason: "schedule", messageId: Option.none() }),
    ),
});

/** Durable inbox for one EventSub message: receipt persistence, leased dispatch, and at-most-once chat replies. */
export interface IEventSubInbox {
  /**
   * Persists an authenticated receipt and schedules dispatch, or confirms an identical earlier receipt.
   *
   * **Details**
   *
   * The receipt is committed before the recovery alarm is scheduled, so a scheduling failure leaves it pending.
   *
   * @returns Nothing, or fails with `EventSubReceiptConflict` when the message ID was stored with different content, and `EventSubReceiptError` reason `invalid` for a mismatched message ID or malformed content, `storage`/`corrupt` for SQL or stored-data failures, and `schedule` when the alarm cannot be set.
   */
  readonly accept: (
    receipt: AcceptedEventSubReceipt,
  ) => Effect.Effect<void, EventSubReceiptError | EventSubReceiptConflict>;
  /**
   * Returns the receipt's processing status, or `None` before acceptance.
   *
   * @returns The status, or fails with `EventSubReceiptError` reason `storage`/`corrupt`.
   */
  readonly getReceiptStatus: () => Effect.Effect<
    Option.Option<EventSubReceiptStatus>,
    EventSubReceiptError
  >;
  /**
   * Leases and dispatches a due pending receipt, then records completion, retry, or dead letter.
   *
   * **Gotchas**
   *
   * An interrupted chat send becomes `uncertain` and is never resent.
   *
   * @returns Nothing, or fails with `EventSubReceiptError` reason `storage`/`corrupt` when the receipt cannot be read or its lease was lost, and `schedule` when the alarm cannot be set.
   */
  readonly recover: () => Effect.Effect<void, EventSubReceiptError>;
  /**
   * Re-arms the recovery alarm for a pending receipt, or cancels it otherwise.
   *
   * @returns Nothing, or fails with `EventSubReceiptError` reason `storage`/`corrupt`/`schedule`.
   */
  readonly restoreAlarm: () => Effect.Effect<void, EventSubReceiptError>;
}

/** Service tag for the EventSub inbox, acquired once per Durable Object database. */
export class EventSubInbox extends Context.Service<EventSubInbox, IEventSubInbox>()(
  "@cf-twitch/EventSubInbox",
) {}

/**
 * Effect that runs inbox migrations and builds SQL receipt persistence that dispatches only after a durable lease is recorded.
 *
 * @returns The inbox, or fails with `SqlError`/`MigrationError` when migrations cannot run.
 */
export const makeEventSubInbox = Effect.gen(function* () {
  yield* SqliteMigrator.run({ loader: migrationLoader, table: "eventsub_schema_migrations" });
  const sql = yield* SqlClient.SqlClient;
  const alarm = yield* WorkflowAlarm;
  const dispatcher = yield* EventSubDispatch;
  const twitch = yield* TwitchService;
  const analytics = yield* TwitchAnalytics;
  const permit = yield* Semaphore.make(1);

  const readReceipt = Effect.fn("EventSubInbox.readReceipt")(function* () {
    const row = (yield* parseRows(
      yield* sql`SELECT receipt_json FROM eventsub_receipts WHERE singleton=1`,
    ))[0];

    return row === undefined
      ? Option.none<StoredReceipt>()
      : Option.some(yield* parseStoredReceipt(row.receipt_json));
  });

  const saveReceipt = Effect.fn("EventSubInbox.saveReceipt")(function* (
    receipt: StoredReceipt,
    expectedGeneration: number,
  ) {
    const json = yield* encodeStoredReceipt(receipt);

    const rows =
      yield* sql`UPDATE eventsub_receipts SET receipt_json=${json},generation=${receipt.generation} WHERE singleton=1 AND generation=${expectedGeneration} RETURNING message_id`;

    // Zero rows means a newer generation replaced this lease; never overwrite it with the stale copy.
    if (rows.length !== 1)
      return yield* new EventSubReceiptError({
        operation: "save-receipt",
        reason: "storage",
        messageId: Option.some(receipt.receipt.messageId),
      });
  });

  const emitChatMetric = Effect.fn("EventSubInbox.emitChatMetric")(function* (
    receipt: StoredReceipt,
    status: "success" | "error",
    error: Option.Option<string>,
  ) {
    if (Option.isNone(receipt.chatResponse)) return;
    const message = yield* parseEventSubMessage(receipt.receipt.headers, receipt.receipt.body);

    if (!Predicate.isTagged(message, "ChatMessageNotification")) return;
    const identity = `${receipt.attempts}:${status}:${Option.getOrElse(receipt.chatDelivery, () => "refused")}`;

    const claimed =
      yield* sql`INSERT INTO eventsub_metric_claims(identity) VALUES(${identity}) ON CONFLICT DO NOTHING RETURNING identity`;

    if (claimed.length === 0) return;
    yield* analytics.writeChatCommandMetric({
      command: receipt.chatResponse.value.commandName,
      userId: message.event.chatter_user_id,
      userName: message.event.chatter_user_name,
      status,
      error,
      durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - receipt.startedAt),
    });
  });

  const emitCompletedMetric = Effect.fn("EventSubInbox.emitCompletedMetric")(function* () {
    const stored = yield* readReceipt();

    if (Option.isNone(stored) || stored.value.status !== "completed") return;
    const delivery = Option.getOrNull(stored.value.chatDelivery);

    if (delivery === "sent" || delivery === "uncertain")
      yield* emitChatMetric(
        stored.value,
        delivery === "sent" ? "success" : "error",
        delivery === "sent"
          ? Option.none()
          : Option.some(
              "EventSub chat reply outcome is uncertain. Check Twitch chat for the reply; it is never resent.",
            ),
      );
  });

  const restoreAlarm = Effect.fn("EventSubInbox.restoreAlarm")(
    function* () {
      const stored = yield* readReceipt();

      if (Option.isNone(stored) || stored.value.status !== "pending")
        return yield* alarm.set(Option.none());
      const now = yield* Clock.currentTimeMillis;

      const due = Math.max(
        now + 1,
        stored.value.nextAttemptAt,
        Option.getOrElse(stored.value.leaseUntil, () => 0),
      );

      yield* alarm.set(Option.some(due));
    },
    Effect.catchTags(eventSubInboxBoundaryErrorHandlers("restore-alarm")),
  );

  const complete = Effect.fn("EventSubInbox.complete")(function* (receipt: StoredReceipt) {
    yield* saveReceipt(
      { ...receipt, status: "completed", leaseUntil: Option.none(), lastError: Option.none() },
      receipt.generation,
    );
    yield* emitCompletedMetric();
    yield* alarm.set(Option.none());
  });

  const recoverUnlocked = Effect.fn("EventSubInbox.recoverUnlocked")(
    function* () {
      const claimed = yield* sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* readReceipt();

          if (Option.isNone(existing) || existing.value.status !== "pending")
            return Option.none<StoredReceipt>();
          const receipt = existing.value;
          const now = yield* Clock.currentTimeMillis;

          if (
            receipt.nextAttemptAt > now ||
            (Option.isSome(receipt.leaseUntil) && receipt.leaseUntil.value > now)
          )
            return Option.none<StoredReceipt>();

          // An interrupted sending intent is sufficient evidence to prohibit a second send, even at budget exhaustion.
          if (Option.getOrNull(receipt.chatDelivery) === "sending") {
            const uncertain: StoredReceipt = {
              ...receipt,
              status: "completed",
              leaseUntil: Option.none(),
              chatDelivery: Option.some("uncertain"),
              lastError: Option.some(
                "EventSub chat delivery was interrupted, so its outcome is uncertain. Check Twitch chat for the reply; it is never resent.",
              ),
            };

            yield* saveReceipt(uncertain, receipt.generation);

            return Option.none<StoredReceipt>();
          }

          if (receipt.attempts >= MAX_EVENTSUB_ATTEMPTS) {
            yield* saveReceipt(
              {
                ...receipt,
                status: "dead_letter",
                leaseUntil: Option.none(),
                lastError: Option.some(
                  "EventSub dispatch attempt budget exhausted. Inspect the dead-lettered receipt before replaying its notification manually.",
                ),
              },
              receipt.generation,
            );

            return Option.none<StoredReceipt>();
          }

          const lease: StoredReceipt = {
            ...receipt,
            attempts: receipt.attempts + 1,
            generation: receipt.generation + 1,
            leaseUntil: Option.some(now + EVENTSUB_LEASE_MS),
          };

          yield* saveReceipt(lease, receipt.generation);

          return Option.some(lease);
        }),
      );

      if (Option.isNone(claimed)) {
        yield* emitCompletedMetric();

        return yield* restoreAlarm();
      }

      let receipt = claimed.value;
      let providerRetryAfterMs = 0;
      yield* alarm.set(receipt.leaseUntil);

      const dispatch = Effect.gen(function* () {
        if (
          Option.getOrNull(receipt.chatDelivery) === "sent" ||
          Option.getOrNull(receipt.chatDelivery) === "uncertain"
        )
          return;

        if (Option.isNone(receipt.chatResponse)) {
          const response = yield* dispatcher.dispatch(receipt.receipt);
          receipt = { ...receipt, chatResponse: response };
          yield* saveReceipt(receipt, receipt.generation);
        }

        if (Option.isNone(receipt.chatResponse)) return;
        const response = receipt.chatResponse.value;
        receipt = { ...receipt, chatDelivery: Option.some("sending") };
        yield* saveReceipt(receipt, receipt.generation);

        const sent = yield* twitch
          .sendChatMessage({ message: response.message })
          .pipe(Effect.result);

        if (Result.isFailure(sent)) {
          const kind = sent.failure.kind;
          providerRetryAfterMs = Option.getOrElse(sent.failure.retryAfterMs, () => 0);

          if (kind === "outcome-unknown" || kind === "network" || kind === "invalid-response") {
            receipt = { ...receipt, chatDelivery: Option.some("uncertain") };
            yield* saveReceipt(receipt, receipt.generation);

            return;
          }

          // A definite refusal permits another attempt; the prepared response and command mutation are not repeated.
          receipt = { ...receipt, chatDelivery: Option.none() };
          yield* saveReceipt(receipt, receipt.generation);
          yield* emitChatMetric(
            receipt,
            "error",
            Option.some(
              "EventSub chat reply was refused by Twitch. Wait for the recovery alarm; refused replies are retried.",
            ),
          );

          return yield* new EventSubReceiptError({
            operation: "chat-send",
            reason: "dispatch",
            messageId: Option.some(receipt.receipt.messageId),
          });
        }

        receipt = { ...receipt, chatDelivery: Option.some("sent") };
        yield* saveReceipt(receipt, receipt.generation);
      });

      const outcome = yield* dispatch.pipe(
        Effect.annotateLogs({
          message_id: receipt.receipt.messageId,
          trace_id: receipt.receipt.correlation.traceId,
          request_id: receipt.receipt.correlation.requestId,
          attempt: receipt.attempts,
        }),
        Effect.withSpan("EventSubInbox.dispatch", {
          attributes: {
            messageId: receipt.receipt.messageId,
            receiptTraceId: receipt.receipt.correlation.traceId,
            receiptRequestId: receipt.receipt.correlation.requestId,
            attempt: receipt.attempts,
          },
        }),
        Effect.timeout("45 seconds"),
        Effect.result,
      );

      if (Result.isSuccess(outcome)) return yield* complete(receipt);

      // Parse and persistence failures never overwrite newer or corrupt evidence with the stale in-memory copy.
      if (
        !Predicate.isTagged(outcome.failure, "EventSubReceiptError") &&
        !Predicate.isTagged(outcome.failure, "TimeoutError")
      )
        return yield* Effect.fail(outcome.failure);

      if (
        Predicate.isTagged(outcome.failure, "EventSubReceiptError") &&
        outcome.failure.reason !== "dispatch"
      )
        return yield* outcome.failure;

      if (Option.getOrNull(receipt.chatDelivery) === "sending") {
        receipt = { ...receipt, chatDelivery: Option.some("uncertain") };

        return yield* complete(receipt);
      }

      const exhausted = receipt.attempts >= MAX_EVENTSUB_ATTEMPTS;

      const due =
        (yield* Clock.currentTimeMillis) +
        Math.max(
          providerRetryAfterMs,
          Math.min(1_000 * 2 ** Math.min(receipt.attempts, 9), 600_000),
        );

      receipt = {
        ...receipt,
        status: exhausted ? "dead_letter" : "pending",
        leaseUntil: Option.none(),
        nextAttemptAt: due,
        lastError: Option.some(
          "EventSub durable dispatch failed. Wait for the recovery alarm; the receipt is retried until its attempt budget is exhausted.",
        ),
      };
      yield* saveReceipt(receipt, receipt.generation);
      yield* alarm.set(exhausted ? Option.none() : Option.some(due));
      yield* Effect.logWarning("EventSub receipt dispatch failed", {
        messageId: receipt.receipt.messageId,
        attempts: receipt.attempts,
        status: receipt.status,
      });
    },
    Effect.catchTags(eventSubInboxBoundaryErrorHandlers("recover")),
  );

  const accept = Effect.fn("EventSubInbox.accept")((input: AcceptedEventSubReceipt) =>
    permit
      .withPermit(
        Effect.gen(function* () {
          const receipt = input;

          if (receipt.messageId !== receipt.headers["twitch-eventsub-message-id"])
            return yield* new EventSubReceiptError({
              operation: "accept",
              reason: "invalid",
              messageId: Option.some(receipt.messageId),
            });
          yield* parseEventSubMessage(receipt.headers, receipt.body);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* readReceipt();

              if (Option.isSome(existing)) {
                const previous = existing.value.receipt;

                if (
                  previous.messageId !== receipt.messageId ||
                  previous.contentDigest !== receipt.contentDigest ||
                  previous.headers["twitch-eventsub-message-type"] !==
                    receipt.headers["twitch-eventsub-message-type"] ||
                  previous.headers["twitch-eventsub-subscription-type"] !==
                    receipt.headers["twitch-eventsub-subscription-type"] ||
                  previous.headers["twitch-eventsub-subscription-version"] !==
                    receipt.headers["twitch-eventsub-subscription-version"]
                )
                  return yield* new EventSubReceiptConflict({
                    operation: "accept",
                    reason: "content_mismatch",
                    messageId: receipt.messageId,
                  });

                return;
              }

              const stored: StoredReceipt = {
                receipt,
                status: "pending",
                attempts: 0,
                generation: 0,
                startedAt: yield* Clock.currentTimeMillis,
                leaseUntil: Option.none(),
                nextAttemptAt: yield* Clock.currentTimeMillis,
                lastError: Option.none(),
                chatResponse: Option.none(),
                chatDelivery: Option.none(),
              };

              const json = yield* encodeStoredReceipt(stored);
              yield* sql`INSERT INTO eventsub_receipts(singleton,message_id,generation,receipt_json) VALUES(1,${receipt.messageId},0,${json})`;
            }),
          );
          yield* restoreAlarm();
        }),
      )
      .pipe(Effect.catchTags(eventSubInboxStorageErrorHandlers("accept"))),
  );

  const getReceiptStatus = Effect.fn("EventSubInbox.getReceiptStatus")(
    function* () {
      return Option.map(yield* readReceipt(), (receipt) => ({
        status: receipt.status,
        attempts: receipt.attempts,
        lastError: receipt.lastError,
        chatCommandDelivery: receipt.chatDelivery,
      }));
    },
    Effect.catchTags(eventSubInboxStorageErrorHandlers("get-status")),
  );

  const recover = Effect.fn("EventSubInbox.recover")(() => permit.withPermit(recoverUnlocked()));

  return EventSubInbox.of({ accept, getReceiptStatus, recover, restoreAlarm });
});

/** Layer that provides the SQL inbox; requires SQL, the alarm, dispatch, the Twitch provider, and analytics. */
export const eventSubInboxLayerWithoutDependencies = Layer.effect(EventSubInbox, makeEventSubInbox);

// Built inside the Durable Object runtime phase, where `DurableObjectState` is available; never during planning.
const durableObjectSqliteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return SqliteClient.layer({ storage: state.raw.storage });
  }),
);

/** Production inbox Layer over the Durable Object's SQLite storage and native alarm; requires the runtime `DurableObjectState`, dispatch, the Twitch provider, and analytics. */
export const eventSubInboxLayer = eventSubInboxLayerWithoutDependencies.pipe(
  Layer.provide([durableObjectSqliteLayer, workflowAlarmLayer]),
);

/** Inbox Layer over an in-memory alarm; the test selects SQL, dispatch, the Twitch provider, and analytics. */
export const eventSubInboxTestLayer = eventSubInboxLayerWithoutDependencies.pipe(
  Layer.provide(workflowAlarmTestLayer),
);
