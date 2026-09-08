import { SqliteClient } from "@effect/sql-sqlite-node";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { AcceptedEventSubReceipt } from "@cf-twitch/contracts/eventsub";
import { ChatCommandName } from "@cf-twitch/contracts/chat-command";
import { ProviderError } from "@cf-twitch/contracts/provider";
import { recordingTwitchAnalyticsLayer } from "../support/recording-twitch-analytics.ts";
import { TwitchConfiguration } from "../../src/runtime/twitch-configuration.ts";
import { httpTestConfiguration } from "../../src/features/http/http-test-fixtures.ts";
import { Commands } from "../../src/features/commands/commands.ts";
import { commandsDatabaseLayerWithoutDependencies } from "../../src/features/commands/commands-database.ts";
import { executorLayerWithoutDependencies } from "../../src/features/commands/chat-command-executor.ts";
import { computedChatCommandsLayerWithoutDependencies } from "../../src/features/commands/computed-chat-commands.ts";
import { eventSubDispatchLayerWithoutDependencies } from "../../src/features/eventsub/eventsub-dispatch.ts";
import {
  EventSubInbox,
  eventSubInboxLayerWithoutDependencies,
} from "../../src/features/eventsub/eventsub-inbox.ts";
import { WorkflowAlarm } from "../../src/features/workflows/workflow-alarm.ts";
import { WorkflowStarters } from "../../src/features/workflows/workflow-starters.ts";
import { StreamLifecycleClient } from "../../src/features/stream/stream-lifecycle.ts";
import { TwitchService } from "../../src/features/providers/twitch-service.ts";
import { SongQueue } from "../../src/features/song-queue/song-queue.ts";
import { Raffle } from "../../src/features/raffle/raffle-service.ts";
import { Achievements } from "../../src/features/achievements/achievements-service.ts";

const receipt = Schema.decodeSync(AcceptedEventSubReceipt)({
  messageId: "transport-message",
  receivedAt: "2026-01-01T00:00:00Z",
  contentDigest: "a".repeat(64),
  correlation: { traceId: "trace", requestId: "request" },
  headers: {
    "twitch-eventsub-message-id": "transport-message",
    "twitch-eventsub-message-timestamp": "2026-01-01T00:00:00Z",
    "twitch-eventsub-message-type": "notification",
    "twitch-eventsub-message-retry": "0",
    "twitch-eventsub-message-signature": `sha256=${"a".repeat(64)}`,
    "twitch-eventsub-subscription-type": "channel.chat.message",
    "twitch-eventsub-subscription-version": "1",
  },
  body: {
    subscription: {
      id: "subscription",
      type: "channel.chat.message",
      version: "1",
      status: "enabled",
      cost: 0,
      condition: {},
      transport: { method: "webhook" },
      created_at: "2026-01-01T00:00:00Z",
    },
    event: {
      broadcaster_user_id: "12345",
      broadcaster_user_login: "dillon",
      broadcaster_user_name: "Dillon",
      chatter_user_id: "viewer",
      chatter_user_login: "viewer",
      chatter_user_name: "ModeratorViewer",
      message_id: "chat-message",
      message: { text: "!update today Using TypeScript", fragments: [] },
      badges: [{ set_id: "moderator", id: "1", info: "" }],
    },
  },
});
const sqlite = SqliteClient.layer({ filename: ":memory:" });
const registryLayer = commandsDatabaseLayerWithoutDependencies;
const executorLayer = executorLayerWithoutDependencies.pipe(
  Layer.provide(computedChatCommandsLayerWithoutDependencies),
  Layer.provide(registryLayer),
);
const dispatchLayer = eventSubDispatchLayerWithoutDependencies.pipe(Layer.provide(executorLayer));
const inboxLayer = eventSubInboxLayerWithoutDependencies.pipe(Layer.provide(dispatchLayer));
const commonLayer = Layer.mergeAll(
  recordingTwitchAnalyticsLayer,
  Layer.succeed(TwitchConfiguration, httpTestConfiguration),
  Layer.succeed(WorkflowAlarm, { set: () => Effect.void }),
  Layer.mock(WorkflowStarters, {}),
  Layer.mock(StreamLifecycleClient, {}),
  Layer.mock(SongQueue, {}),
  Layer.mock(Raffle, {}),
  Layer.mock(Achievements, {}),
);

