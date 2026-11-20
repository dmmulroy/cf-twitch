import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { HttpApiClient } from "effect/http-api";
import { Context, Effect, Layer, Option } from "effect";
import type { DomainEvent } from "@cf-twitch/contracts/domain-event";
import { EVENT_BUS_SINGLETON_KEY, type EventBusError } from "@cf-twitch/contracts/event-bus";
import { EventBus, eventBusTestLayer } from "./event-bus.ts";
import { translateEventBusClientErrors } from "./event-bus-client.ts";
import { EventBusHttpApi } from "./event-bus-http-api.ts";
import { EventBusServer, eventBusServerLayer } from "./event-bus-server.ts";

/** Durable domain-event publication, accepted independently of immediate consumer availability. */
export interface IEventPublisher {
  /**
   * Accepts a domain event for delivery, deduplicating producer retries by event ID.
   *
   * **Details**
   *
   * Success means the Event Bus durably stored or already delivered the event; a subscriber outage
   * leaves it pending for automatic retry rather than failing the publish.
   *
   * @returns Nothing, or fails with `EventBusError` when the event cannot be encoded or stored, or
   * when the Event Bus cannot be reached and the outcome is unknown. Retrying the same event is safe.
   */
  readonly publish: (event: DomainEvent) => Effect.Effect<void, EventBusError>;
}

/** Service for publishing domain events through the Event Bus singleton. */
export class EventPublisher extends Context.Service<EventPublisher, IEventPublisher>()(
  "@cf-twitch/EventPublisher",
) {}

/**
 * Creates the publisher client for the Event Bus Durable Object.
 *
 * @returns The publisher service; constructing it does not fail.
 */
export const makeEventPublisher = Effect.gen(function* () {
  const namespace = yield* EventBusServer;

  // Each invocation builds its own client; Durable Object stubs never outlive the invocation.
  const client = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(EventBusHttpApi, {
        baseUrl: "http://event-bus.internal",
        httpClient: Cloudflare.toHttpClient(namespace.getByName(EVENT_BUS_SINGLETON_KEY)),
      }),
    ),
  );

  return EventPublisher.of({
    publish: Effect.fn("EventPublisher.publish")(
      function* (event) {
        const http = yield* client;

        // The generated client exposes one overload per union member, so discriminate before calling.
        switch (event.type) {
          case "song_request_success":
            return yield* http.eventBus.publish({ payload: event });
          case "raffle_roll":
            return yield* http.eventBus.publish({ payload: event });
          case "stream_online":
            return yield* http.eventBus.publish({ payload: event });
          case "stream_offline":
            return yield* http.eventBus.publish({ payload: event });
        }
      },
      (request, event) =>
        request.pipe(
          translateEventBusClientErrors("publish", {
            eventId: Option.some(event.id),
            subscriptionId: Option.none(),
          }),
          Effect.asVoid,
        ),
    ),
  });
});

/** Layer that provides the publisher client and keeps its `EventBusServer` namespace and Alchemy execution requirements visible. */
export const eventPublisherLayerWithoutDependencies = Layer.effect(
  EventPublisher,
  makeEventPublisher,
);

/** Production publisher Layer; registers the `EventBusDO` namespace during planning. */
export const eventPublisherLayer = eventPublisherLayerWithoutDependencies.pipe(
  Layer.provide(eventBusServerLayer),
);

/** Layer that publishes into a complete in-memory Event Bus with an always-available subscriber. */
export const eventPublisherTestLayer = Layer.effect(
  EventPublisher,
  Effect.gen(function* () {
    const eventBus = yield* EventBus;

    return EventPublisher.of({ publish: eventBus.publish });
  }),
).pipe(Layer.provide(eventBusTestLayer));
