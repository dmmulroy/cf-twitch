import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter } from "effect/unstable/http";
import {
  EventSubReceiptConflict,
  type AcceptedEventSubReceipt,
} from "@cf-twitch/contracts/eventsub";
import { httpTestConfiguration as configuration } from "./http-test-fixtures.ts";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { EventSubReceipts } from "../eventsub/eventsub-receipts.ts";
import { TwitchService, type ITwitchService } from "../providers/twitch-service.ts";
import { ProviderError, type ProviderEventSubSubscription } from "@cf-twitch/contracts/provider";
import { TwitchEventSubApi } from "@cf-twitch/contracts/twitch-api";
import { twitchEventSubHandlersLayer } from "./twitch-eventsub-handlers.ts";
import { twitchHttpCorrelationLayer } from "./http-request-correlation.ts";

const eventSubApi = HttpApi.make("TwitchHttpApi").add(TwitchEventSubApi);
const envelope = (type = "unknown.subscription", event: Schema.Json = {}) => ({
  subscription: {
    id: "subscription-id",
    type,
    version: "1",
    status: "enabled",
    cost: 0,
    condition: {},
    transport: { method: "webhook", callback: "https://worker.test/webhooks/twitch" },
    created_at: "2026-01-01T00:00:00Z",
  },
  event,
});
const signedRequest = async (input: {
  readonly bytes?: Uint8Array<ArrayBuffer>;
  readonly text?: string;
  readonly timestamp?: string;
  readonly messageId?: string;
  readonly messageType?: string;
  readonly subscriptionType?: string;
  readonly version?: string;
  readonly retry?: string;
  readonly signature?: string;
}) => {
  const bytes = input.bytes ?? new TextEncoder().encode(input.text ?? JSON.stringify(envelope()));
  const messageId = input.messageId ?? "eventsub-test-message";
  const timestamp = input.timestamp ?? new Date().toISOString();
  const prefix = new TextEncoder().encode(messageId + timestamp);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature =
    input.signature ??
    `sha256=${Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return new Request("https://worker.test/webhooks/twitch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "twitch-eventsub-message-id": messageId,
      "twitch-eventsub-message-timestamp": timestamp,
      "twitch-eventsub-message-type": input.messageType ?? "notification",
      "twitch-eventsub-message-retry": input.retry ?? "0",
      "twitch-eventsub-message-signature": signature,
      "twitch-eventsub-subscription-type": input.subscriptionType ?? "unknown.subscription",
      "twitch-eventsub-subscription-version": input.version ?? "1",
    },
    body: bytes,
  });
};
const withWebhook = <A, E, R>(
  test: (
    fetch: (request: Request) => Promise<Response>,
    receipts: readonly AcceptedEventSubReceipt[],
  ) => Effect.Effect<A, E, R>,
  twitch: Partial<ITwitchService> = {},
) =>
  Effect.gen(function* () {
    const receipts: AcceptedEventSubReceipt[] = [];
    const receiptLayer = Layer.mock(EventSubReceipts, {
      accept: (receipt) =>
        Effect.gen(function* () {
          const existing = receipts.find((entry) => entry.messageId === receipt.messageId);
          if (existing !== undefined && existing.contentDigest !== receipt.contentDigest)
            return yield* Effect.fail(
              new EventSubReceiptConflict({ messageId: receipt.messageId }),
            );
          if (existing === undefined) receipts.push(receipt);
        }),
    });
    const api = HttpApiBuilder.layer(eventSubApi).pipe(
      Layer.provide(twitchEventSubHandlersLayer),
      Layer.provide(twitchHttpCorrelationLayer),
      Layer.provide([
        Layer.succeed(TwitchConfiguration, configuration),
        Layer.mock(TwitchService, twitch),
        receiptLayer,
        cloudflareHttpServerLayer,
      ]),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(api, { disableLogger: true })),
      ({ handler }) => test(handler, receipts),
      ({ dispose }) => Effect.promise(dispose),
    );
  });

describe("authenticated EventSub HTTP ingress", () => {
  it.live(
    "rejects missing/malformed headers, stale/future timestamps and invalid signatures before receipt intake",
    () =>
      withWebhook((fetch, receipts) =>
        Effect.gen(function* () {
          const missing = yield* Effect.promise(() =>
            fetch(
              new Request("https://worker.test/webhooks/twitch", { method: "POST", body: "{}" }),
            ),
          );
          expect(missing.status).toBe(400);
          for (const [input, status] of [
            [{ retry: "NaN" }, 400],
            [{ version: "" }, 400],
            [{ timestamp: "invalid" }, 400],
            [{ timestamp: "2020-01-01T00:00:00Z" }, 403],
            [{ timestamp: "2099-01-01T00:00:00Z" }, 403],
            [{ signature: `sha256=${"0".repeat(64)}` }, 403],
          ] as const) {
            const request = yield* Effect.promise(() => signedRequest(input));
            const response = yield* Effect.promise(() => fetch(request));
            expect(response.status, JSON.stringify(input)).toBe(status);
          }
          expect(receipts).toHaveLength(0);
        }),
      ),
  );

  it.live(
    "checks HMAC before JSON, rejects fatal UTF-8, and authenticates byte-order marks exactly",
    () =>
      withWebhook((fetch, receipts) =>
        Effect.gen(function* () {
          const unsignedJson = yield* Effect.promise(() =>
            signedRequest({ text: "{", signature: `sha256=${"0".repeat(64)}` }),
          );
          expect((yield* Effect.promise(() => fetch(unsignedJson))).status).toBe(403);
          const signedJson = yield* Effect.promise(() => signedRequest({ text: "{" }));
          expect((yield* Effect.promise(() => fetch(signedJson))).status).toBe(400);
          const invalidUtf8 = yield* Effect.promise(() =>
            signedRequest({ bytes: new Uint8Array([0xc3, 0x28]) }),
          );
          const invalidResponse = yield* Effect.promise(() => fetch(invalidUtf8));
          expect(invalidResponse.status).toBe(400);
          expect(yield* Effect.promise(() => invalidResponse.json())).toEqual({
            error: "Invalid EventSub body",
          });
          const text = JSON.stringify(envelope("unknown.subscription", { message: "🎵 café" }));
          const body = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
          const bomRequest = yield* Effect.promise(() => signedRequest({ bytes: body }));
          expect((yield* Effect.promise(() => fetch(bomRequest))).status).toBe(200);
          expect(receipts).toHaveLength(1);
          expect(receipts[0]?.body).toEqual(JSON.parse(text));
        }),
      ),
  );

  it.live(
    "returns verified challenges without durable receipt and rejects header/body metadata contradictions",
    () =>
      withWebhook((fetch, receipts) =>
        Effect.gen(function* () {
          const challengeBody = {
            subscription: {
              ...envelope("stream.online").subscription,
              status: "webhook_callback_verification_pending",
            },
            challenge: "challenge-value",
          };
          const challenge = yield* Effect.promise(() =>
            signedRequest({
              text: JSON.stringify(challengeBody),
              messageType: "webhook_callback_verification",
              subscriptionType: "stream.online",
            }),
          );
          const response = yield* Effect.promise(() => fetch(challenge));
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
          expect(yield* Effect.promise(() => response.text())).toBe("challenge-value");
          for (const input of [
            { text: JSON.stringify(envelope("stream.online")), subscriptionType: "stream.offline" },
            { text: JSON.stringify(envelope()), version: "2" },
            ...[
              "stream.online",
              "stream.offline",
              "channel.raid",
              "channel.chat.message",
              "channel.channel_points_custom_reward_redemption.add",
            ].map((type) => ({ text: JSON.stringify(envelope(type)), subscriptionType: type })),
          ]) {
            const request = yield* Effect.promise(() => signedRequest(input));
            expect((yield* Effect.promise(() => fetch(request))).status).toBe(400);
          }
          expect(receipts).toHaveLength(0);
        }),
      ),
  );

  it.live("bounds both declared and streamed body bytes before crypto verification", () =>
    withWebhook((fetch, receipts) =>
      Effect.gen(function* () {
        const oversize = yield* Effect.promise(() =>
          signedRequest({ text: "x".repeat(1_048_577), signature: `sha256=${"0".repeat(64)}` }),
        );
        const response = yield* Effect.promise(() => fetch(oversize));
        expect(response.status).toBe(413);
        const declared = yield* Effect.promise(() => signedRequest({}));
        declared.headers.set("content-length", "1048577");
        expect((yield* Effect.promise(() => fetch(declared))).status).toBe(413);
        expect(receipts).toHaveLength(0);
      }),
    ),
  );

  it.live(
    "accepts retry metadata changes but rejects exact signed-content conflicts including JSON whitespace",
    () =>
      withWebhook((fetch, receipts) =>
        Effect.gen(function* () {
          const timestamp = new Date().toISOString();
          const text = JSON.stringify(envelope());
          for (const retry of ["0", "1", "22"]) {
            const request = yield* Effect.promise(() => signedRequest({ timestamp, text, retry }));
            expect((yield* Effect.promise(() => fetch(request))).status).toBe(200);
          }
          expect(receipts).toHaveLength(1);
          const conflict = yield* Effect.promise(() =>
            signedRequest({ timestamp, text: `${text} ` }),
          );
          const response = yield* Effect.promise(() => fetch(conflict));
          expect(response.status).toBe(503);
          expect(yield* Effect.promise(() => response.json())).toEqual({
            error: "EventSub durable acceptance failed",
          });
          expect(receipts[0]?.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
        }),
      ),
  );
});

const managedSubscription = (type: string, id = type) =>
  ({
    id,
    type,
    version: "1",
    status: "webhook_callback_verification_pending",
    condition:
      type === "channel.raid"
        ? { to_broadcaster_user_id: "12345" }
        : type === "channel.chat.message"
          ? { broadcaster_user_id: "12345", user_id: "12345" }
          : { broadcaster_user_id: "12345" },
    transport: { method: "webhook", callback: Option.some("https://worker.test/webhooks/twitch") },
  }) satisfies ProviderEventSubSubscription;
const managementRequest = (path: string, method = "GET") =>
  new Request(`https://worker.test/eventsub${path}`, {
    method,
    headers: { authorization: "Bearer admin-secret" },
  });

