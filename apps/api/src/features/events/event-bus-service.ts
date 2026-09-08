import { Context, Schema, type Effect } from "effect";
import type { DomainEvent } from "@cf-twitch/contracts/domain-event";
import type {
  DeadLetterEventList,
  DeadLetterReplayResult,
  EventBusError,
  EventBusPageInput,
  EventBusStats,
  EventBusStatus,
  EventBusSubscription,
  EventBusSubscriptionId,
  PendingEventList,
  RegisterEventBusSubscriptionInput,
} from "@cf-twitch/contracts/event-bus";
import type { EventId } from "@cf-twitch/contracts/identity";

/** A subscriber rejected or could not durably accept an event delivery. */
export class EventHandlerError extends Schema.TaggedError<EventHandlerError>()(
  "EventHandlerError",
  {
    reason: Schema.Literals(["consumer_unavailable", "consumer_rejected"]),
  },
) {}

/** Event consumer boundary used by Event Bus delivery and recovery tests. */
export interface IEventHandler {
  readonly handleDomainEvent: (event: DomainEvent) => Effect.Effect<void, EventHandlerError>;
}

/** Event consumer selected by persisted Event Bus subscription policy. */
export class EventHandler extends Context.Service<EventHandler, IEventHandler>()(
  "@cf-twitch/EventHandler",
) {}

/** Durable event publication accepted independently of immediate consumer availability. */
export interface IEventPublisher {
  readonly publish: (event: DomainEvent) => Effect.Effect<void, EventBusError>;
}

/** Shared domain-event publication capability backed by the Event Bus singleton. */
export class EventPublisher extends Context.Service<EventPublisher, IEventPublisher>()(
  "@cf-twitch/EventPublisher",
) {}

/** Operational access to pending, dead-letter, receipt, and subscription evidence. */
export interface IEventBusAdministration {
  readonly getStats: () => Effect.Effect<EventBusStats, EventBusError>;
  readonly getStatus: () => Effect.Effect<EventBusStatus, EventBusError>;
  readonly listPending: (
    input: EventBusPageInput,
  ) => Effect.Effect<PendingEventList, EventBusError>;
  readonly listDeadLetters: (
    input: EventBusPageInput,
  ) => Effect.Effect<DeadLetterEventList, EventBusError>;
  readonly replayDeadLetter: (input: {
    readonly eventId: EventId;
  }) => Effect.Effect<DeadLetterReplayResult, EventBusError>;
  readonly retryPending: (input: {
    readonly eventId: EventId;
  }) => Effect.Effect<void, EventBusError>;
  readonly deleteDeadLetter: (input: {
    readonly eventId: EventId;
  }) => Effect.Effect<void, EventBusError>;
  readonly purgeExpiredDeadLetters: () => Effect.Effect<number, EventBusError>;
  readonly listSubscriptions: () => Effect.Effect<
    ReadonlyArray<EventBusSubscription>,
    EventBusError
  >;
  readonly registerSubscription: (
    input: RegisterEventBusSubscriptionInput,
  ) => Effect.Effect<ReadonlyArray<EventBusSubscription>, EventBusError>;
  readonly unregisterSubscription: (input: {
    readonly subscriptionId: EventBusSubscriptionId;
  }) => Effect.Effect<void, EventBusError>;
  readonly reset: () => Effect.Effect<void, EventBusError>;
}

/** Shared administrative capability backed by the Event Bus singleton. */
export class EventBusAdministration extends Context.Service<
  EventBusAdministration,
  IEventBusAdministration
>()("@cf-twitch/EventBusAdministration") {}
