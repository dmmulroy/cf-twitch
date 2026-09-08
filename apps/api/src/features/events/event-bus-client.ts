import * as Cloudflare from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Context, Effect, Layer, Option, type Schema } from "effect";
import type { HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { EVENT_BUS_SINGLETON_KEY, EventBusError } from "@cf-twitch/contracts/event-bus";
import { EventBusHttpApi } from "./event-bus-http-api.ts";
import eventBusServerLayer, { EventBusServer } from "./event-bus-server.ts";
import {
  EventBusAdministration,
  EventPublisher,
  type IEventBusAdministration,
  type IEventPublisher,
} from "./event-bus-service.ts";

const clientError = (
  operation: EventBusError["operation"],
  reason: "invalid_response" | "persistence_unavailable",
) =>
  new EventBusError({
    operation,
    reason,
    eventId: Option.none(),
  });

const mapClientErrors = <A>(
  operation: EventBusError["operation"],
  effect: Effect.Effect<A, EventBusError | HttpClientError.HttpClientError | Schema.SchemaError>,
): Effect.Effect<A, EventBusError> =>
  effect.pipe(
    Effect.catchTags({
      EventBusError: (error) => Effect.fail(error),
      HttpClientError: () => Effect.fail(clientError(operation, "persistence_unavailable")),
      SchemaError: () => Effect.fail(clientError(operation, "invalid_response")),
    }),
  );

/** Construct invocation-scoped Event Bus clients without retaining Durable Object stubs. */
export const makeEventBusClient: Effect.Effect<
  { readonly publisher: IEventPublisher; readonly administration: IEventBusAdministration },
  never,
  Cloudflare.Worker | EventBusServer
> = Effect.gen(function* () {
  const namespace = yield* EventBusServer;
  const memoizedClient = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(EventBusHttpApi, {
        baseUrl: "http://event-bus.internal",
        httpClient: Cloudflare.toHttpClient(namespace.getByName(EVENT_BUS_SINGLETON_KEY)),
      }),
    ),
  );
  const client = memoizedClient;

  const publisher: IEventPublisher = {
    publish: Effect.fn("EventBusClient.publish")(function* (event) {
      const http = yield* client;
      const request = (() => {
        switch (event.type) {
          case "song_request_success":
            return http.eventBus.publish({ payload: event });
          case "raffle_roll":
            return http.eventBus.publish({ payload: event });
          case "stream_online":
            return http.eventBus.publish({ payload: event });
          case "stream_offline":
            return http.eventBus.publish({ payload: event });
        }
      })();
      yield* mapClientErrors("publish", request);
    }),
  };

  const administration: IEventBusAdministration = {
    getStats: () =>
      Effect.flatMap(client, (http) => mapClientErrors("getStats", http.eventBus.getStats())),
    getStatus: () =>
      Effect.flatMap(client, (http) => mapClientErrors("getStatus", http.eventBus.getStatus())),
    listPending: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("listPending", http.eventBus.listPending({ payload: input })),
      ),
    listDeadLetters: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("listDeadLetters", http.eventBus.listDeadLetters({ payload: input })),
      ),
    replayDeadLetter: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("replayDeadLetter", http.eventBus.replayDeadLetter({ payload: input })),
      ),
    retryPending: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("retryPending", http.eventBus.retryPending({ payload: input })).pipe(
          Effect.asVoid,
        ),
      ),
    deleteDeadLetter: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors(
          "deleteDeadLetter",
          http.eventBus.deleteDeadLetter({ payload: input }),
        ).pipe(Effect.asVoid),
      ),
    purgeExpiredDeadLetters: () =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("purgeExpiredDeadLetters", http.eventBus.purgeExpiredDeadLetters()).pipe(
          Effect.map((result) => result.deletedCount),
        ),
      ),
    listSubscriptions: () =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("listSubscriptions", http.eventBus.listSubscriptions()),
      ),
    registerSubscription: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors(
          "registerSubscription",
          http.eventBus.registerSubscription({ payload: input }),
        ),
      ),
    unregisterSubscription: (input) =>
      Effect.flatMap(client, (http) =>
        mapClientErrors(
          "unregisterSubscription",
          http.eventBus.unregisterSubscription({ payload: input }),
        ).pipe(Effect.asVoid),
      ),
    reset: () =>
      Effect.flatMap(client, (http) =>
        mapClientErrors("reset", http.eventBus.reset()).pipe(Effect.asVoid),
      ),
  };

  return { publisher, administration };
});

const eventBusClientLayerWithoutDependencies = Layer.effectContext(
  Effect.gen(function* () {
    const services = yield* makeEventBusClient;
    return Context.make(EventPublisher, EventPublisher.of(services.publisher)).pipe(
      Context.add(EventBusAdministration, EventBusAdministration.of(services.administration)),
    );
  }),
);

/** Event Publisher HTTP client Layer with its EventBusDO binding requirement visible. */
export const eventPublisherLayerWithoutDependencies = eventBusClientLayerWithoutDependencies;

/** Event Bus administration HTTP client Layer sharing one invocation-scoped acquisition. */
export const eventBusAdministrationLayerWithoutDependencies =
  eventBusClientLayerWithoutDependencies;

const eventBusClientLayer = eventBusClientLayerWithoutDependencies.pipe(
  Layer.provide(eventBusServerLayer),
);

/** Production event publication client Layer selecting the EventBusServer binding. */
export const eventPublisherLayer = eventBusClientLayer;

/** Production Event Bus administration client Layer selecting the singleton binding. */
export const eventBusAdministrationLayer = eventBusClientLayer;
