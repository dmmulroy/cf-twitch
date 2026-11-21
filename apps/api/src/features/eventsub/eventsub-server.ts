import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer, Option } from "effect";
import { EventSubReceiptError } from "@cf-twitch/contracts/eventsub";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import { TwitchService, twitchServiceLayer } from "../providers/twitch-service.ts";
import { EventSubInbox, eventSubInboxLayer } from "./eventsub-inbox.ts";
import { EventSubDispatch, eventSubDispatchLayer } from "./eventsub-dispatch.ts";
import { EventSubHttpApi } from "./eventsub-http-api.ts";
import { eventSubHttpHandlersLayer } from "./eventsub-http-handlers.ts";

interface EventSubServerContract {
  /** Serves the versioned receipt HTTP contract for this message's inbox. */
  readonly fetch: HttpEffect;
  /**
   * Recovers the pending receipt when the Durable Object alarm fires.
   *
   * @throws {EventSubReceiptError} As a defect when recovery fails, so the runtime retries the alarm.
   */
  readonly alarm: () => Effect.Effect<void>;
}

/** Durable Object namespace for the EventSub inbox, preserving its physical class and signed-message-ID object names. */
export class EventSubWebhookServer extends Cloudflare.DurableObject<
  EventSubWebhookServer,
  EventSubServerContract
>()("EventSubWebhookDO") {}

/**
 * Real receipt SQL/HTTP server Layer, leaving dispatch, provider, and analytics selection visible to composition and smoke tests.
 *
 * **Gotchas**
 *
 * Object initialization dies, and the object serves no requests, when legacy `eventsub-receipt` state exists, storage cannot be read, or inbox migrations fail. A failed recovery alarm also dies, so the runtime retries it.
 */
export const eventSubWebhookServerLayerWithoutDependencies = EventSubWebhookServer.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const dispatch = yield* EventSubDispatch;
    const twitch = yield* TwitchService;
    const analytics = yield* TwitchAnalytics;

    return Effect.gen(function* () {
      // Native legacy receipts contain no exact raw-body digest. Never silently adopt them into an empty SQL inbox.
      const legacy = yield* Effect.tryPromise({
        try: () => state.raw.storage.get<unknown>("eventsub-receipt"),
        catch: () =>
          new EventSubReceiptError({
            operation: "legacy-state-gate",
            reason: "storage",
            messageId: Option.none(),
          }),
      }).pipe(Effect.map(Option.fromUndefinedOr));

      if (Option.isSome(legacy))
        return yield* new EventSubReceiptError({
          operation: "legacy-state-gate",
          reason: "legacy_state",
          messageId: Option.none(),
        });

      const inboxLayer = eventSubInboxLayer.pipe(
        Layer.provide([
          Layer.succeed(EventSubDispatch, dispatch),
          Layer.succeed(TwitchService, twitch),
          Layer.succeed(TwitchAnalytics, analytics),
        ]),
      );

      return yield* Effect.gen(function* () {
        const inbox = yield* EventSubInbox;
        yield* inbox.restoreAlarm();

        const httpLayer = HttpApiBuilder.layer(EventSubHttpApi).pipe(
          Layer.provide(
            eventSubHttpHandlersLayer.pipe(Layer.provide(Layer.succeed(EventSubInbox, inbox))),
          ),
          Layer.provide(cloudflareHttpServerLayer),
        );

        const fetch = yield* HttpRouter.toHttpEffect(httpLayer);

        return { fetch, alarm: () => inbox.recover().pipe(Effect.orDie) };
      }).pipe(Effect.provide(inboxLayer));
    }).pipe(Effect.orDie);
  }),
);

/** Production EventSub receipt server Layer with dispatch and provider bindings registered during the outer phase; requires reward configuration and analytics. */
export const eventSubWebhookServerLayer = eventSubWebhookServerLayerWithoutDependencies.pipe(
  Layer.provide([eventSubDispatchLayer, twitchServiceLayer]),
);

/** Production EventSub receipt server, the module's default export for Alchemy namespace registration. */
export default eventSubWebhookServerLayer;
