import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { StreamLifecycleClient } from "./stream-lifecycle.ts";
import { StreamLifecycleHttpApi } from "./stream-http-api.ts";

/** Implements Stream Lifecycle internal HTTP operations through the local service. */
export const streamLifecycleHttpHandlersLayer = HttpApiBuilder.group(
  StreamLifecycleHttpApi,
  "streamLifecycle",
  (handlers) =>
    Effect.gen(function* () {
      const stream = yield* StreamLifecycleClient;
      return handlers
        .handle("getState", () => stream.getState())
        .handle("markOnline", ({ payload }) => stream.markOnline(payload))
        .handle("markOffline", ({ payload }) => stream.markOffline(payload))
        .handle("recordViewerCount", ({ payload }) =>
          stream.recordViewerCount(payload).pipe(Effect.as({ success: true as const })),
        )
        .handle("getViewerHistory", ({ payload }) => stream.getViewerHistory(payload))
        .handle("reconcile", ({ payload }) => stream.reconcile(payload))
        .handle("getStatus", () => stream.getStatus())
        .handle("getDebugState", () => stream.getDebugState())
        .handle("reset", () => stream.reset().pipe(Effect.as({ success: true as const })));
    }),
).pipe(Layer.orDie);
