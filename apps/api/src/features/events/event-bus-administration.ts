import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { HttpApiClient } from "effect/http-api";
import { Context, Effect, Layer, Option } from "effect";
import {
  EVENT_BUS_SINGLETON_KEY,
  type DeadLetterEventList,
  type DeadLetterReplayResult,
  type EventBusError,
  type EventBusPageInput,
  type EventBusStats,
  type EventBusStatus,
  type EventBusSubscription,
  type EventBusSubscriptionId,
  type PendingEventList,
  type RegisterEventBusSubscriptionInput,
} from "@cf-twitch/contracts/event-bus";
import type { EventId } from "@cf-twitch/contracts/identity";
import { EventBus, eventBusTestLayer } from "./event-bus.ts";
import { translateEventBusClientErrors } from "./event-bus-client.ts";
import { EventBusHttpApi } from "./event-bus-http-api.ts";
import { EventBusServer, eventBusServerLayer } from "./event-bus-server.ts";

/** Operational access to pending, dead-letter, receipt, and subscription evidence. */
export interface IEventBusAdministration {
  /**
   * Returns counts of pending, dead-lettered, delivered, and subscription rows.
   *
   * @returns The counts, or fails with `EventBusError` when storage or the Event Bus is unavailable.
   */
  readonly getStats: () => Effect.Effect<EventBusStats, EventBusError>;
  /**
   * Returns the next retry and dead-letter expiry times together with the counts.
   *
   * @returns The status, or fails with `EventBusError` when storage or the Event Bus is unavailable.
   */
  readonly getStatus: () => Effect.Effect<EventBusStatus, EventBusError>;
  /**
   * Returns a page of pending deliveries, newest first; unreadable stored events appear as `Option.none()`.
   *
   * @returns The page, or fails with `EventBusError` when storage or the Event Bus is unavailable.
   */
  readonly listPending: (
    input: EventBusPageInput,
  ) => Effect.Effect<PendingEventList, EventBusError>;
  /**
   * Returns a page of dead-lettered deliveries, most recently failed first.
   *
   * @returns The page, or fails with `EventBusError` when storage or the Event Bus is unavailable.
   */
  readonly listDeadLetters: (
    input: EventBusPageInput,
  ) => Effect.Effect<DeadLetterEventList, EventBusError>;
  /**
   * Delivers one dead-lettered event again and records the outcome.
   *
   * @returns Whether delivery succeeded; a subscriber failure is a `success: false` result, not an
   * error. Fails with `EventBusError` (`event_not_found`) when the event is not dead-lettered,
   * `stored_event_invalid` when it cannot be read, and an unavailable reason when storage or the
   * Event Bus cannot be reached.
   */
  readonly replayDeadLetter: (input: {
    readonly eventId: EventId;
  }) => Effect.Effect<DeadLetterReplayResult, EventBusError>;
  /**
   * Makes one pending delivery due now and processes every due delivery.
   *
   * @returns Nothing, or fails with `EventBusError` (`event_not_found`) when the event is not
   * pending, and an unavailable reason when storage, the alarm, or the Event Bus cannot be reached.
   */
  readonly retryPending: (input: {
    readonly eventId: EventId;
  }) => Effect.Effect<void, EventBusError>;
  /**
   * Deletes one dead-lettered delivery.
   *
   * @returns Nothing, or fails with `EventBusError` (`event_not_found`) when the event is not
   * dead-lettered, and an unavailable reason when storage or the Event Bus cannot be reached.
   */
  readonly deleteDeadLetter: (input: {
    readonly eventId: EventId;
  }) => Effect.Effect<void, EventBusError>;
  /**
   * Deletes dead-lettered deliveries whose 30-day retention has expired.
   *
   * @returns The number deleted, or fails with `EventBusError` when storage or the Event Bus is unavailable.
   */
  readonly purgeExpiredDeadLetters: () => Effect.Effect<number, EventBusError>;
  /**
   * Returns every subscription, ordered by subscriber and event type.
   *
   * @returns The subscriptions, or fails with `EventBusError` when storage or the Event Bus is unavailable.
   */
  readonly listSubscriptions: () => Effect.Effect<
    ReadonlyArray<EventBusSubscription>,
    EventBusError
  >;
  /**
   * Subscribes a subscriber to event types; existing subscriptions are kept unchanged.
   *
   * @returns The subscriber's subscriptions, or fails with `EventBusError` when storage or the Event Bus is unavailable.
   */
  readonly registerSubscription: (
    input: RegisterEventBusSubscriptionInput,
  ) => Effect.Effect<ReadonlyArray<EventBusSubscription>, EventBusError>;
  /**
   * Removes one subscription.
   *
   * @returns Nothing, or fails with `EventBusError` (`subscription_not_found`) when it does not
   * exist, and an unavailable reason when storage or the Event Bus cannot be reached.
   */
  readonly unregisterSubscription: (input: {
    readonly subscriptionId: EventBusSubscriptionId;
  }) => Effect.Effect<void, EventBusError>;
  /**
   * Deletes pending, dead-lettered, and delivered rows and clears the alarm; subscriptions remain.
   *
   * @returns Nothing, or fails with `EventBusError` when storage, the alarm, or the Event Bus is unavailable.
   */
  readonly reset: () => Effect.Effect<void, EventBusError>;
}