// These journeys cross the real inbox, EventSub parser/dispatcher, executor, and command SQL authority.
describe("Independent EventSub chat delivery integration", () => {
  it.effect(
    "preserves argument casing, deduplicates concurrent intake and reuses a prepared response after definite refusal",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make<readonly string[]>([]);
        const refuse = yield* Ref.make(true);
        const senderLayer = Layer.mock(TwitchService, {
          sendChatMessage: ({ message }) =>
            Ref.update(attempts, (messages) => [...messages, message]).pipe(
              Effect.andThen(Ref.get(refuse)),
              Effect.flatMap((refused) =>
                refused
                  ? Effect.fail(
                      new ProviderError({
                        provider: "twitch",
                        operation: "sendChatMessage",
                        kind: "rate-limited",
                        status: 429,
                        retryAfterMs: Option.none(),
                      }),
                    )
                  : Effect.void,
              ),
            ),
        });
        yield* Effect.gen(function* () {
          const inbox = yield* EventSubInbox;
          const commands = yield* Commands;
          yield* Effect.all([inbox.accept(receipt), inbox.accept(receipt)], {
            concurrency: "unbounded",
          });
          yield* inbox.recover();
          expect(yield* commands.getCommandValue({ name: ChatCommandName.make("today") })).toEqual(
            Option.some("Using TypeScript"),
          );
          expect(yield* Ref.get(attempts)).toEqual(["Updated !today"]);
          // A retry must use persisted preparation even when the command is subsequently disabled.
          yield* commands.updateCommand({
            name: ChatCommandName.make("update"),
            patch: { enabled: false },
          });
          yield* Ref.set(refuse, false);
          yield* TestClock.adjust("2 seconds");
          yield* inbox.recover();
          yield* inbox.accept(receipt);
          expect(yield* Ref.get(attempts)).toEqual(["Updated !today", "Updated !today"]);
          expect(yield* inbox.getReceiptStatus()).toMatchObject({
            value: { status: "completed", chatCommandDelivery: Option.some("sent") },
          });
          expect((yield* commands.getDebugSnapshot()).revision).toBe(3);
        }).pipe(
          Effect.provide(
            Layer.merge(inboxLayer, registryLayer).pipe(Layer.provide([commonLayer, senderLayer])),
          ),
        );
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "retains the successful command mutation but never resends after interrupted Twitch delivery",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const sends = yield* Ref.make(0);
        const senderLayer = Layer.mock(TwitchService, {
          sendChatMessage: () =>
            Ref.update(sends, (n) => n + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
            ),
        });
        const layer = Layer.merge(inboxLayer, registryLayer).pipe(
          Layer.provide([commonLayer, senderLayer]),
        );
        yield* Effect.gen(function* () {
          const inbox = yield* EventSubInbox;
          yield* inbox.accept(receipt);
          const running = yield* inbox.recover().pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(layer, { local: true }));
        yield* TestClock.adjust("60 seconds");
        yield* Effect.gen(function* () {
          const inbox = yield* EventSubInbox;
          const commands = yield* Commands;
          yield* inbox.recover();
          yield* inbox.accept(receipt);
          expect(yield* inbox.getReceiptStatus()).toMatchObject({
            value: { status: "completed", chatCommandDelivery: Option.some("uncertain") },
          });
          expect(yield* commands.getCommandValue({ name: ChatCommandName.make("today") })).toEqual(
            Option.some("Using TypeScript"),
          );
          expect((yield* commands.getDebugSnapshot()).revision).toBe(2);
          expect(yield* Ref.get(sends)).toBe(1);
        }).pipe(Effect.provide(layer, { local: true }));
      }).pipe(Effect.provide(sqlite)),
  );
});
