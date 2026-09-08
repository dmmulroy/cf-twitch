import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { EventBusError } from "@cf-twitch/contracts/event-bus";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { twitchConfigurationLayer } from "../../runtime/twitch-configuration.ts";
import { achievementsClientLayer } from "../achievements/achievements-client.ts";
import { Achievements } from "../achievements/achievements-service.ts";
import { achievementEventHandlerLayer } from "./achievement-event-handler.ts";
import { EventHandler } from "./event-bus-service.ts";
import { eventBusDatabaseLayerWithoutDependencies } from "./event-bus-database.ts";
import { EventBusHttpApi } from "./event-bus-http-api.ts";
import { eventBusHttpHandlersLayer } from "./event-bus-http-handlers.ts";
import { EventBusAlarm, EventBusProcessor, eventBusLayerWithoutDependencies } from "./event-bus.ts";

type EventBusServerContract = {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
};

/** Namespace service for the preserved physical EventBusDO class. */
export class EventBusServer extends Cloudflare.DurableObject<
  EventBusServer,
  EventBusServerContract
>()("EventBusDO") {}

const alarmFailure = () =>
  new EventBusError({
    operation: "retryDue",
    reason: "persistence_unavailable",
    eventId: Option.none(),
  });

const makeEventBusServer = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const eventHandler = yield* EventHandler;
  const alarmLayer = Layer.succeed(
    EventBusAlarm,
    EventBusAlarm.of({
      scheduleAt: (timestamp) =>
        Effect.tryPromise({
          try: () => state.raw.storage.setAlarm(new Date(timestamp)),
          catch: alarmFailure,
        }),
      clear: () =>
        Effect.tryPromise({
          try: () => state.raw.storage.deleteAlarm(),
          catch: alarmFailure,
        }),
    }),
  );
  const databaseLayer = eventBusDatabaseLayerWithoutDependencies.pipe(
    Layer.provide(SqliteClient.layer({ storage: state.raw.storage })),
  );
  const eventBusLayer = eventBusLayerWithoutDependencies.pipe(
    Layer.provide(databaseLayer),
    Layer.provide(alarmLayer),
    Layer.provide(Layer.succeed(EventHandler, eventHandler)),
  );
  const handlersLayer = eventBusHttpHandlersLayer.pipe(Layer.provide(eventBusLayer));

  return Effect.gen(function* () {
    const apiLayer = HttpApiBuilder.layer(EventBusHttpApi).pipe(
      Layer.provide(handlersLayer),
      Layer.provide(cloudflareHttpServerLayer),
    );
    const fetch = yield* HttpRouter.toHttpEffect(apiLayer);
    const processor = yield* EventBusProcessor;
    yield* processor.rebuildAlarm();
    return {
      fetch,
      alarm: () => processor.processDue().pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(eventBusLayer), Effect.orDie);
});

/** Hosts EventBusDO while leaving its outgoing Achievement capability visible to scenarios. */
export const eventBusServerLayerWithoutDependencies = EventBusServer.make<Achievements>(
  makeEventBusServer.pipe(Effect.provide(achievementEventHandlerLayer), Effect.orDie),
);

/** Ready Event Bus server selects the production Achievement client graph. */
export const eventBusServerLayer = eventBusServerLayerWithoutDependencies.pipe(
  Layer.provide(achievementsClientLayer),
  Layer.provide(twitchConfigurationLayer),
);

export default eventBusServerLayer;
