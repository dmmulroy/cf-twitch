import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { twitchConfigurationLayer } from "../../runtime/twitch-configuration.ts";
import { achievementsClientLayer } from "../achievements/achievements-client.ts";
import { Achievements } from "../achievements/achievements-service.ts";
import { EventBus, eventBusLayer } from "./event-bus.ts";
import { EventBusHttpApi } from "./event-bus-http-api.ts";
import { eventBusHttpHandlersLayer } from "./event-bus-http-handlers.ts";

/** Handlers the Event Bus Durable Object exposes to Alchemy. */
type EventBusServerContract = {
  /** Serves the versioned internal Event Bus HTTP API. */
  readonly fetch: HttpEffect;
  /** Processes due retries and dead-letter expiry when the storage alarm fires. */
  readonly alarm: () => Effect.Effect<void>;
};

/** Durable Object namespace for the Event Bus; the physical `EventBusDO` class name stays stable. */
export class EventBusServer extends Cloudflare.DurableObject<
  EventBusServer,
  EventBusServerContract
>()("EventBusDO") {}

const makeEventBusServer = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const achievements = yield* Achievements;

  return Effect.gen(function* () {
    const eventBus = yield* EventBus;

    const apiLayer = HttpApiBuilder.layer(EventBusHttpApi).pipe(
      Layer.provide(
        eventBusHttpHandlersLayer.pipe(Layer.provide(Layer.succeed(EventBus, eventBus))),
      ),
      Layer.provide(cloudflareHttpServerLayer),
    );

    const fetch = yield* HttpRouter.toHttpEffect(apiLayer);
    yield* eventBus.rebuildAlarm();

    return {
      fetch,
      alarm: () => eventBus.processDue().pipe(Effect.orDie),
    };
  }).pipe(
    // One Event Bus instance serves HTTP and the alarm, so due processing shares one permit.
    Effect.provide(
      eventBusLayer.pipe(
        Layer.provide([
          SqliteClient.layer({ storage: state.raw.storage }),
          Layer.succeed(Cloudflare.DurableObjectState, state),
          Layer.succeed(Achievements, achievements),
        ]),
      ),
    ),
    Effect.orDie,
  );
});

/**
 * Layer that registers `EventBusDO`, capturing `Achievements` during outer initialization.
 *
 * **Details**
 *
 * SQL acquisition, legacy validation, migrations, and alarm reconstruction run only in the
 * Durable Object runtime phase. The outgoing Achievement capability stays visible so scenarios can
 * select a controlled implementation.
 *
 * @throws Dies during Durable Object startup when legacy state is invalid or storage, migration, or
 * alarm reconstruction fails; the alarm handler dies when due processing fails, so the runtime retries it.
 */
export const eventBusServerLayerWithoutDependencies = EventBusServer.make<
  Cloudflare.DurableObjectState | Achievements
>(makeEventBusServer);

/** Ready `EventBusDO` server Layer selecting the production Achievements client. */
export const eventBusServerLayer = eventBusServerLayerWithoutDependencies.pipe(
  Layer.provide(achievementsClientLayer),
  Layer.provide(twitchConfigurationLayer),
);

export default eventBusServerLayer;
