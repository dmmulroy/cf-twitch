import { Match, Schema } from "effect";
import { isOpenApiPattern } from "./schema-pattern.ts";
import { EventSubMessageId, IsoTimestamp, NonNegativeInt } from "./identity.ts";

/** Schema for signed EventSub transport headers, authenticated before body parsing; retry metadata is not receipt identity. */
export const EventSubHeaders = Schema.Struct({
  "twitch-eventsub-message-id": EventSubMessageId,
  "twitch-eventsub-message-retry": Schema.String.check(isOpenApiPattern(/^\d+$/)),
  "twitch-eventsub-message-type": Schema.Literals([
    "webhook_callback_verification",
    "notification",
    "revocation",
  ]),
  "twitch-eventsub-message-signature": Schema.String.check(
    isOpenApiPattern(/^sha256=[0-9a-f]{64}$/),
  ),
  "twitch-eventsub-message-timestamp": IsoTimestamp,
  "twitch-eventsub-subscription-type": Schema.NonEmptyString,
  "twitch-eventsub-subscription-version": Schema.NonEmptyString,
});

/** Parsed signed EventSub transport metadata. */
export interface EventSubHeaders extends Schema.Schema.Type<typeof EventSubHeaders> {}

/** Schema for receipt correlation, diagnostic metadata that never participates in duplicate conflict checks. */
export const EventSubCorrelation = Schema.Struct({
  traceId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
});

/** Schema for an authenticated durable receipt; ingestion metadata is excluded from identity. */
export const AcceptedEventSubReceipt = Schema.Struct({
  messageId: EventSubMessageId,
  /** First server ingestion time; not signed source time and never duplicate identity. */
  receivedAt: IsoTimestamp,
  /** SHA-256 of message ID, signed timestamp, and exact raw body bytes, computed after authentication. */
  contentDigest: Schema.String.check(isOpenApiPattern(/^[0-9a-f]{64}$/)),
  headers: EventSubHeaders,
  body: Schema.Json,
  correlation: EventSubCorrelation,
});

/** Authenticated durable receipt input; ingestion metadata is excluded from identity. */
export interface AcceptedEventSubReceipt extends Schema.Schema.Type<
  typeof AcceptedEventSubReceipt
> {}

/** Schema for receipt progress, exposing retry and uncertain chat outcomes without the signed personal payload. */
export const EventSubReceiptStatus = Schema.Struct({
  status: Schema.Literals(["pending", "completed", "dead_letter"]),
  attempts: NonNegativeInt,
  /** Operator diagnostic for the most recent dispatch failure, absent after success. */
  lastError: Schema.OptionFromNullOr(Schema.String),
  /** Chat Command reply delivery checkpoint; `uncertain` is never resent. */
  chatCommandDelivery: Schema.OptionFromNullOr(Schema.Literals(["sending", "sent", "uncertain"])),
});

/** Parsed receipt progress without signed personal content. */
export interface EventSubReceiptStatus extends Schema.Schema.Type<typeof EventSubReceiptStatus> {}

/** Schema for the EventSub receipt operations whose failures `EventSubReceiptError` reports. */
export const EventSubReceiptOperation = Schema.Literals([
  "parse-message",
  "prepare-chat",
  "dispatch",
  "accept",
  "get-status",
  "legacy-state-gate",
  "save-receipt",
  "restore-alarm",
  "recover",
  "chat-send",
]);

/** EventSub receipt operation that failed. */
export type EventSubReceiptOperation = typeof EventSubReceiptOperation.Type;

/** Schema for the classified causes of an `EventSubReceiptError`. */
export const EventSubReceiptFailureReason = Schema.Literals([
  "invalid",
  "invalid_response",
  "corrupt",
  "legacy_state",
  "storage",
  "schedule",
  "dispatch",
  "transport",
]);

/** Classified cause of an EventSub receipt failure. */
export type EventSubReceiptFailureReason = typeof EventSubReceiptFailureReason.Type;

/** Error raised when an EventSub message ID is reused with different authenticated content. */
export class EventSubReceiptConflict extends Schema.TaggedError<EventSubReceiptConflict>()(
  "EventSubReceiptConflict",
  {
    /** Receipt operation that detected the conflict. */
    operation: Schema.Literal("accept"),
    /** The stored receipt's digest, message type, or subscription type/version differs. */
    reason: Schema.Literal("content_mismatch"),
    /** Authenticated message ID that was reused. */
    messageId: EventSubMessageId,
  },
) {
  /** Conflict message naming the reused message ID; the conflicting delivery was not stored. */
  override get message(): string {
    return `EventSub message ID ${this.messageId} was reused with different signed content, so the delivery was not accepted. Inspect the original receipt for this message ID before redelivering.`;
  }
}

/** Error raised when EventSub receipt parsing, storage, scheduling, or dispatch fails. */
export class EventSubReceiptError extends Schema.TaggedError<EventSubReceiptError>()(
  "EventSubReceiptError",
  {
    /** Receipt operation that failed. */
    operation: EventSubReceiptOperation,
    /** Classified cause; selects the message and whether the inbox retries. */
    reason: EventSubReceiptFailureReason,
    /** Authenticated message whose receipt failed, when the failing code knows it. */
    messageId: Schema.OptionFromNullOr(EventSubMessageId),
  },
) {
  /** Receipt failure message naming the operation and classified reason, excluding signed content and provider detail. */
  override get message(): string {
    return Match.value(this.reason).pipe(
      Match.when(
        "invalid",
        () =>
          `EventSub message content is invalid during ${this.operation}. Inspect the subscription payload and headers Twitch sent; redelivering the same message fails again.`,
      ),
      Match.when(
        "invalid_response",
        () =>
          `EventSub receipt service returned an unreadable response during ${this.operation}. Retry the delivery; identical redelivery is deduplicated by message ID and content digest.`,
      ),
      Match.when(
        "corrupt",
        () =>
          `EventSub stored receipt is unreadable during ${this.operation}. Inspect the receipt's Durable Object storage before retrying.`,
      ),
      Match.when(
        "legacy_state",
        () =>
          `EventSub legacy receipt state blocks the SQL inbox during ${this.operation}. Drain or translate the legacy eventsub-receipt entry before routing deliveries here.`,
      ),
      Match.when(
        "storage",
        () =>
          `EventSub receipt storage failed during ${this.operation}. Retry the operation; acceptance is deduplicated and recovery is fenced by the receipt generation.`,
      ),
      Match.when(
        "schedule",
        () =>
          `EventSub recovery alarm could not be scheduled during ${this.operation}. Retry the operation to schedule recovery again.`,
      ),
      Match.when(
        "dispatch",
        () =>
          `EventSub notification dispatch failed during ${this.operation}. Inspect the receipt status; the inbox retries pending receipts until the attempt budget is exhausted.`,
      ),
      Match.when(
        "transport",
        () =>
          `EventSub receipt service was unreachable during ${this.operation}. Retry the delivery; identical redelivery is deduplicated by message ID and content digest.`,
      ),
      Match.exhaustive,
    );
  }
}
