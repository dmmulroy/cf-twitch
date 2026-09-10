import { expect, it } from "@effect/vitest";
import { BroadcasterId, RedemptionId, RewardId } from "@cf-twitch/contracts/identity";
import { ChatMessageText } from "@cf-twitch/contracts/provider";
import { Effect, Layer, Option, Redacted } from "effect";
import { ProviderAccessTokens } from "./provider-access-tokens.ts";
import {
  providerLocalAccessTokensLayer,
  providerLocalConfigurationLayer,
} from "./provider-local-sql.test-support.ts";
import {
  ProviderScenarioTranscript,
  providerScenarioTransportLayer,
} from "./provider-scenario-transport.test-support.ts";
import { providerTokenExchangeLayer } from "./provider-token-exchange.ts";
import { TwitchService, twitchServiceLayerWithoutDependencies } from "./twitch-service.ts";

const layer = twitchServiceLayerWithoutDependencies.pipe(
  Layer.provideMerge(providerLocalAccessTokensLayer),
  Layer.provide(providerTokenExchangeLayer),
  Layer.provide(providerLocalConfigurationLayer),
  Layer.provideMerge(providerScenarioTransportLayer),
);

const seed = Effect.fn("TwitchTest.seed")(function* (mode: string) {
  const tokens = yield* ProviderAccessTokens;
  yield* tokens.setTokens({
    provider: "twitch",
    tokens: {
      accessToken: Redacted.make(`scenario:${mode}`),
      refreshToken: Option.some(Redacted.make("scenario-refresh")),
      tokenType: "Bearer",
      expiresIn: 3600,
      scopes: [],
    },
  });
});

it.effect("Twitch stream reconciliation uses app credentials without configured user tokens", () =>
  Effect.gen(function* () {
    const twitch = yield* TwitchService;
    const stream = Option.getOrThrow(yield* twitch.getStreamInfo("scenario"));
    expect(stream).toMatchObject({ id: "scenario-stream", viewerCount: 42, title: "Scenario" });
    const transcript = yield* ProviderScenarioTranscript;
    expect(yield* transcript.readRequests()).toEqual([
      { method: "POST", path: "/oauth2/token" },
      { method: "GET", path: "/helix/streams" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("Twitch confirms chat delivery instead of treating any HTTP200 as sent", () =>
  Effect.gen(function* () {
    yield* seed("normal");
    const twitch = yield* TwitchService;
    yield* twitch.sendChatMessage({ message: ChatMessageText.make("Delivered once") });
    const transcript = yield* ProviderScenarioTranscript;
    expect(yield* transcript.readRequests()).toEqual([
      { method: "POST", path: "/helix/chat/messages" },
    ]);
  }).pipe(Effect.provide(layer)),
);

for (const [mode, kind] of [
  ["dropped-chat", "chat-dropped"],
  ["malformed-chat", "outcome-unknown"],
  ["unknown", "outcome-unknown"],
  ["rate-limited", "rate-limited"],
  ["unauthorized", "unauthorized"],
] as const) {
  it.effect(`Twitch ${mode} chat exposes ${kind} without retry or leaking transport evidence`, () =>
    Effect.gen(function* () {
      yield* seed(mode);
      const twitch = yield* TwitchService;

      const result = yield* twitch
        .sendChatMessage({ message: ChatMessageText.make("Private viewer message") })
        .pipe(Effect.result);

      expect(result).toMatchObject({ _tag: "Failure", failure: { kind } });
      expect(JSON.stringify(result)).not.toContain("Private viewer message");
      expect(JSON.stringify(result)).not.toContain(`scenario:${mode}`);
      const transcript = yield* ProviderScenarioTranscript;
      expect(yield* transcript.readRequestCount()).toBe(1);

      if (result._tag === "Failure" && mode === "rate-limited")
        expect(result.failure.retryAfterMs).toEqual(Option.some(12_000));
    }).pipe(Effect.provide(layer)),
  );
}

it.effect(
  "Twitch native shoutout and redemption update preserve configured broadcaster authority",
  () =>
    Effect.gen(function* () {
      yield* seed("normal");
      const twitch = yield* TwitchService;
      yield* twitch.createShoutout({ toBroadcasterId: BroadcasterId.make("456") });
      yield* twitch.updateRedemptionStatus({
        rewardId: RewardId.make("reward"),
        redemptionId: RedemptionId.make("redemption"),
        status: "FULFILLED",
      });
      const transcript = yield* ProviderScenarioTranscript;
      expect(yield* transcript.readRequests()).toEqual([
        { method: "POST", path: "/helix/chat/shoutouts" },
        { method: "PATCH", path: "/helix/channel_points/custom_rewards/redemptions" },
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "Twitch EventSub create/list/delete use app authorization and preserve matching transport evidence",
  () =>
    Effect.gen(function* () {
      const twitch = yield* TwitchService;

      const created = yield* twitch.createEventSubSubscription({
        type: "stream.online",
        version: "1",
        condition: { broadcaster_user_id: "123" },
        callbackUrl: "https://local.test/webhooks/twitch",
        secret: Redacted.make("private-webhook-secret"),
      });

      expect(created.transport.callback).toEqual(Option.some("https://local.test/webhooks/twitch"));
      expect(yield* twitch.listEventSubSubscriptions()).toHaveLength(1);
      yield* twitch.deleteEventSubSubscription(created.id);
    }).pipe(Effect.provide(layer)),
);
