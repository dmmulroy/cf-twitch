import { Effect, Option, Schema } from "effect";
import { DomainEvent } from "./domain-event.ts";
import { EventId, IsoTimestamp, NonNegativeInt, PageSize, PositiveInt } from "./identity.ts";

/** Canonical singleton key for the Event Bus Durable Object. */
export const EVENT_BUS_SINGLETON_KEY = "event-bus";

/** Closed set of domain event discriminators accepted by subscription policy. */
export const DomainEventType = Schema.Literals([
  "song_request_success",
  "raffle_roll",
  "stream_online",
  "stream_offline",
]);

/** Domain event discriminator accepted by subscription policy. */
export type DomainEventType = typeof DomainEventType.Type;

/** Event Bus subscriber identities supported by the current routing topology. */
export const EventBusSubscriber = Schema.Literal("achievements");

/** A supported Event Bus subscriber identity. */
export type EventBusSubscriber = typeof EventBusSubscriber.Type;

/** Stable identity for one Event Bus subscription. */
export const EventBusSubscriptionId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("EventBusSubscriptionId"),
);

/** Stable identity for one Event Bus subscription. */
export type EventBusSubscriptionId = typeof EventBusSubscriptionId.Type;

/** Bounded pagination accepted by Event Bus administration operations. */
export const EventBusPageInput = Schema.Struct({
  limit: PageSize,
  offset: NonNegativeInt,
});

/** Bounded pagination accepted by Event Bus administration operations. */
export type EventBusPageInput = typeof EventBusPageInput.Type;

/** One event that is durably awaiting delivery or retry. */
export const PendingEventItem = Schema.Struct({
  id: EventId,
  /** Stored event, or `Option.none()` when its stored JSON is unreadable. */
  event: Schema.OptionFromNullOr(DomainEvent),
  /** Delivery attempts made by retry processing; the initial publish attempt is not counted. */
  attempts: NonNegativeInt,
  nextRetryAt: IsoTimestamp,
  createdAt: IsoTimestamp,
});

/** One event that is durably awaiting delivery or retry. */
export type PendingEventItem = typeof PendingEventItem.Type;

/** A page of pending Event Bus deliveries. */
export const PendingEventList = Schema.Struct({
  items: Schema.Array(PendingEventItem),
  totalCount: NonNegativeInt,
  limit: PageSize,
  offset: NonNegativeInt,
});

/** A page of pending Event Bus deliveries. */
export type PendingEventList = typeof PendingEventList.Type;

/** One event retained after exhausting automatic delivery attempts. */
export const DeadLetterEventItem = Schema.Struct({
  id: EventId,
  /** Stored event, or `Option.none()` when its stored JSON is unreadable. */
  event: Schema.OptionFromNullOr(DomainEvent),
  /** Safe failure description recorded by the last failed delivery or replay. */
  error: Schema.String,
  attempts: PositiveInt,
  /** When the event was first accepted for delivery. */
  firstFailedAt: IsoTimestamp,
  lastFailedAt: IsoTimestamp,
  /** End of the 30-day dead-letter retention, after which the entry is purged. */
  expiresAt: IsoTimestamp,
});

/** One event retained after exhausting automatic delivery attempts. */
export type DeadLetterEventItem = typeof DeadLetterEventItem.Type;

/** A page of Event Bus dead-letter deliveries. */
export const DeadLetterEventList = Schema.Struct({
  items: Schema.Array(DeadLetterEventItem),
  totalCount: NonNegativeInt,
  limit: PageSize,
  offset: NonNegativeInt,
});

/** A page of Event Bus dead-letter deliveries. */
export type DeadLetterEventList = typeof DeadLetterEventList.Type;

/** Result of manually replaying one dead-letter event. */
export const DeadLetterReplayResult = Schema.Struct({
  /** Whether the subscriber accepted the replayed event; `false` keeps it dead-lettered. */
  success: Schema.Boolean,
  eventId: EventId,
  /** Failure description when the replay was not accepted, otherwise `Option.none()`. */
  error: Schema.OptionFromNullOr(Schema.String),
});

/** Result of manually replaying one dead-letter event. */
export type DeadLetterReplayResult = typeof DeadLetterReplayResult.Type;

/** A persisted mapping from an event type to a supported subscriber. */
export const EventBusSubscription = Schema.Struct({
  id: EventBusSubscriptionId,
  subscriber: EventBusSubscriber,
  eventType: DomainEventType,
  createdAt: IsoTimestamp,
});

/** A persisted mapping from an event type to a supported subscriber. */
export type EventBusSubscription = typeof EventBusSubscription.Type;

/** Request to register one subscriber for one or more event types. */
export const RegisterEventBusSubscriptionInput = Schema.Struct({
  subscriber: EventBusSubscriber,
  eventTypes: Schema.NonEmptyArray(DomainEventType),
});

/** Request to register one subscriber for one or more event types. */
export type RegisterEventBusSubscriptionInput = typeof RegisterEventBusSubscriptionInput.Type;

