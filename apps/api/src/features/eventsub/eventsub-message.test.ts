import { it } from "@effect/vitest";
import { describe, expect, test } from "vite-plus/test";
import { Effect, Schema } from "effect";
import { FastCheck } from "effect/testing";
import { EventSubHeaders } from "@cf-twitch/contracts/eventsub";
import { parseEventSubMessage } from "./eventsub-message.ts";

const headers = Schema.decodeUnknownSync(EventSubHeaders)({
  "twitch-eventsub-message-id": "message-1",
  "twitch-eventsub-message-timestamp": "2026-01-01T00:00:00Z",
  "twitch-eventsub-message-type": "notification",
  "twitch-eventsub-message-retry": "0",
  "twitch-eventsub-message-signature": `sha256=${"a".repeat(64)}`,
  "twitch-eventsub-subscription-type": "unknown.subscription",
  "twitch-eventsub-subscription-version": "1",
});

const subscription = (type: string) => ({
  id: "subscription",
  type,
  version: "1",
  status: "enabled",
  cost: 0,
  condition: {},
  transport: { method: "webhook" },
  created_at: "2026-01-01T00:00:00Z",
});

const broadcaster = {
  broadcaster_user_id: "broadcaster",
  broadcaster_user_login: "broadcaster",
  broadcaster_user_name: "Broadcaster",
};

describe("EventSub signed message boundary", () => {
  it.effect("parses all known notification shapes and retains source timestamps", () =>
    Effect.gen(function* () {
      const examples = [
        {
          type: "stream.online",
          tag: "StreamOnlineNotification",
          event: {
            ...broadcaster,
            id: "stream-1",
            type: "live",
            started_at: "2026-01-01T01:00:00+01:00",
          },
        },
        { type: "stream.offline", tag: "StreamOfflineNotification", event: broadcaster },
        {
          type: "channel.channel_points_custom_reward_redemption.add",
          tag: "RewardRedemptionNotification",
          event: {
            ...broadcaster,
            id: "redemption",
            user_id: "viewer",
            user_login: "viewer",
            user_name: "Viewer",
            user_input: "spotify:track:abc",
            status: "unfulfilled",
            reward: { id: "reward", title: "Song", cost: 100, prompt: "" },
            redeemed_at: "2026-01-01T00:00:00Z",
          },
        },
        {
          type: "channel.raid",
          tag: "RaidNotification",
          event: {
            from_broadcaster_user_id: "raider",
            from_broadcaster_user_login: "raider",
            from_broadcaster_user_name: "Raider",
            to_broadcaster_user_id: "broadcaster",
            to_broadcaster_user_login: "broadcaster",
            to_broadcaster_user_name: "Broadcaster",
            viewers: 42,
          },
        },
        {
          type: "channel.chat.message",
          tag: "ChatMessageNotification",
          event: {
            ...broadcaster,
            chatter_user_id: "viewer",
            chatter_user_login: "viewer",
            chatter_user_name: "Viewer",
            message_id: "chat-1",
            message: { text: "!today Using TypeScript", fragments: [] },
            badges: [{ set_id: "moderator", id: "1", info: "" }],
          },
        },
      ];

      for (const example of examples) {
        const body = yield* Schema.decodeUnknownEffect(Schema.Json)({
          subscription: subscription(example.type),
          event: example.event,
        });

        const result = yield* parseEventSubMessage(
          { ...headers, "twitch-eventsub-subscription-type": example.type },
          body,
        );

        expect(result._tag).toBe(example.tag);

        if (result._tag === "StreamOnlineNotification")
          expect(result.event.started_at).toBe("2026-01-01T01:00:00+01:00");

        if (result._tag === "ChatMessageNotification")
          expect(result.event.message.text).toBe("!today Using TypeScript");
      }
    }),
  );

  it.effect("rejects malformed known events before any durable acceptance", () =>
    Effect.gen(function* () {
      for (const type of [
        "stream.online",
        "stream.offline",
        "channel.raid",
        "channel.chat.message",
        "channel.channel_points_custom_reward_redemption.add",
      ]) {
        expect(
          yield* parseEventSubMessage(
            { ...headers, "twitch-eventsub-subscription-type": type },
            { subscription: subscription(type), event: {} },
          ).pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "EventSubReceiptError", reason: "invalid" } });
      }
    }),
  );

  it.effect(
    "rejects contradictory authenticated header type/version without echoing raw body",
    () =>
      Effect.gen(function* () {
        for (const field of [
          "twitch-eventsub-subscription-type",
          "twitch-eventsub-subscription-version",
        ] as const) {
          const result = yield* parseEventSubMessage(
            { ...headers, [field]: "contradiction" },
            {
              subscription: subscription("unknown.subscription"),
              event: { secret: "private-chat-body" },
            },
          ).pipe(Effect.result);

          expect(result).toMatchObject({ failure: { reason: "invalid" } });
          expect(JSON.stringify(result)).not.toContain("private-chat-body");
        }
      }),
  );

  it.effect(
    "parses callback challenges and revocations without treating them as notifications",
    () =>
      Effect.gen(function* () {
        expect(
          yield* parseEventSubMessage(
            { ...headers, "twitch-eventsub-message-type": "webhook_callback_verification" },
            { subscription: subscription("unknown.subscription"), challenge: "challenge" },
          ),
        ).toMatchObject({ _tag: "EventSubChallenge", challenge: "challenge" });
        expect(
          yield* parseEventSubMessage(
            { ...headers, "twitch-eventsub-message-type": "revocation" },
            { subscription: subscription("unknown.subscription") },
          ),
        ).toMatchObject({ _tag: "EventSubRevocation" });
      }),
  );

  test("unknown subscription payloads retain JSON values and cannot spoof a known internal discriminator", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.string({ minLength: 1 }),
        Schema.toArbitrary(Schema.Json)(FastCheck),
        (suffix, value) => {
          const type = `unknown.${suffix}`;

          const result = Effect.runSync(
            parseEventSubMessage(
              { ...headers, "twitch-eventsub-subscription-type": type },
              Object.fromEntries([
                ["subscription", subscription(type)],
                ["event", { value }],
                ["_tag", "RewardRedemptionNotification"],
                ["__proto__", { subscription: subscription("spoofed.subscription") }],
              ]),
            ),
          );

          expect(result).toMatchObject({
            _tag: "UnhandledEventSubNotification",
            subscription: { type },
            event: { value },
          });
        },
      ),
    );
  });
});
