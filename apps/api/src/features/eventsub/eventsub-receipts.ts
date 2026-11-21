import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Cache, Context, Effect, HashMap, Layer, Option, Ref } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  type AcceptedEventSubReceipt,
  EventSubReceiptConflict,
  EventSubReceiptError,
  type EventSubReceiptOperation,
  type EventSubReceiptStatus,
} from "@cf-twitch/contracts/eventsub";
import type { EventSubMessageId } from "@cf-twitch/contracts/identity";
import { EventSubHttpApi } from "./eventsub-http-api.ts";
import { parseEventSubMessage } from "./eventsub-message.ts";
import eventSubWebhookServerLayer, { EventSubWebhookServer } from "./eventsub-server.ts";

/** Creates `Effect.catchTags` handlers translating receipt HTTP client failures into `EventSubReceiptError` for the identified message. */
const eventSubReceiptClientErrorHandlers = (
  operation: EventSubReceiptOperation,
  messageId: EventSubMessageId,
) => ({
  HttpClientError: () =>
    Effect.fail(
      new EventSubReceiptError({
        operation,
        reason: "transport",
        messageId: Option.some(messageId),
      }),
    ),
  SchemaError: () =>
    Effect.fail(
      new EventSubReceiptError({
        operation,
        reason: "invalid_response",
        messageId: Option.some(messageId),
      }),
    ),
});

/** Durable EventSub receipt acceptance; acceptance acknowledges persisted work, not downstream completion. */
export interface IEventSubReceipts {
  /**
   * Durably accepts an authenticated receipt, or confirms an identical earlier acceptance.
   *
   * @returns Nothing once the receipt is persisted, or fails with `EventSubReceiptConflict` when the message ID was accepted with different content, and `EventSubReceiptError` reason `invalid` for malformed content, `transport`/`invalid_response` when the inbox is unreachable or unreadable, and `storage`/`corrupt`/`schedule`/`legacy_state` from the inbox.
   */
  readonly accept: (
    input: AcceptedEventSubReceipt,
  ) => Effect.Effect<void, EventSubReceiptConflict | EventSubReceiptError>;
  /**
   * Returns the receipt's processing status, or `None` when the message ID was never accepted.
   *
   * @returns The status, or fails with `EventSubReceiptError` reason `transport`/`invalid_response` when the inbox is unreachable or unreadable, and `storage`/`corrupt` from the inbox.
   */
  readonly getReceiptStatus: (
    messageId: EventSubMessageId,
  ) => Effect.Effect<Option.Option<EventSubReceiptStatus>, EventSubReceiptError>;
}

/** Service tag for EventSub receipts, routing every operation by the authenticated message ID. */
export class EventSubReceipts extends Context.Service<EventSubReceipts, IEventSubReceipts>()(
  "@cf-twitch/EventSubReceipts",
) {}

/** Effect that builds receipt clients with execution-scoped cache ownership, never globally cached Durable Object stubs. */
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

  const accept = Effect.fn("EventSubReceipts.accept")(function* (receipt: AcceptedEventSubReceipt) {
    yield* Effect.gen(function* () {
      const client = yield* clientFor(receipt.messageId);
      yield* client.receipts.accept({ payload: receipt });
    }).pipe(Effect.catchTags(eventSubReceiptClientErrorHandlers("accept", receipt.messageId)));
  });

  const getReceiptStatus = Effect.fn("EventSubReceipts.getReceiptStatus")(function* (
    messageId: EventSubMessageId,
  ) {
    return yield* Effect.gen(function* () {
      const client = yield* clientFor(messageId);

      return yield* client.receipts.getReceiptStatus();
    }).pipe(Effect.catchTags(eventSubReceiptClientErrorHandlers("get-status", messageId)));
  });

  return EventSubReceipts.of({ accept, getReceiptStatus });
});

/** Layer that provides receipt clients; requires the EventSub webhook Durable Object namespace. */
export const eventSubReceiptsLayerWithoutDependencies = Layer.effect(
  EventSubReceipts,
  makeEventSubReceipts,
);

/** Production receipt clients, registering the complete EventSub durable dispatch graph. */
export const eventSubReceiptsLayer = eventSubReceiptsLayerWithoutDependencies.pipe(
  Layer.provide(eventSubWebhookServerLayer),
);

/**
 * Layer that provides in-memory receipt acceptance keyed by message ID.
 *
 * **Details**
 *
 * Applies the inbox's acceptance rules: the message ID must match its header, content must parse, and a reused message ID with a different digest, message type, or subscription type/version conflicts. Accepted receipts stay `pending`, because nothing is dispatched.
 */
export const eventSubReceiptsTestLayer = Layer.effect(
  EventSubReceipts,
  Effect.gen(function* () {
    const receipts = yield* Ref.make(HashMap.empty<EventSubMessageId, AcceptedEventSubReceipt>());

    const accept = Effect.fn("EventSubReceiptsTest.accept")(function* (
      receipt: AcceptedEventSubReceipt,
    ) {
      if (receipt.messageId !== receipt.headers["twitch-eventsub-message-id"])
        return yield* new EventSubReceiptError({
          operation: "accept",
          reason: "invalid",
          messageId: Option.some(receipt.messageId),
        });
      yield* parseEventSubMessage(receipt.headers, receipt.body);
      const existing = HashMap.get(yield* Ref.get(receipts), receipt.messageId);

      if (Option.isNone(existing)) {
        yield* Ref.update(receipts, HashMap.set(receipt.messageId, receipt));

        return;
      }

      const previous = existing.value;

      if (
        previous.contentDigest !== receipt.contentDigest ||
        previous.headers["twitch-eventsub-message-type"] !==
          receipt.headers["twitch-eventsub-message-type"] ||
        previous.headers["twitch-eventsub-subscription-type"] !==
          receipt.headers["twitch-eventsub-subscription-type"] ||
        previous.headers["twitch-eventsub-subscription-version"] !==
          receipt.headers["twitch-eventsub-subscription-version"]
      )
        return yield* new EventSubReceiptConflict({
          operation: "accept",
          reason: "content_mismatch",
          messageId: receipt.messageId,
        });
    });

    return EventSubReceipts.of({
      accept,
      getReceiptStatus: (messageId) =>
        Ref.get(receipts).pipe(
          Effect.map((current) =>
            Option.map(HashMap.get(current, messageId), (): EventSubReceiptStatus => ({
              status: "pending",
              attempts: 0,
              lastError: Option.none(),
              chatCommandDelivery: Option.none(),
            })),
          ),
        ),
    });
  }),
);
