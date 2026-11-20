import { Context, Effect, Layer, Schema } from "effect";
import type { AchievementError } from "@cf-twitch/contracts/achievement";
import { DomainEventType } from "@cf-twitch/contracts/event-bus";
import type { DomainEvent } from "@cf-twitch/contracts/domain-event";
import { EventId } from "@cf-twitch/contracts/identity";
import { achievementsClientLayer } from "../achievements/achievements-client.ts";
import { Achievements } from "../achievements/achievements-service.ts";

/** Subscriber rejected or could not durably accept an Event Bus delivery. */
export class EventHandlerError extends Schema.TaggedError<EventHandlerError>()(
  "EventHandlerError",
  {
    operation: Schema.Literals(["handleDomainEvent"]),
    reason: Schema.Literals(["consumer_unavailable", "consumer_rejected"]),
    eventId: EventId,
    eventType: DomainEventType,
  },
) {
  /** Describes the delivery outcome without the event payload. */
  override get message(): string {
    switch (this.reason) {
      case "consumer_unavailable":
        return `Event subscriber unavailable for ${this.eventType} event ${this.eventId}. The Event Bus keeps the delivery and retries it automatically.`;
      case "consumer_rejected":
        return `Event subscriber rejected ${this.eventType} event ${this.eventId}. Inspect the event in the dead-letter queue, then replay or delete it.`;
    }
  }
}

/** Event consumer that receives Event Bus deliveries for subscribed event types. */
export interface IEventHandler {
  /**
   * Delivers one domain event to its consumer, which deduplicates by event ID.
   *
   * @returns Nothing once the consumer durably accepted the event, or fails with
   * `EventHandlerError` when the consumer is unavailable or rejects the event.
   */
  readonly handleDomainEvent: (event: DomainEvent) => Effect.Effect<void, EventHandlerError>;
}

/** Service for the Event Bus consumer selected by persisted subscription policy. */
export class EventHandler extends Context.Service<EventHandler, IEventHandler>()(
  "@cf-twitch/EventHandler",
) {}

const eventHandlerReason = (reason: AchievementError["reason"]): EventHandlerError["reason"] => {
  switch (reason) {
    case "persistence_unavailable":
    case "transport_unavailable":
      return "consumer_unavailable";
    case "invalid_input":
    case "invalid_stored_data":
    case "invalid_response":
      return "consumer_rejected";
  }
};

/**
 * Creates the event handler that routes deliveries into the idempotent Achievement inbox.
 *
 * @returns The event handler service; constructing it does not fail.
 */
export const makeEventHandler = Effect.gen(function* () {
  const achievements = yield* Achievements;

  return EventHandler.of({
    handleDomainEvent: Effect.fn("EventHandler.handleDomainEvent")(function* (event) {
      yield* achievements.handleEvent(event).pipe(
        Effect.catchTag("AchievementError", (error) =>
          Effect.fail(
            new EventHandlerError({
              operation: "handleDomainEvent",
              reason: eventHandlerReason(error.reason),
              eventId: event.id,
              eventType: event.type,
            }),
          ),
        ),
      );
    }),
  });
});

/** Layer that provides the Achievement-routing event handler and keeps its `Achievements` requirement visible. */
export const eventHandlerLayerWithoutDependencies = Layer.effect(EventHandler, makeEventHandler);

/** Production event handler Layer selecting the Achievements Durable Object client. */
export const eventHandlerLayer = eventHandlerLayerWithoutDependencies.pipe(
  Layer.provide(achievementsClientLayer),
);

/**
 * Layer that provides an always-available consumer which accepts every delivery.
 *
 * **Details**
 *
 * Accepting the same event again is a no-op, matching the Achievement inbox's event ID
 * deduplication. Use a controlled handler instead when a test needs consumer failures.
 */
export const eventHandlerTestLayer = Layer.succeed(
  EventHandler,
  EventHandler.of({ handleDomainEvent: () => Effect.void }),
);