describe("EventSub management HTTP", () => {
  it.effect(
    "skips all five matching verification-pending subscriptions without attempting creation",
    () => {
      const subscriptions = [
        "stream.online",
        "stream.offline",
        "channel.channel_points_custom_reward_redemption.add",
        "channel.chat.message",
        "channel.raid",
      ].map((type) => managedSubscription(type));
      return withWebhook(
        (fetch) =>
          Effect.gen(function* () {
            const response = yield* Effect.promise(() =>
              fetch(managementRequest("/setup", "POST")),
            );
            expect(response.status).toBe(200);
            expect(yield* Effect.promise(() => response.json())).toEqual({
              success: true,
              message: "All EventSub subscriptions are configured",
              subscriptions: [],
              skipped: subscriptions.map(({ type, version, condition }) => ({
                type,
                version,
                condition,
              })),
            });
          }),
        {
          listEventSubSubscriptions: () => Effect.succeed(subscriptions),
          createEventSubSubscription: () =>
            Effect.die("HTTP setup must not recreate existing subscriptions"),
        },
      );
    },
  );

  it.effect("continues partial setup and omits absent subscription callback keys", () => {
    const attempted: string[] = [];
    return withWebhook(
      (fetch) =>
        Effect.gen(function* () {
          const listed = yield* Effect.promise(() => fetch(managementRequest("/list")));
          expect(yield* Effect.promise(() => listed.json())).toEqual({
            subscriptions: [
              { ...managedSubscription("other"), transport: { method: "websocket" } },
            ],
            total: 1,
          });
          const response = yield* Effect.promise(() => fetch(managementRequest("/setup", "POST")));
          expect(response.status).toBe(500);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            success: false,
            message: "Some subscriptions failed to create",
            skipped: [],
            created: expect.any(Array),
            errors: [
              expect.objectContaining({
                type: "stream.offline",
                code: "TwitchSubscriptionCreateError",
              }),
            ],
          });
          expect(attempted).toEqual([
            "stream.online",
            "stream.offline",
            "channel.channel_points_custom_reward_redemption.add",
            "channel.chat.message",
            "channel.raid",
          ]);
        }),
      {
        listEventSubSubscriptions: () =>
          Effect.succeed([
            {
              ...managedSubscription("other"),
              transport: { method: "websocket", callback: Option.none() },
            },
          ]),
        createEventSubSubscription: (input) => {
          attempted.push(input.type);
          expect(input.callbackUrl).toBe("https://worker.test/webhooks/twitch");
          return input.type === "stream.offline"
            ? Effect.fail(
                new ProviderError({
                  provider: "twitch",
                  operation: "createEventSubSubscription",
                  kind: "rejected",
                  status: 500,
                  retryAfterMs: Option.none(),
                }),
              )
            : Effect.succeed(managedSubscription(input.type));
        },
      },
    );
  });

  it.effect("reports partial cleanup honestly and decodes deletion path IDs exactly once", () => {
    const deleted: string[] = [];
    return withWebhook(
      (fetch) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            fetch(managementRequest("/cleanup", "POST")),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toEqual({
            success: false,
            message: "Deleted 1 subscriptions, 1 failed",
            deleted: 1,
            failed: 1,
          });
          const deletion = yield* Effect.promise(() =>
            fetch(managementRequest("/id%2Fwith%20space", "DELETE")),
          );
          expect(deletion.status).toBe(200);
          expect(yield* Effect.promise(() => deletion.json())).toEqual({
            success: true,
            message: "Subscription deleted successfully",
          });
          expect(deleted).toEqual(["delete-me", "keep-me", "id/with space"]);
        }),
      {
        listEventSubSubscriptions: () =>
          Effect.succeed([
            managedSubscription("stream.online", "delete-me"),
            managedSubscription("stream.offline", "keep-me"),
          ]),
        deleteEventSubSubscription: (id) => {
          deleted.push(id);
          return id === "keep-me"
            ? Effect.fail(
                new ProviderError({
                  provider: "twitch",
                  operation: "deleteEventSubSubscription",
                  kind: "rejected",
                  status: 500,
                  retryAfterMs: Option.none(),
                }),
              )
            : Effect.void;
        },
      },
    );
  });
});
