import { cfTwitchInfrastructureStageConfig } from "@cf-twitch/shared-infrastructure";
import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import { Effect, Option, Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import { ViewerAchievementProgress } from "@cf-twitch/contracts/achievement";
import { EventSubReceiptStatus } from "@cf-twitch/contracts/eventsub";
import { EventSubMessageId } from "@cf-twitch/contracts/identity";
import { OAuthRedirectUri } from "@cf-twitch/contracts/oauth";
import { SongQueueResult } from "@cf-twitch/contracts/song-queue";
import { StreamLifecycleState } from "@cf-twitch/contracts/stream";
import { TwitchRaffleViewerResponse } from "@cf-twitch/contracts/twitch-api";
import { OAuthStateHttpApi } from "../src/features/oauth/oauth-state-http-api.ts";
import { fullWorkerScenarioStack } from "./scenario/full-worker-scenario.ts";
import { oauthScenarioStack } from "./scenario/oauth-scenario-stack.ts";

const stage = Effect.runSync(cfTwitchInfrastructureStageConfig);
const { test } = Test.make({
  providers: Cloudflare.providers(),
  adopt: false,
  dev: true,
  stage,
});

// The administrator route flattens ChatCommandDebugSnapshot entries for legacy wire compatibility.
const ScenarioCommandSnapshot = Schema.Struct({
  commands: Schema.Array(
    Schema.Struct({ name: Schema.String, counter: Schema.NullOr(Schema.Int) }),
  ),
});
const ScenarioProviderTranscript = Schema.Struct({
  requests: Schema.Array(Schema.Struct({ method: Schema.String, path: Schema.String })),
});
const parseScenarioCommandSnapshot = Schema.decodeUnknownEffect(ScenarioCommandSnapshot);
const parseScenarioEventSubReceiptStatus = Schema.decodeUnknownEffect(
  Schema.OptionFromNullOr(EventSubReceiptStatus),
);
const parseScenarioProviderTranscript = Schema.decodeUnknownEffect(ScenarioProviderTranscript);
const parseScenarioRaffleStats = Schema.decodeUnknownEffect(TwitchRaffleViewerResponse);
const parseScenarioSongQueue = Schema.decodeUnknownEffect(SongQueueResult);
const parseScenarioStreamState = Schema.decodeUnknownEffect(Schema.toEncoded(StreamLifecycleState));
const parseScenarioViewerAchievementProgress = Schema.decodeUnknownEffect(
  Schema.Array(ViewerAchievementProgress),
);

class ScenarioObservableStatePending extends Schema.TaggedError<ScenarioObservableStatePending>()(
  "ScenarioObservableStatePending",
  { description: Schema.String },
) {
  override get message(): string {
    return `Full Worker scenario is still waiting for ${this.description}`;
  }
}

type ScenarioObservableCondition<A> = {
  readonly description: string;
  readonly probe: Effect.Effect<A, Schema.SchemaError>;
  readonly isReady: (value: A) => boolean;
};

const waitForScenarioObservableValue = <A>(
  condition: ScenarioObservableCondition<A>,
): Effect.Effect<A, never> =>
  Effect.gen(function* () {
    const value = yield* condition.probe;
    if (!condition.isReady(value))
      return yield* new ScenarioObservableStatePending({ description: condition.description });
    return value;
  }).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }), Effect.orDie);

const randomOAuthState = () => Redacted.make(crypto.randomUUID());
const randomEventSubMessageId = () => EventSubMessageId.make(crypto.randomUUID());
const redirectUri = OAuthRedirectUri.make("https://local.test/oauth/twitch/callback");
const otherRedirectUri = OAuthRedirectUri.make("https://local.test/oauth/twitch/other-callback");

