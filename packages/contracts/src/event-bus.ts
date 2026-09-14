import { Schema } from "effect";
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
  event: Schema.OptionFromNullOr(DomainEvent),
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
  event: Schema.OptionFromNullOr(DomainEvent),
  error: Schema.String,
  attempts: PositiveInt,
  firstFailedAt: IsoTimestamp,
  lastFailedAt: IsoTimestamp,
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
  success: Schema.Boolean,
  eventId: EventId,
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
  healthy: Schema.Boolean,
  nextRetryAt: Schema.OptionFromNullOr(IsoTimestamp),
  nextDeadLetterExpiryAt: Schema.OptionFromNullOr(IsoTimestamp),
  stats: EventBusStats,
});

/** Event Bus scheduler and persistence health projection. */
export type EventBusStatus = typeof EventBusStatus.Type;

/** Supported Event Bus operation names included in typed failures. */
export const EventBusOperation = Schema.Literals([
  "publish",
  "retryDue",
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

/** Supported Event Bus operation name. */
export type EventBusOperation = typeof EventBusOperation.Type;

/** Expected failure while applying Event Bus persistence or delivery policy. */
export class EventBusError extends Schema.TaggedError<EventBusError>()("EventBusError", {
  operation: EventBusOperation,
  reason: Schema.Literals([
    "persistence_unavailable",
    "stored_event_invalid",
    "invalid_response",
    "subscriber_unavailable",
    "event_not_found",
    "subscription_not_found",
    "subscription_conflict",
  ]),
  eventId: Schema.OptionFromNullOr(EventId),
}) {
  /** Stable Event Bus failure description excludes event payloads and persistence details. */
  override get message(): string {
    return `Event Bus ${this.operation} failed (${this.reason})`;
  }
}
