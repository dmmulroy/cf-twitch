import * as Cloudflare from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Cache, Effect, Layer } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { EventSubReceiptError, type AcceptedEventSubReceipt } from "@cf-twitch/contracts/eventsub";
import type { EventSubMessageId } from "@cf-twitch/contracts/identity";
import { EventSubReceipts } from "./eventsub-receipts.ts";
import { EventSubHttpApi } from "./eventsub-http-api.ts";
import eventSubWebhookServerLayer, { EventSubWebhookServer } from "./eventsub-server.ts";

/** Construct receipt clients with execution-scoped cache ownership, never globally cached DO stubs. */
export const makeEventSubReceipts = Effect.gen(function* () {
  const namespace = yield* EventSubWebhookServer;

  const clients = yield* makeExecutionMemo(
    Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (messageId: EventSubMessageId) =>
        Effect.suspend(() =>
          HttpApiClient.makeWith(EventSubHttpApi, {
            baseUrl: "http://eventsub.internal",
            httpClient: Cloudflare.toHttpClient(namespace.getByName(messageId)),
          }),
        ),
    }),
  );

  const clientFor = (messageId: EventSubMessageId) =>
    clients.pipe(Effect.flatMap((cache) => Cache.get(cache, messageId)));

  const accept = Effect.fn("EventSubReceipts.accept")(
    function* (receipt: AcceptedEventSubReceipt) {
      const client = yield* clientFor(receipt.messageId);
      yield* client.receipts.accept({ payload: receipt });
    },
    Effect.catchTags({
      HttpClientError: () =>
        Effect.fail(
          new EventSubReceiptError({
            operation: "accept",
            reason: "transport",
          }),
        ),
      SchemaError: () =>
        Effect.fail(
          new EventSubReceiptError({
            operation: "accept",
            reason: "invalid_response",
          }),
        ),
    }),
  );

  const getReceiptStatus = Effect.fn("EventSubReceipts.getReceiptStatus")(
    function* (messageId: EventSubMessageId) {
      const client = yield* clientFor(messageId);

      return yield* client.receipts.getReceiptStatus();
    },
    Effect.catchTags({
      HttpClientError: () =>
        Effect.fail(
          new EventSubReceiptError({
            operation: "get-status",
            reason: "transport",
          }),
        ),
      SchemaError: () =>
        Effect.fail(
          new EventSubReceiptError({
            operation: "get-status",
            reason: "invalid_response",
          }),
        ),
    }),
  );

  return EventSubReceipts.of({ accept, getReceiptStatus });
});

/** Receipt client leaves the physical namespace implementation selectable for real HTTP tests. */
export const eventSubReceiptsLayerWithoutDependencies = Layer.effect(
  EventSubReceipts,
  makeEventSubReceipts,
);

/** Production receipt client includes the complete EventSub durable dispatch graph. */
export const eventSubReceiptsLayer = eventSubReceiptsLayerWithoutDependencies.pipe(
  Layer.provide(eventSubWebhookServerLayer),
);