/** Event Bus durable-state counts used by operations and diagnostics. */
export const EventBusStats = Schema.Struct({
  pendingCount: NonNegativeInt,
  deadLetterCount: NonNegativeInt,
  deliveredCount: NonNegativeInt,
  subscriptionCount: NonNegativeInt,
});

/** Event Bus durable-state counts used by operations and diagnostics. */
export type EventBusStats = typeof EventBusStats.Type;

/** Event Bus scheduler and persistence health projection. */
export const EventBusStatus = Schema.Struct({
  /** Always `true` when the status could be read; read failures are errors instead. */
  healthy: Schema.Boolean,
  /** Earliest pending retry, or `Option.none()` when nothing is pending. */
  nextRetryAt: Schema.OptionFromNullOr(IsoTimestamp),
  /** Earliest dead-letter expiry, or `Option.none()` when the queue is empty. */
  nextDeadLetterExpiryAt: Schema.OptionFromNullOr(IsoTimestamp),
  stats: EventBusStats,
});

/** Event Bus scheduler and persistence health projection. */
export type EventBusStatus = typeof EventBusStatus.Type;

/** Schema for the Event Bus operations named by typed Event Bus failures. */
export const EventBusOperation = Schema.Literals([
  "publish",
  "retryDue",
  "scheduleAlarm",
  "listPending",
  "listDeadLetters",
  "replayDeadLetter",
  "retryPending",
  "deleteDeadLetter",
  "purgeExpiredDeadLetters",
  "listSubscriptions",
  "registerSubscription",
  "unregisterSubscription",
  "getStats",
  "getStatus",
  "reset",
]);

/** Event Bus operation that failed. */
export type EventBusOperation = typeof EventBusOperation.Type;

/** Schema for the classified reasons an Event Bus operation fails. */
export const EventBusErrorReason = Schema.Literals([
  "persistence_unavailable",
  "transport_unavailable",
  "alarm_unavailable",
  "stored_row_invalid",
  "stored_event_invalid",
  "event_invalid",
  "invalid_response",
  "subscriber_unavailable",
  "subscriber_rejected",
  "event_not_found",
  "subscription_not_found",
]);

/** Classified reason an Event Bus operation failed. */
export type EventBusErrorReason = typeof EventBusErrorReason.Type;

const eventBusEventLabel = (eventId: Option.Option<EventId>): string =>
  Option.match(eventId, { onNone: () => "", onSome: (id) => ` for event ${id}` });

/** Expected failure while applying Event Bus persistence or delivery policy. */
export class EventBusError extends Schema.TaggedError<EventBusError>()("EventBusError", {
  /** Event Bus operation that failed. */
  operation: EventBusOperation,
  /** Classified cause; the message wording and retry guidance depend on it. */
  reason: EventBusErrorReason,
  /** Event the operation concerned, or `Option.none()` for operations without one. */
  eventId: Schema.OptionFromNullOr(EventId),
  /** Subscription the operation concerned; defaults to `Option.none()`. */
  subscriptionId: Schema.OptionFromNullOr(EventBusSubscriptionId).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
}) {
  /** Describes the failed operation and reason without event payloads or persistence details. */
  override get message(): string {
    const event = eventBusEventLabel(this.eventId);

    switch (this.reason) {
      case "persistence_unavailable":
        return `Event Bus storage is unavailable during ${this.operation}${event}. Retry the same operation; Event Bus deduplicates deliveries by event ID.`;
      case "transport_unavailable":
        return `Event Bus could not be reached during ${this.operation}${event}, so the outcome is unknown. Retry the same operation; Event Bus deduplicates deliveries by event ID.`;
      case "alarm_unavailable":
        return `Event Bus alarm could not be scheduled during ${this.operation}. Pending deliveries are still stored; retry the operation to reschedule them.`;
      case "stored_row_invalid":
        return `Event Bus stored row is invalid during ${this.operation}${event}. Inspect and repair the stored Event Bus records before retrying.`;
      case "stored_event_invalid":
        return `Event Bus stored event is unreadable during ${this.operation}${event}. Inspect the dead-letter entry, then repair or delete it.`;
      case "event_invalid":
        return `Event Bus could not encode the event during ${this.operation}${event}. Check the event fields against the domain event contract and publish it again.`;
      case "invalid_response":
        return `Event Bus response is invalid during ${this.operation}${event}: it does not match the Event Bus contract. Check that the API and the Event Bus run the same release, then read the event state before retrying.`;
      case "subscriber_unavailable":
        return `Event Bus subscriber did not accept the delivery during ${this.operation}${event}. The event stays pending or dead-lettered; check the subscriber and replay it.`;
      case "subscriber_rejected":
        return `Event Bus subscriber rejected the delivery during ${this.operation}${event}. The event stays pending or dead-lettered; inspect it, then replay or delete it.`;
      case "event_not_found":
        return `Event Bus event not found during ${this.operation}${event}. Check the event ID against the pending and dead-letter lists and try again.`;
      case "subscription_not_found":
        return `Event Bus subscription not found during ${this.operation}${Option.match(this.subscriptionId, { onNone: () => "", onSome: (id) => ` for subscription ${id}` })}. List the subscriptions to find the current ID and try again.`;
    }
  }
}
