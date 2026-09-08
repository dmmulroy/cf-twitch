import { Schema } from "effect";
import { EventSubMessageId, IsoTimestamp, NonNegativeInt } from "./identity.ts";

/** EventSub headers are authenticated before body parsing; retry metadata is not receipt identity. */
export const EventSubHeaders = Schema.Struct({
  "twitch-eventsub-message-id": EventSubMessageId,
  "twitch-eventsub-message-retry": Schema.String.check(Schema.isPattern(/^\d+$/)),
  "twitch-eventsub-message-type": Schema.Literals([
    "webhook_callback_verification",
    "notification",
    "revocation",
  ]),
  "twitch-eventsub-message-signature": Schema.String.check(
    Schema.isPattern(/^sha256=[0-9a-f]{64}$/),
  ),
  "twitch-eventsub-message-timestamp": IsoTimestamp,
  "twitch-eventsub-subscription-type": Schema.NonEmptyString,
  "twitch-eventsub-subscription-version": Schema.NonEmptyString,
});
/** Parsed signed EventSub transport metadata. */
export interface EventSubHeaders extends Schema.Schema.Type<typeof EventSubHeaders> {}
/** Receipt correlation is diagnostic metadata and never participates in duplicate conflict checks. */
export const EventSubCorrelation = Schema.Struct({
  traceId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
});
/** Digest is SHA256(message ID + timestamp + exact raw body bytes), computed after authentication. */
export const AcceptedEventSubReceipt = Schema.Struct({
  messageId: EventSubMessageId,
  /** First server ingestion time; not signed source time and never duplicate identity. */
  receivedAt: IsoTimestamp,
  contentDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  headers: EventSubHeaders,
  body: Schema.Json,
  correlation: EventSubCorrelation,
});
/** Authenticated durable receipt input; ingestion metadata is excluded from identity. */
export interface AcceptedEventSubReceipt extends Schema.Schema.Type<
  typeof AcceptedEventSubReceipt
> {}
/** Receipt status exposes retry and uncertain chat outcomes without the signed personal payload. */
export const EventSubReceiptStatus = Schema.Struct({
  status: Schema.Literals(["pending", "completed", "dead_letter"]),
  attempts: NonNegativeInt,
  lastError: Schema.OptionFromNullOr(Schema.String),
  chatCommandDelivery: Schema.OptionFromNullOr(Schema.Literals(["sending", "sent", "uncertain"])),
});
/** Parsed receipt progress without signed personal content. */
export interface EventSubReceiptStatus extends Schema.Schema.Type<typeof EventSubReceiptStatus> {}
/** Reused EventSub message identity with different authenticated content is rejected. */
export class EventSubReceiptConflict extends Schema.TaggedError<EventSubReceiptConflict>()(
  "EventSubReceiptConflict",
  {
    messageId: EventSubMessageId,
  },
) {
  /** Stable receipt-conflict message identifies only the authenticated delivery. */
  override get message(): string {
    return `EventSub receipt conflict for ${this.messageId}`;
  }
}
/** Receipt parsing, storage and scheduling failures remain explicit acceptance failures. */
export class EventSubReceiptError extends Schema.TaggedError<EventSubReceiptError>()(
  "EventSubReceiptError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "invalid",
      "invalid_response",
      "corrupt",
      "storage",
      "schedule",
      "dispatch",
      "transport",
    ]),
  },
) {
  /** Stable receipt failure message excludes signed content and provider detail. */
  override get message(): string {
    return `EventSub receipt ${this.operation} failed (${this.reason})`;
  }
}