const signEventSubRequest = async (input: {
  readonly url: string;
  readonly body: string;
  readonly messageId: EventSubMessageId;
  readonly timestamp: string;
  readonly subscriptionType: string;
}) => {
  const signed = new TextEncoder().encode(input.messageId + input.timestamp + input.body);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return new Request(`${input.url}/webhooks/twitch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "twitch-eventsub-message-id": input.messageId,
      "twitch-eventsub-message-retry": "0",
      "twitch-eventsub-message-signature": `sha256=${signature}`,
      "twitch-eventsub-message-timestamp": input.timestamp,
      "twitch-eventsub-message-type": "notification",
      "twitch-eventsub-subscription-type": input.subscriptionType,
      "twitch-eventsub-subscription-version": "1",
    },
    body: input.body,
  });
};

const authorizeProvider = async (url: string, provider: "spotify" | "twitch") => {
  const authorize = await fetch(`${url}/oauth/${provider}/authorize`, {
    headers: { "x-setup-secret": "setup-secret" },
    redirect: "manual",
  });
  expect(authorize.status).toBe(302);
  const location = authorize.headers.get("location");
  expect(location).not.toBeNull();
  const state = new URL(location ?? "https://invalid.local").searchParams.get("state");
  expect(state).not.toBeNull();
  const callback = await fetch(
    `${url}/oauth/${provider}/callback?state=${encodeURIComponent(state ?? "")}&code=scenario-code`,
  );
  expect(callback.status).toBe(200);
};

test.provider(
  "runs native OAuth state through a real local Worker and Durable Object",
  (stack) =>
    Effect.gen(function* () {
      const deployed = yield* stack.deploy(oauthScenarioStack);

      yield* Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const client = yield* HttpApiClient.makeWith(OAuthStateHttpApi, {
          baseUrl: deployed.url,
          httpClient,
        });
        const state = randomOAuthState();
        const now = Date.now();
        const attempt = {
          state,
          provider: "twitch" as const,
          redirectUri,
          createdAtMs: now,
          expiresAtMs: now + 60_000,
        };

        yield* client.oauthState.createAttempt({ payload: attempt });
        expect(
          yield* client.oauthState.consumeAttempt({
            payload: { state, provider: "spotify", redirectUri },
          }),
        ).toBe("mismatch");
        expect(
          yield* client.oauthState.consumeAttempt({
            payload: {
              state,
              provider: "twitch",
              redirectUri: otherRedirectUri,
            },
          }),
        ).toBe("mismatch");

        const concurrentOutcomes = yield* Effect.all(
          [
            client.oauthState.consumeAttempt({
              payload: { state, provider: "twitch", redirectUri },
            }),
            client.oauthState.consumeAttempt({
              payload: { state, provider: "twitch", redirectUri },
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect([...concurrentOutcomes].sort()).toEqual(["consumed", "ok"]);

        const expiringState = randomOAuthState();
        const expiringNow = Date.now();
        yield* client.oauthState.createAttempt({
          payload: {
            state: expiringState,
            provider: "spotify",
            redirectUri,
            createdAtMs: expiringNow,
            expiresAtMs: expiringNow + 250,
          },
        });
        yield* Effect.sleep("300 millis");
        const afterDeadline = yield* client.oauthState.consumeAttempt({
          payload: { state: expiringState, provider: "spotify", redirectUri },
        });
        expect(["expired", "invalid"]).toContain(afterDeadline);

        yield* Effect.sleep("1 second");
        expect(
          yield* client.oauthState.consumeAttempt({
            payload: { state: expiringState, provider: "spotify", redirectUri },
          }),
        ).toBe("invalid");
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));
    }),
  { timeout: 30_000 },
);

test.provider(
  "runs the full Worker and all thirteen Durable Object bindings through a signed Song Request",
  (stack) =>
    Effect.gen(function* () {
      const deployed = yield* stack.deploy(fullWorkerScenarioStack);
      if (deployed.url === undefined)
        return yield* Effect.die("Full Worker scenario URL is unavailable");
      const scenarioUrl = deployed.url;
      const health = yield* Effect.promise(() => fetch(`${scenarioUrl}/health`));
      expect(health.status).toBe(200);
      expect(yield* Effect.promise(() => health.json())).toEqual({ status: "ok" });

      const postSignedNotification = (input: {
        readonly body: Schema.Json;
        readonly messageId?: EventSubMessageId;
        readonly timestamp: string;
        readonly subscriptionType: string;
      }) =>
        Effect.promise(async () => {
          const body = JSON.stringify(input.body);
          const messageId = input.messageId ?? randomEventSubMessageId();
          const request = await signEventSubRequest({
            url: scenarioUrl,
            body,
            messageId,
            timestamp: input.timestamp,
            subscriptionType: input.subscriptionType,
          });
          const response = await fetch(request);
          const responseBody = await response.text();
          expect(response.status, responseBody).toBe(200);
          expect(JSON.parse(responseBody)).toEqual({ success: true });
          return messageId;
        });

      const waitForReceiptCompletion = (messageId: EventSubMessageId) =>
        waitForScenarioObservableValue({
          description: `EventSub receipt ${messageId} to complete`,
          probe: Effect.promise(() =>
            fetch(
              `${scenarioUrl}/__scenario/eventsub-receipt-status?messageId=${encodeURIComponent(messageId)}`,
            ).then((response) => response.json()),
          ).pipe(Effect.flatMap(parseScenarioEventSubReceiptStatus)),
          isReady: (status) => Option.isSome(status) && status.value.status === "completed",
        });

      const adminHeaders = {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
      };
      const createdCommand = yield* Effect.promise(() =>
        fetch(`${scenarioUrl}/api/admin/commands`, {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({
            name: "scenario-command",
            description: "Full workerd scenario command",
            category: "info",
            responseType: "static",
            permission: "everyone",
            initialValue: "scenario-value",
          }),
        }),
      );
      expect(createdCommand.status).toBe(201);
      const patchedCommand = yield* Effect.promise(() =>
        fetch(`${scenarioUrl}/api/admin/commands/scenario-command`, {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ enabled: false }),
        }),
      );
      expect(patchedCommand.status).toBe(200);
      const listedCommands = yield* Effect.promise(() =>
        fetch(`${scenarioUrl}/api/admin/commands`, { headers: adminHeaders }).then((response) =>
          response.json(),
        ),
      );
      expect(listedCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "scenario-command", enabled: false }),
        ]),
      );
      const deletedCommand = yield* Effect.promise(() =>
        fetch(`${scenarioUrl}/api/admin/commands/scenario-command`, {
          method: "DELETE",
          headers: adminHeaders,
        }),
      );
      expect(deletedCommand.status).toBe(200);

      // Both authorization paths traverse native OAuth state, Effect Crypto, controlled provider
      // response parsing, and the real provider-token Durable Objects before EventSub intake.
      yield* Effect.promise(() => authorizeProvider(scenarioUrl, "spotify"));
      yield* Effect.promise(() => authorizeProvider(scenarioUrl, "twitch"));

      const concurrentRefresh = yield* Effect.promise(() =>
        fetch(`${scenarioUrl}/__scenario/provider-token/concurrent-refresh`, { method: "POST" }),
      );
      expect(concurrentRefresh.status).toBe(200);
      expect(yield* Effect.promise(() => concurrentRefresh.json())).toEqual({
        concurrentCallersConverged: true,
        callersReturnedCommittedToken: true,
      });

      const skillTimestamp = new Date().toISOString();
      const skillMessageId = randomEventSubMessageId();
      const skillBody = {
        subscription: {
          id: "scenario-chat-subscription",
          type: "channel.chat.message",
          version: "1",
          status: "enabled",
          cost: 0,
          condition: { broadcaster_user_id: "12345", user_id: "12345" },
          transport: { method: "webhook", callback: `${scenarioUrl}/webhooks/twitch` },
          created_at: skillTimestamp,
        },
        event: {
          broadcaster_user_id: "12345",
          broadcaster_user_login: "dillon",
          broadcaster_user_name: "Dillon",
          chatter_user_id: "123456",
          chatter_user_login: "scenario_viewer",
          chatter_user_name: "Scenario Viewer",
          message_id: skillMessageId,
          message: { text: "!skillissue", fragments: [] },
          badges: [{ set_id: "vip", id: "1", info: "" }],
        },
      };
      yield* postSignedNotification({
        body: skillBody,
        messageId: skillMessageId,
        timestamp: skillTimestamp,
        subscriptionType: "channel.chat.message",
      });
      yield* postSignedNotification({
        body: skillBody,
        messageId: skillMessageId,
        timestamp: skillTimestamp,
        subscriptionType: "channel.chat.message",
      });
      yield* waitForReceiptCompletion(skillMessageId);
      const commandSnapshot = yield* waitForScenarioObservableValue({
        description: "the skillissue command counter to reach one",
        probe: Effect.promise(() =>
          fetch(`${scenarioUrl}/api/admin/commands/debug/snapshot`, {
            headers: adminHeaders,
          }).then((response) => response.json()),
        ).pipe(Effect.flatMap(parseScenarioCommandSnapshot)),
        isReady: (snapshot) =>
          snapshot.commands.some(
            (command) => command.name === "skillissue" && command.counter === 1,
          ),
      });
      expect(commandSnapshot).toMatchObject({
        commands: expect.arrayContaining([
          expect.objectContaining({ name: "skillissue", counter: 1 }),
        ]),
      });

      const messageId = randomEventSubMessageId();
      const timestamp = new Date().toISOString();
      const body = JSON.stringify({
        subscription: {
          id: "scenario-song-subscription",
          type: "channel.channel_points_custom_reward_redemption.add",
          version: "1",
          status: "enabled",
          cost: 0,
          condition: { broadcaster_user_id: "12345", reward_id: "song-reward" },
          transport: { method: "webhook", callback: `${scenarioUrl}/webhooks/twitch` },
          created_at: timestamp,
        },
        event: {
          broadcaster_user_id: "12345",
          broadcaster_user_login: "dillon",
          broadcaster_user_name: "Dillon",
          id: "scenario-song-redemption",
          user_id: "123456",
          user_login: "scenario_viewer",
          user_name: "Scenario Viewer",
          user_input: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
          status: "unfulfilled",
          redeemed_at: timestamp,
          reward: { id: "song-reward", title: "Song Request", cost: 100, prompt: "" },
        },
      });
      const request = yield* Effect.promise(() =>
        signEventSubRequest({
          url: scenarioUrl,
          body,
          messageId,
          timestamp,
          subscriptionType: "channel.channel_points_custom_reward_redemption.add",
        }),
      );
      const accepted = yield* Effect.promise(() => fetch(request));
      const acceptedBody = yield* Effect.promise(() => accepted.text());
      expect(accepted.status, acceptedBody).toBe(200);
      expect(JSON.parse(acceptedBody)).toEqual({ success: true });
      yield* waitForReceiptCompletion(messageId);

      const queueBody = yield* waitForScenarioObservableValue({
        description: "the accepted Song Request to enter the queue",
        probe: Effect.promise(() =>
          fetch(`${scenarioUrl}/api/queue?limit=10`).then((response) => response.json()),
        ).pipe(Effect.flatMap(parseScenarioSongQueue)),
        isReady: (queue) =>
          queue.tracks.some(
            (track) => track.source === "user" && track.eventId === "scenario-song-redemption",
          ),
      });
      expect(queueBody.tracks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "4uLU6hMCjMI75M1A2tKUQC",
            source: "user",
            requesterDisplayName: "Scenario Viewer",
            eventId: "scenario-song-redemption",
          }),
        ]),
      );
      expect(
        queueBody.tracks.filter(
          (track) => track.source === "user" && track.eventId === "scenario-song-redemption",
        ),
      ).toHaveLength(1);

      // Signed redelivery re-enters the real inbox but must not duplicate completed workflow state.
      const replay = yield* Effect.promise(() =>
        signEventSubRequest({
          url: scenarioUrl,
          body,
          messageId,
          timestamp,
          subscriptionType: "channel.channel_points_custom_reward_redemption.add",
        }).then(fetch),
      );
      expect(replay.status).toBe(200);
      const afterReplay = yield* Effect.promise(() =>
        fetch(`${scenarioUrl}/api/queue?limit=10`).then((response) => response.json()),
      ).pipe(Effect.flatMap(parseScenarioSongQueue));
      expect(
        afterReplay.tracks.filter(
          (track) => track.source === "user" && track.eventId === "scenario-song-redemption",
        ),
      ).toHaveLength(1);

      const transcript = yield* Effect.promise(() =>
        fetch(`${scenarioUrl}/__scenario/provider-transcript`).then((response) => response.json()),
      ).pipe(Effect.flatMap(parseScenarioProviderTranscript));
      expect(
        transcript.requests.filter(
          (providerRequest) =>
            providerRequest.method === "POST" && providerRequest.path === "/v1/me/player/queue",
        ),
      ).toHaveLength(1);
      expect(
        transcript.requests.filter(
          (providerRequest) =>
            providerRequest.method === "PATCH" &&
            providerRequest.path === "/helix/channel_points/custom_rewards/redemptions",
        ),
      ).toHaveLength(1);

      const achievementProgress = yield* waitForScenarioObservableValue({
        description: "the first Song Request achievement to unlock",
        probe: Effect.promise(() =>
          fetch(`${scenarioUrl}/api/achievements/${encodeURIComponent("Scenario Viewer")}`).then(
            (response) => response.json(),
          ),
        ).pipe(Effect.flatMap(parseScenarioViewerAchievementProgress)),
        isReady: (progress) =>
          progress.some(
            (achievement) => achievement.achievementId === "first_request" && achievement.unlocked,
          ),
      });
      expect(achievementProgress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ achievementId: "first_request", progress: 1, unlocked: true }),
        ]),
      );

      const raffleTimestamp = new Date().toISOString();
      const raffleMessageId = yield* postSignedNotification({
        timestamp: raffleTimestamp,
        subscriptionType: "channel.channel_points_custom_reward_redemption.add",
        body: {
          subscription: {
            id: "scenario-raffle-subscription",
            type: "channel.channel_points_custom_reward_redemption.add",
            version: "1",
            status: "enabled",
            cost: 0,
            condition: { broadcaster_user_id: "12345", reward_id: "raffle-reward" },
            transport: { method: "webhook", callback: `${scenarioUrl}/webhooks/twitch` },
            created_at: raffleTimestamp,
          },
          event: {
            broadcaster_user_id: "12345",
            broadcaster_user_login: "dillon",
            broadcaster_user_name: "Dillon",
            id: "scenario-raffle-redemption",
            user_id: "123456",
            user_login: "scenario_viewer",
            user_name: "Scenario Viewer",
            user_input: "",
            status: "unfulfilled",
            redeemed_at: raffleTimestamp,
            reward: { id: "raffle-reward", title: "Keyboard Raffle", cost: 100, prompt: "" },
          },
        },
      });
      yield* waitForReceiptCompletion(raffleMessageId);
      const raffleStats = yield* waitForScenarioObservableValue({
        description: "the Keyboard Raffle roll to persist",
        probe: Effect.promise(() =>
          fetch(`${scenarioUrl}/api/stats/raffle/user/123456`).then((response) => response.json()),
        ).pipe(Effect.flatMap(parseScenarioRaffleStats)),
        isReady: (stats) => stats.totalRolls === 1,
      });
      expect(raffleStats).toMatchObject({ totalRolls: 1 });

      const onlineTimestamp = new Date().toISOString();
      const onlineMessageId = yield* postSignedNotification({
        timestamp: onlineTimestamp,
        subscriptionType: "stream.online",
        body: {
          subscription: {
            id: "scenario-online-subscription",
            type: "stream.online",
            version: "1",
            status: "enabled",
            cost: 0,
            condition: { broadcaster_user_id: "12345" },
            transport: { method: "webhook", callback: `${scenarioUrl}/webhooks/twitch` },
            created_at: onlineTimestamp,
          },
          event: {
            broadcaster_user_id: "12345",
            broadcaster_user_login: "dillon",
            broadcaster_user_name: "Dillon",
            id: "scenario-stream",
            type: "live",
            started_at: onlineTimestamp,
          },
        },
      });
      yield* waitForReceiptCompletion(onlineMessageId);
      const liveState = yield* waitForScenarioObservableValue({
        description: "the online Stream Session state",
        probe: Effect.promise(() =>
          fetch(`${scenarioUrl}/api/debug/stream-state`, { headers: adminHeaders }).then(
            (response) => response.json(),
          ),
        ).pipe(Effect.flatMap(parseScenarioStreamState)),
        isReady: (state) => state.isLive && state.startedAt === onlineTimestamp,
      });
      expect(liveState).toMatchObject({ isLive: true, startedAt: onlineTimestamp });

      const offlineTimestamp = new Date(Date.now() + 1).toISOString();
      const offlineMessageId = yield* postSignedNotification({
        timestamp: offlineTimestamp,
        subscriptionType: "stream.offline",
        body: {
          subscription: {
            id: "scenario-offline-subscription",
            type: "stream.offline",
            version: "1",
            status: "enabled",
            cost: 0,
            condition: { broadcaster_user_id: "12345" },
            transport: { method: "webhook", callback: `${scenarioUrl}/webhooks/twitch` },
            created_at: offlineTimestamp,
          },
          event: {
            broadcaster_user_id: "12345",
            broadcaster_user_login: "dillon",
            broadcaster_user_name: "Dillon",
          },
        },
      });
      yield* waitForReceiptCompletion(offlineMessageId);
      const offlineState = yield* waitForScenarioObservableValue({
        description: "the offline Stream Session state",
        probe: Effect.promise(() =>
          fetch(`${scenarioUrl}/api/debug/stream-state`, { headers: adminHeaders }).then(
            (response) => response.json(),
          ),
        ).pipe(Effect.flatMap(parseScenarioStreamState)),
        isReady: (state) => !state.isLive && state.endedAt === offlineTimestamp,
      });
      expect(offlineState).toMatchObject({ isLive: false, endedAt: offlineTimestamp });

      const raidTimestamp = new Date().toISOString();
      const raidMessageId = yield* postSignedNotification({
        timestamp: raidTimestamp,
        subscriptionType: "channel.raid",
        body: {
          subscription: {
            id: "scenario-raid-subscription",
            type: "channel.raid",
            version: "1",
            status: "enabled",
            cost: 0,
            condition: { to_broadcaster_user_id: "12345" },
            transport: { method: "webhook", callback: `${scenarioUrl}/webhooks/twitch` },
            created_at: raidTimestamp,
          },
          event: {
            from_broadcaster_user_id: "654321",
            from_broadcaster_user_login: "raider",
            from_broadcaster_user_name: "Scenario Raider",
            to_broadcaster_user_id: "12345",
            to_broadcaster_user_login: "dillon",
            to_broadcaster_user_name: "Dillon",
            viewers: 42,
          },
        },
      });
      yield* waitForReceiptCompletion(raidMessageId);
    }),
  { timeout: 60_000 },
);
