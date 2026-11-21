import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Effect, Option, Schema } from "effect";
import { AcceptedEventSubReceipt } from "@cf-twitch/contracts/eventsub";
import { EventSubReceipts, eventSubReceiptsTestLayer } from "./eventsub-receipts.ts";

const receipt = Schema.decodeUnknownSync(AcceptedEventSubReceipt)({
  messageId: "message-1",
  receivedAt: "2026-01-01T00:00:00Z",
  contentDigest: "a".repeat(64),
  correlation: { traceId: "trace-1", requestId: "request-1" },
  headers: {
    "twitch-eventsub-message-id": "message-1",
    "twitch-eventsub-message-timestamp": "2026-01-01T00:00:00Z",
    "twitch-eventsub-message-type": "notification",
    "twitch-eventsub-message-retry": "0",
    "twitch-eventsub-message-signature": `sha256=${"a".repeat(64)}`,
    "twitch-eventsub-subscription-type": "unknown.subscription",
    "twitch-eventsub-subscription-version": "1",
  },
  body: {
    subscription: {
      id: "subscription",
      type: "unknown.subscription",
      version: "1",
      status: "enabled",
      cost: 0,
      condition: {},
      transport: { method: "webhook" },
      created_at: "2026-01-01T00:00:00Z",
    },
    event: {},
  },
});

describe("eventSubReceiptsTestLayer honors the durable inbox acceptance contract", () => {
  it.effect("deduplicates identical redelivery and ignores retry and correlation metadata", () =>
    Effect.gen(function* () {
      const receipts = yield* EventSubReceipts;

      expect(yield* receipts.getReceiptStatus(receipt.messageId)).toEqual(Option.none());
      yield* receipts.accept(receipt);
      yield* receipts.accept({
        ...receipt,
        headers: { ...receipt.headers, "twitch-eventsub-message-retry": "1" },
        correlation: { traceId: "trace-2", requestId: "request-2" },
      });

      expect(yield* receipts.getReceiptStatus(receipt.messageId)).toMatchObject({
        value: { status: "pending", attempts: 0 },
      });
    }).pipe(Effect.provide(eventSubReceiptsTestLayer)),
  );

  it.effect("rejects a reused message ID with different signed content", () =>
    Effect.gen(function* () {
      const receipts = yield* EventSubReceipts;
      yield* receipts.accept(receipt);

      const reused = yield* receipts
        .accept({ ...receipt, contentDigest: "b".repeat(64) })
        .pipe(Effect.result);

      expect(reused).toHaveProperty("failure._tag", "EventSubReceiptConflict");
      expect(reused).toMatchObject({ failure: { reason: "content_mismatch" } });
    }).pipe(Effect.provide(eventSubReceiptsTestLayer)),
  );

  it.effect("rejects a receipt whose message ID disagrees with its signed header", () =>
    Effect.gen(function* () {
      const receipts = yield* EventSubReceipts;

      const mismatched = yield* receipts
        .accept({
          ...receipt,
          headers: { ...receipt.headers, "twitch-eventsub-message-id": receipt.messageId },
          messageId: Schema.decodeUnknownSync(AcceptedEventSubReceipt.fields.messageId)(
            "message-2",
          ),
        })
        .pipe(Effect.result);

      expect(mismatched).toHaveProperty("failure._tag", "EventSubReceiptError");
      expect(mismatched).toMatchObject({ failure: { reason: "invalid" } });
      expect(
        yield* receipts.getReceiptStatus(
          Schema.decodeUnknownSync(AcceptedEventSubReceipt.fields.messageId)("message-2"),
        ),
      ).toEqual(Option.none());
    }).pipe(Effect.provide(eventSubReceiptsTestLayer)),
  );
});
