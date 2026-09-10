import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import type { SchemaError } from "effect/Schema";
import {
  AcceptedEventSubReceipt,
  EventSubReceiptConflict,
  EventSubReceiptError,
  EventSubReceiptStatus,
} from "@cf-twitch/contracts/eventsub";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import { NonNegativeInt } from "@cf-twitch/contracts/identity";
import { TwitchService } from "../providers/twitch-service.ts";
import { WorkflowAlarm, WorkflowAlarmError } from "../workflows/workflow-alarm.ts";
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

type EventSubInboxBoundaryError =
  | EventSubReceiptError
  | SchemaError
  | SqlError.SqlError
  | WorkflowAlarmError;

const catchEventSubInboxBoundaryErrors =
  (operation: string) =>
  <A, R>(
    effect: Effect.Effect<A, EventSubInboxBoundaryError, R>,
  ): Effect.Effect<A, EventSubReceiptError, R> =>
    effect.pipe(
      Effect.catchTags({
        SqlError: () => Effect.fail(new EventSubReceiptError({ operation, reason: "storage" })),
        SchemaError: () => Effect.fail(new EventSubReceiptError({ operation, reason: "corrupt" })),
        WorkflowAlarmError: () =>
          Effect.fail(new EventSubReceiptError({ operation, reason: "schedule" })),
      }),
    );

const catchEventSubAcceptanceBoundaryErrors =
  (operation: string) =>
  <A, R>(
    effect: Effect.Effect<A, EventSubInboxBoundaryError | EventSubReceiptConflict, R>,
  ): Effect.Effect<A, EventSubReceiptError | EventSubReceiptConflict, R> =>
    effect.pipe(
      Effect.catchTags({
        SqlError: () => Effect.fail(new EventSubReceiptError({ operation, reason: "storage" })),
        SchemaError: () => Effect.fail(new EventSubReceiptError({ operation, reason: "corrupt" })),
        WorkflowAlarmError: () =>
          Effect.fail(new EventSubReceiptError({ operation, reason: "schedule" })),
      }),
    );

/** Instance-local durable inbox with leased dispatch and uncertain chat recovery. */
export interface IEventSubInbox {
  readonly accept: (
    receipt: AcceptedEventSubReceipt,
  ) => Effect.Effect<void, EventSubReceiptError | EventSubReceiptConflict>;
  readonly getReceiptStatus: () => Effect.Effect<
    Option.Option<EventSubReceiptStatus>,
    EventSubReceiptError
  >;
  readonly recover: () => Effect.Effect<void, EventSubReceiptError>;
  readonly restoreAlarm: () => Effect.Effect<void, EventSubReceiptError>;
}

/** EventSub inbox authority is acquired once per Durable Object database. */
export class EventSubInbox extends Context.Service<EventSubInbox, IEventSubInbox>()(
  "@cf-twitch/EventSubInbox",
) {}

/** Construct SQL receipt persistence, then dispatch only after a durable lease is recorded. */
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

    if (rows.length !== 1)
      return yield* new EventSubReceiptError({
        operation: "save-lease",
        reason: "storage",
      });
  });

  const emitChatMetric = Effect.fn("EventSubInbox.emitChatMetric")(function* (
    receipt: StoredReceipt,
    status: "success" | "error",
    error: Option.Option<string>,
  ) {
    if (Option.isNone(receipt.chatResponse)) return;
    const message = yield* parseEventSubMessage(receipt.receipt.headers, receipt.receipt.body);

    if (message._tag !== "ChatMessageNotification") return;
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
          : Option.some("EventSub chat outcome uncertain; resend prohibited"),
      );
  });

  const restoreAlarm = Effect.fn("EventSubInbox.restoreAlarm")(function* () {
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
  }, catchEventSubInboxBoundaryErrors("restore-alarm"));

  const complete = Effect.fn("EventSubInbox.complete")(function* (receipt: StoredReceipt) {
    yield* saveReceipt(
      { ...receipt, status: "completed", leaseUntil: Option.none(), lastError: Option.none() },
      receipt.generation,
    );
    yield* emitCompletedMetric();
    yield* alarm.set(Option.none());
  });

  const recoverUnlocked = Effect.fn("EventSubInbox.recoverUnlocked")(function* () {
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
              "EventSub chat delivery interrupted; outcome uncertain and resend prohibited",
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
              lastError: Option.some("EventSub dispatch attempt budget exhausted"),
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
      const sent = yield* twitch.sendChatMessage({ message: response.message }).pipe(Effect.result);

      if (sent._tag === "Failure") {
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
          Option.some("EventSub chat provider explicitly refused delivery"),
        );

        return yield* new EventSubReceiptError({
          operation: "chat-send",
          reason: "dispatch",
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

    if (outcome._tag === "Success") return yield* complete(receipt);

    // Parse and persistence failures never overwrite newer or corrupt evidence with the stale in-memory copy.
    if (outcome.failure._tag !== "EventSubReceiptError" && outcome.failure._tag !== "TimeoutError")
      return yield* Effect.fail(outcome.failure);

    if (outcome.failure._tag === "EventSubReceiptError" && outcome.failure.reason !== "dispatch")
      return yield* outcome.failure;

    if (Option.getOrNull(receipt.chatDelivery) === "sending") {
      receipt = { ...receipt, chatDelivery: Option.some("uncertain") };

      return yield* complete(receipt);
    }

    const exhausted = receipt.attempts >= MAX_EVENTSUB_ATTEMPTS;

    const due =
      (yield* Clock.currentTimeMillis) +
      Math.max(providerRetryAfterMs, Math.min(1_000 * 2 ** Math.min(receipt.attempts, 9), 600_000));

    receipt = {
      ...receipt,
      status: exhausted ? "dead_letter" : "pending",
      leaseUntil: Option.none(),
      nextAttemptAt: due,
      lastError: Option.some("EventSub durable dispatch failed"),
    };
    yield* saveReceipt(receipt, receipt.generation);
    yield* alarm.set(exhausted ? Option.none() : Option.some(due));
    yield* Effect.logWarning("EventSub receipt dispatch failed", {
      messageId: receipt.receipt.messageId,
      attempts: receipt.attempts,
      status: receipt.status,
    });
  }, catchEventSubInboxBoundaryErrors("recover"));

  const accept = Effect.fn("EventSubInbox.accept")((input: AcceptedEventSubReceipt) =>
    permit
      .withPermit(
        Effect.gen(function* () {
          const receipt = input;

          if (receipt.messageId !== receipt.headers["twitch-eventsub-message-id"])
            return yield* new EventSubReceiptError({
              operation: "accept",
              reason: "invalid",
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
      .pipe(catchEventSubAcceptanceBoundaryErrors("accept")),
  );

  const getReceiptStatus = Effect.fn("EventSubInbox.getReceiptStatus")(function* () {
    return Option.map(yield* readReceipt(), (receipt) => ({
      status: receipt.status,
      attempts: receipt.attempts,
      lastError: receipt.lastError,
      chatCommandDelivery: receipt.chatDelivery,
    }));
  }, catchEventSubInboxBoundaryErrors("get-status"));

  const recover = Effect.fn("EventSubInbox.recover")(() => permit.withPermit(recoverUnlocked()));

  return EventSubInbox.of({ accept, getReceiptStatus, recover, restoreAlarm });
});

/** SQL inbox Layer keeps real dispatcher, provider and alarm services replaceable through their public interfaces. */
export const eventSubInboxLayerWithoutDependencies = Layer.effect(EventSubInbox, makeEventSubInbox);