/** Service for administering the Event Bus singleton. */
export class EventBusAdministration extends Context.Service<
  EventBusAdministration,
  IEventBusAdministration
>()("@cf-twitch/EventBusAdministration") {}

const forEvent = (eventId: EventId) => ({
  eventId: Option.some(eventId),
  subscriptionId: Option.none(),
});

/**
 * Creates the administration client for the Event Bus Durable Object.
 *
 * @returns The administration service; constructing it does not fail.
 */
export const makeEventBusAdministration = Effect.gen(function* () {
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

  return EventBusAdministration.of({
    getStats: Effect.fn("EventBusAdministration.getStats")(function* () {
      return yield* (yield* client).eventBus.getStats();
    }, translateEventBusClientErrors("getStats")),
    getStatus: Effect.fn("EventBusAdministration.getStatus")(function* () {
      return yield* (yield* client).eventBus.getStatus();
    }, translateEventBusClientErrors("getStatus")),
    listPending: Effect.fn("EventBusAdministration.listPending")(function* (input) {
      return yield* (yield* client).eventBus.listPending({ payload: input });
    }, translateEventBusClientErrors("listPending")),
    listDeadLetters: Effect.fn("EventBusAdministration.listDeadLetters")(function* (input) {
      return yield* (yield* client).eventBus.listDeadLetters({ payload: input });
    }, translateEventBusClientErrors("listDeadLetters")),
    replayDeadLetter: Effect.fn("EventBusAdministration.replayDeadLetter")(
      function* (input) {
        return yield* (yield* client).eventBus.replayDeadLetter({ payload: input });
      },
      (request, input) =>
        request.pipe(translateEventBusClientErrors("replayDeadLetter", forEvent(input.eventId))),
    ),
    retryPending: Effect.fn("EventBusAdministration.retryPending")(
      function* (input) {
        yield* (yield* client).eventBus.retryPending({ payload: input });
      },
      (request, input) =>
        request.pipe(translateEventBusClientErrors("retryPending", forEvent(input.eventId))),
    ),
    deleteDeadLetter: Effect.fn("EventBusAdministration.deleteDeadLetter")(
      function* (input) {
        yield* (yield* client).eventBus.deleteDeadLetter({ payload: input });
      },
      (request, input) =>
        request.pipe(translateEventBusClientErrors("deleteDeadLetter", forEvent(input.eventId))),
    ),
    purgeExpiredDeadLetters: Effect.fn("EventBusAdministration.purgeExpiredDeadLetters")(
      function* () {
        return (yield* (yield* client).eventBus.purgeExpiredDeadLetters()).deletedCount;
      },
      translateEventBusClientErrors("purgeExpiredDeadLetters"),
    ),
    listSubscriptions: Effect.fn("EventBusAdministration.listSubscriptions")(function* () {
      return yield* (yield* client).eventBus.listSubscriptions();
    }, translateEventBusClientErrors("listSubscriptions")),
    registerSubscription: Effect.fn("EventBusAdministration.registerSubscription")(function* (
      input,
    ) {
      return yield* (yield* client).eventBus.registerSubscription({ payload: input });
    }, translateEventBusClientErrors("registerSubscription")),
    unregisterSubscription: Effect.fn("EventBusAdministration.unregisterSubscription")(
      function* (input) {
        yield* (yield* client).eventBus.unregisterSubscription({ payload: input });
      },
      (request, input) =>
        request.pipe(
          translateEventBusClientErrors("unregisterSubscription", {
            eventId: Option.none(),
            subscriptionId: Option.some(input.subscriptionId),
          }),
        ),
    ),
    reset: Effect.fn("EventBusAdministration.reset")(function* () {
      yield* (yield* client).eventBus.reset();
    }, translateEventBusClientErrors("reset")),
  });
});

/** Layer that provides the administration client and keeps its `EventBusServer` namespace and Alchemy execution requirements visible. */
export const eventBusAdministrationLayerWithoutDependencies = Layer.effect(
  EventBusAdministration,
  makeEventBusAdministration,
);

/** Production administration Layer; registers the `EventBusDO` namespace during planning. */
export const eventBusAdministrationLayer = eventBusAdministrationLayerWithoutDependencies.pipe(
  Layer.provide(eventBusServerLayer),
);

/** Layer that administers a complete in-memory Event Bus with an always-available subscriber. */
export const eventBusAdministrationTestLayer = Layer.effect(
  EventBusAdministration,
  Effect.gen(function* () {
    const eventBus = yield* EventBus;

    return EventBusAdministration.of({
      getStats: eventBus.getStats,
      getStatus: eventBus.getStatus,
      listPending: eventBus.listPending,
      listDeadLetters: eventBus.listDeadLetters,
      replayDeadLetter: eventBus.replayDeadLetter,
      retryPending: eventBus.retryPending,
      deleteDeadLetter: eventBus.deleteDeadLetter,
      purgeExpiredDeadLetters: eventBus.purgeExpiredDeadLetters,
      listSubscriptions: eventBus.listSubscriptions,
      registerSubscription: eventBus.registerSubscription,
      unregisterSubscription: eventBus.unregisterSubscription,
      reset: eventBus.reset,
    });
  }),
).pipe(Layer.provide(eventBusTestLayer));
