import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { EventSubReceiptError } from "@cf-twitch/contracts/eventsub";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { WorkflowStarters } from "../workflows/workflow-starters.ts";
import { workflowStartersLayer } from "../workflows/workflow-client.ts";
import { workflowAlarmLayer } from "../workflows/workflow-alarm.ts";
import { TwitchService, twitchServiceLayer } from "../providers/twitch-service.ts";
import { StreamLifecycleClient } from "../stream/stream-lifecycle.ts";
import { streamLifecycleClientLayer } from "../stream/stream-lifecycle-client.ts";
import { ChatCommandExecutor, executorLayer } from "../commands/chat-command-executor.ts";
import { EventSubInbox, eventSubInboxLayerWithoutDependencies } from "./eventsub-inbox.ts";
import { eventSubDispatchLayerWithoutDependencies } from "./eventsub-dispatch.ts";
import { EventSubHttpApi } from "./eventsub-http-api.ts";
import { eventSubHttpHandlersLayer } from "./eventsub-http-handlers.ts";

interface EventSubServerContract {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
}

/** EventSub inbox preserves its physical namespace class and signed-message-id object names. */
export class EventSubWebhookServer extends Cloudflare.DurableObject<
  EventSubWebhookServer,
  EventSubServerContract
>()("EventSubWebhookDO") {}

/** Real receipt SQL/HTTP server with downstream authority selection visible to composition and smoke tests. */
export const eventSubWebhookServerLayerWithoutDependencies = EventSubWebhookServer.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const workflows = yield* WorkflowStarters;
    const twitch = yield* TwitchService;
    const stream = yield* StreamLifecycleClient;
    const commands = yield* ChatCommandExecutor;
    const configuration = yield* TwitchConfiguration;
    const analytics = yield* TwitchAnalytics;

    return Effect.gen(function* () {
      // Native legacy receipts contain no exact raw-body digest. Never silently adopt them into an empty SQL inbox.
      const legacy = yield* Effect.tryPromise({
        try: () => state.raw.storage.get<unknown>("eventsub-receipt"),
        catch: () =>
          new EventSubReceiptError({
            operation: "legacy-state-gate",
            reason: "storage",
          }),
      });

      if (legacy !== undefined)
        return yield* new EventSubReceiptError({
          operation: "legacy-state-gate",
          reason: "corrupt",
        });

      const dispatchLayer = eventSubDispatchLayerWithoutDependencies.pipe(
        Layer.provide([
          Layer.succeed(WorkflowStarters, workflows),
          Layer.succeed(StreamLifecycleClient, stream),
          Layer.succeed(ChatCommandExecutor, commands),
          Layer.succeed(TwitchConfiguration, configuration),
        ]),
      );

      const inboxLayer = eventSubInboxLayerWithoutDependencies.pipe(
        Layer.provide([
          dispatchLayer,
          Layer.succeed(TwitchService, twitch),
          Layer.succeed(TwitchAnalytics, analytics),
          workflowAlarmLayer,
          SqliteClient.layer({ storage: state.raw.storage }),
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

/** Ready EventSub receipt server registers real dependency bindings during the outer phase. */
export const eventSubWebhookServerLayer = eventSubWebhookServerLayerWithoutDependencies.pipe(
  Layer.provide([
    workflowStartersLayer,
    twitchServiceLayer,
    streamLifecycleClientLayer,
    executorLayer,
  ]),
);

export default eventSubWebhookServerLayer;
