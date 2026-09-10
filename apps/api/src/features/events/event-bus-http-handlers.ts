import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { EventBusAdministration, EventPublisher } from "./event-bus-service.ts";
import { EventBusProcessor } from "./event-bus.ts";
import { EventBusHttpApi } from "./event-bus-http-api.ts";

/** Implements the Event Bus internal HTTP contract through application services. */
export const eventBusHttpHandlersLayer = HttpApiBuilder.group(
  EventBusHttpApi,
  "eventBus",
  (handlers) =>
    Effect.gen(function* () {
      const publisher = yield* EventPublisher;
      const administration = yield* EventBusAdministration;
      const processor = yield* EventBusProcessor;

      return handlers
        .handle("publish", ({ payload }) =>
          publisher.publish(payload).pipe(Effect.as({ success: true as const })),
        )
        .handle("processDue", () =>
          processor.processDue().pipe(Effect.as({ success: true as const })),
        )
        .handle("getStats", () => administration.getStats())
        .handle("getStatus", () => administration.getStatus())
        .handle("listPending", ({ payload }) => administration.listPending(payload))
        .handle("listDeadLetters", ({ payload }) => administration.listDeadLetters(payload))
        .handle("replayDeadLetter", ({ payload }) => administration.replayDeadLetter(payload))
        .handle("retryPending", ({ payload }) =>
          administration.retryPending(payload).pipe(Effect.as({ success: true as const })),
        )
        .handle("deleteDeadLetter", ({ payload }) =>
          administration.deleteDeadLetter(payload).pipe(Effect.as({ success: true as const })),
        )
        .handle("purgeExpiredDeadLetters", () =>
          administration
            .purgeExpiredDeadLetters()
            .pipe(Effect.map((deletedCount) => ({ deletedCount }))),
        )
        .handle("listSubscriptions", () => administration.listSubscriptions())
        .handle("registerSubscription", ({ payload }) =>
          administration.registerSubscription(payload),
        )
        .handle("unregisterSubscription", ({ payload }) =>
          administration
            .unregisterSubscription(payload)
            .pipe(Effect.as({ success: true as const })),
        )
        .handle("reset", () => administration.reset().pipe(Effect.as({ success: true as const })));
    }),
).pipe(Layer.orDie);
