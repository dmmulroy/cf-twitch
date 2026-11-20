import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { EventBus } from "./event-bus.ts";
import { EventBusHttpApi } from "./event-bus-http-api.ts";

/**
 * Layer that implements the internal Event Bus HTTP API by delegating each endpoint to `EventBus`.
 *
 * **Details**
 *
 * Failures are returned as the typed `EventBusError` declared by every endpoint.
 */
export const eventBusHttpHandlersLayer = HttpApiBuilder.group(
  EventBusHttpApi,
  "eventBus",
  (handlers) =>
    Effect.gen(function* () {
      const eventBus = yield* EventBus;

      return handlers
        .handle("publish", ({ payload }) =>
          eventBus.publish(payload).pipe(Effect.as({ success: true as const })),
        )
        .handle("processDue", () =>
          eventBus.processDue().pipe(Effect.as({ success: true as const })),
        )
        .handle("getStats", () => eventBus.getStats())
        .handle("getStatus", () => eventBus.getStatus())
        .handle("listPending", ({ payload }) => eventBus.listPending(payload))
        .handle("listDeadLetters", ({ payload }) => eventBus.listDeadLetters(payload))
        .handle("replayDeadLetter", ({ payload }) => eventBus.replayDeadLetter(payload))
        .handle("retryPending", ({ payload }) =>
          eventBus.retryPending(payload).pipe(Effect.as({ success: true as const })),
        )
        .handle("deleteDeadLetter", ({ payload }) =>
          eventBus.deleteDeadLetter(payload).pipe(Effect.as({ success: true as const })),
        )
        .handle("purgeExpiredDeadLetters", () =>
          eventBus.purgeExpiredDeadLetters().pipe(Effect.map((deletedCount) => ({ deletedCount }))),
        )
        .handle("listSubscriptions", () => eventBus.listSubscriptions())
        .handle("registerSubscription", ({ payload }) => eventBus.registerSubscription(payload))
        .handle("unregisterSubscription", ({ payload }) =>
          eventBus.unregisterSubscription(payload).pipe(Effect.as({ success: true as const })),
        )
        .handle("reset", () => eventBus.reset().pipe(Effect.as({ success: true as const })));
    }),
).pipe(Layer.orDie);
