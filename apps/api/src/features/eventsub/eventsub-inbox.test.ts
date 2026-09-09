import { SqliteClient } from "@effect/sql-sqlite-node";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import {
  recordingTwitchAnalyticsLayer,
  TwitchAnalyticsRecording,
} from "../../../test/support/recording-twitch-analytics.ts";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { EventSubHttpApi } from "./eventsub-http-api.ts";
import { eventSubHttpHandlersLayer } from "./eventsub-http-handlers.ts";
import { ChatCommandName } from "@cf-twitch/contracts/chat-command";
import { AcceptedEventSubReceipt, EventSubReceiptError } from "@cf-twitch/contracts/eventsub";
import { ChatMessageText, ProviderError } from "@cf-twitch/contracts/provider";
import { TwitchService } from "../providers/twitch-service.ts";
import { WorkflowAlarm, WorkflowAlarmError } from "../workflows/workflow-alarm.ts";
import { EventSubDispatch, type EventSubChatResponse } from "./eventsub-dispatch.ts";
import { EventSubInbox, eventSubInboxLayerWithoutDependencies } from "./eventsub-inbox.ts";

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

const chatReceipt = Schema.decodeUnknownSync(AcceptedEventSubReceipt)({
  ...receipt,
  headers: { ...receipt.headers, "twitch-eventsub-subscription-type": "channel.chat.message" },
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
      broadcaster_user_id: "broadcaster",
      broadcaster_user_login: "broadcaster",
      broadcaster_user_name: "Broadcaster",
      chatter_user_id: "viewer",
      chatter_user_login: "viewer",
      chatter_user_name: "Viewer",
      message_id: "chat-1",
      message: { text: "!today", fragments: [] },
      badges: [],
    },
  },
});

const sqlite = Layer.merge(
  SqliteClient.layer({ filename: ":memory:" }),
  recordingTwitchAnalyticsLayer,
);

const recordingInbox = Effect.gen(function* () {
  const analytics = yield* TwitchAnalytics;
  const metrics = yield* TwitchAnalyticsRecording;
  const dispatches = yield* Ref.make(0);
  const sends = yield* Ref.make(0);
  const dispatchFailure = yield* Ref.make(false);
  const sendFailure = yield* Ref.make<Option.Option<ProviderError>>(Option.none());
  const response = yield* Ref.make<Option.Option<EventSubChatResponse>>(Option.none());
  const alarmFailure = yield* Ref.make(false);
  const dueAt = yield* Ref.make<Option.Option<number>>(Option.none());
  const sendStarted = yield* Deferred.make<void>();
  const releaseSend = yield* Deferred.make<void>();
  const blockSend = yield* Ref.make(false);

  const dependencies = Layer.mergeAll(
    Layer.succeed(TwitchAnalytics, analytics),
    Layer.succeed(EventSubDispatch, {
      dispatch: () =>
        Ref.update(dispatches, (n) => n + 1).pipe(
          Effect.andThen(Ref.get(dispatchFailure)),
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(
                  new EventSubReceiptError({
                    operation: "dispatch",
                    reason: "dispatch",
                  }),
                )
              : Ref.get(response),
          ),
        ),
    }),
    Layer.mock(TwitchService, {
      sendChatMessage: () =>
        Effect.gen(function* () {
          yield* Ref.update(sends, (n) => n + 1);
          yield* Deferred.succeed(sendStarted, undefined);

          if (yield* Ref.get(blockSend)) yield* Deferred.await(releaseSend);
          const error = yield* Ref.get(sendFailure);

          if (Option.isSome(error)) return yield* error.value;
        }),
    }),
    Layer.succeed(WorkflowAlarm, {
      set: (due) =>
        Ref.get(alarmFailure).pipe(
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(new WorkflowAlarmError({ message: "Controlled alarm unavailable" }))
              : Ref.set(dueAt, due),
          ),
        ),
    }),
  );

  const layer = eventSubInboxLayerWithoutDependencies.pipe(Layer.provide(dependencies));

  const acquire = Effect.gen(function* () {
    return yield* EventSubInbox;
  }).pipe(Effect.provide(layer, { local: true }));

  return {
    layer,
    metrics,
    acquire,
    dispatches,
    sends,
    dispatchFailure,
    sendFailure,
    response,
    alarmFailure,
    dueAt,
    sendStarted,
    releaseSend,
    blockSend,
  };
});

describe("EventSub inbox real SQLite public acceptance and recovery", () => {
  it.effect(
    "accepts authenticated source time earlier than server ingestion and redelivery with a later receivedAt",
    () =>
      Effect.gen(function* () {
        const controls = yield* recordingInbox;

        const first = Schema.decodeUnknownSync(AcceptedEventSubReceipt)({
          ...receipt,
          receivedAt: "2026-01-01T00:01:00Z",
        });

        const redelivered = Schema.decodeUnknownSync(AcceptedEventSubReceipt)({
          ...receipt,
          receivedAt: "2026-01-01T00:02:00Z",
        });

        const inbox = yield* controls.acquire;
        yield* inbox.accept(first);
        const restarted = yield* controls.acquire;
        yield* restarted.accept(redelivered);
        yield* restarted.recover();
        expect(yield* restarted.getReceiptStatus()).toMatchObject({
          value: { status: "completed", attempts: 1 },
        });
        expect(yield* Ref.get(controls.dispatches)).toBe(1);
        const sql = yield* SqlClient.SqlClient;

        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ received_at: Schema.String })),
        )(
          yield* sql`SELECT json_extract(receipt_json,'$.receipt.receivedAt') AS received_at FROM eventsub_receipts`,
        );

        expect(rows).toEqual([{ received_at: "2026-01-01T00:01:00Z" }]);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "roundtrips receipt acceptance, Option status and typed content conflict through generated HTTP client",
    () =>
      Effect.gen(function* () {
        const controls = yield* recordingInbox;
        const inbox = yield* controls.acquire;

        const httpLayer = HttpApiBuilder.layer(EventSubHttpApi).pipe(
          Layer.provide(
            eventSubHttpHandlersLayer.pipe(Layer.provide(Layer.succeed(EventSubInbox, inbox))),
          ),
          Layer.provide(cloudflareHttpServerLayer),
        );

        const app = yield* Effect.acquireRelease(
          Effect.sync(() => HttpRouter.toWebHandler(httpLayer, { disableLogger: true })),
          (app) => Effect.promise(() => app.dispose()),
        );

        const fetchLayer = FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
              app.handler(new Request(input, init)),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const httpClient = yield* HttpClient.HttpClient;

          const client = yield* HttpApiClient.makeWith(EventSubHttpApi, {
            baseUrl: "http://eventsub.test",
            httpClient,
          });

          expect(yield* client.receipts.getReceiptStatus()).toEqual(Option.none());
          yield* client.receipts.accept({ payload: receipt });
          yield* client.receipts.accept({ payload: receipt });
          const dueAt = yield* Ref.get(controls.dueAt);
          expect(Option.isSome(dueAt)).toBe(true);

          if (Option.isSome(dueAt)) yield* TestClock.setTime(dueAt.value);
          yield* inbox.recover();
          expect(yield* inbox.getReceiptStatus()).toMatchObject({
            value: { status: "completed", attempts: 1 },
          });
          expect(yield* client.receipts.getReceiptStatus()).toMatchObject({
            value: { status: "completed", attempts: 1, chatCommandDelivery: { _tag: "None" } },
          });
          expect(
            yield* client.receipts
              .accept({ payload: { ...receipt, contentDigest: "f".repeat(64) } })
              .pipe(Effect.result),
          ).toMatchObject({ failure: { _tag: "EventSubReceiptConflict" } });
          expect(yield* Ref.get(controls.dispatches)).toBe(1);
        }).pipe(Effect.provide(fetchLayer));
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "emits success metrics only after confirmed chat and claims each outcome at most once",
    () =>
      Effect.gen(function* () {
        const controls = yield* recordingInbox;
        yield* Ref.set(
          controls.response,
          Option.some({
            commandName: ChatCommandName.make("today"),
            message: ChatMessageText.make("TypeScript"),
          }),
        );
        const inbox = yield* controls.acquire;
        yield* inbox.accept(chatReceipt);
        yield* inbox.accept(chatReceipt);
        const restarted = yield* controls.acquire;
        yield* restarted.recover();
        expect(yield* controls.metrics.readRecordedTwitchAnalyticsCalls()).toMatchObject([
          {
            _tag: "ChatCommandMetric",
            metric: { command: "today", status: "success", userId: "viewer" },
          },
        ]);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "accepts concurrent exact duplicates once and excludes retry/correlation from identity",
    () =>
      Effect.gen(function* () {
        const controls = yield* recordingInbox;
        const inbox = yield* controls.acquire;

        const retried: AcceptedEventSubReceipt = {
          ...receipt,
          correlation: { traceId: "another-trace", requestId: "another-request" },
          headers: { ...receipt.headers, "twitch-eventsub-message-retry": "8" },
        };

        yield* Effect.all([inbox.accept(receipt), inbox.accept(retried)], {
          concurrency: "unbounded",
        });
        const restarted = yield* controls.acquire;
        yield* restarted.accept(retried);
        yield* restarted.recover();
        expect(yield* restarted.getReceiptStatus()).toMatchObject({
          value: { status: "completed", attempts: 1 },
        });
        expect(yield* Ref.get(controls.dispatches)).toBe(1);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect("rejects conflicting signed content without reopening a completed receipt", () =>
    Effect.gen(function* () {
      const controls = yield* recordingInbox;
      const inbox = yield* controls.acquire;
      yield* inbox.accept(receipt);
      yield* inbox.recover();
      expect(
        yield* inbox.accept({ ...receipt, contentDigest: "b".repeat(64) }).pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "EventSubReceiptConflict" } });
      expect(yield* Ref.get(controls.dispatches)).toBe(1);
      expect(yield* inbox.getReceiptStatus()).toMatchObject({ value: { status: "completed" } });
    }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "retains receipt when initial alarm fails before dispatch and duplicate acceptance resumes it",
    () =>
      Effect.gen(function* () {
        const controls = yield* recordingInbox;
        const inbox = yield* controls.acquire;
        yield* Ref.set(controls.alarmFailure, true);
        expect(yield* inbox.accept(receipt).pipe(Effect.result)).toMatchObject({
          failure: { reason: "schedule" },
        });
        expect(yield* inbox.getReceiptStatus()).toMatchObject({
          value: { status: "pending", attempts: 0 },
        });
        expect(yield* Ref.get(controls.dispatches)).toBe(0);
        yield* Ref.set(controls.alarmFailure, false);
        const restarted = yield* controls.acquire;
        yield* restarted.accept(receipt);
        yield* restarted.recover();
        expect(yield* restarted.getReceiptStatus()).toMatchObject({
          value: { status: "completed" },
        });
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect("uses exactly twenty persisted attempts and never reopens dead letters", () =>
    Effect.gen(function* () {
      const controls = yield* recordingInbox;
      yield* Ref.set(controls.dispatchFailure, true);
      let inbox = yield* controls.acquire;
      yield* inbox.accept(receipt);
      yield* inbox.recover();
      expect(yield* inbox.getReceiptStatus()).toMatchObject({
        value: { status: "pending", attempts: 1 },
      });
      yield* inbox.accept(receipt);
      expect(yield* Ref.get(controls.dispatches)).toBe(1);

      for (let i = 1; i < 20; i++) {
        yield* TestClock.adjust("1 hour");
        inbox = yield* controls.acquire;
        yield* inbox.recover();
      }

      expect(yield* inbox.getReceiptStatus()).toMatchObject({
        value: { status: "dead_letter", attempts: 20 },
      });
      yield* TestClock.adjust("1 hour");
      yield* inbox.accept(receipt);
      yield* inbox.recover();
      expect(yield* Ref.get(controls.dispatches)).toBe(20);
      expect(yield* Ref.get(controls.dueAt)).toEqual(Option.none());
    }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "reuses prepared chat after definite refusal instead of rerunning command mutation",
    () =>
      Effect.gen(function* () {
        const controls = yield* recordingInbox;
        yield* Ref.set(
          controls.response,
          Option.some({
            commandName: ChatCommandName.make("today"),
            message: ChatMessageText.make("Updated TypeScript"),
          }),
        );
        yield* Ref.set(
          controls.sendFailure,
          Option.some(
            new ProviderError({
              provider: "twitch",
              operation: "sendChatMessage",
              kind: "rate-limited",
              status: 429,
              retryAfterMs: Option.none(),
            }),
          ),
        );
        const inbox = yield* controls.acquire;
        yield* inbox.accept(receipt);
        yield* inbox.recover();
        expect(yield* inbox.getReceiptStatus()).toMatchObject({
          value: { status: "pending", chatCommandDelivery: { _tag: "None" } },
        });
        yield* Ref.set(controls.sendFailure, Option.none());
        yield* TestClock.adjust("2 seconds");
        const restarted = yield* controls.acquire;
        yield* restarted.recover();
        expect(yield* restarted.getReceiptStatus()).toMatchObject({
          value: { status: "completed", chatCommandDelivery: Option.some("sent") },
        });
        expect(yield* Ref.get(controls.dispatches)).toBe(1);
        expect(yield* Ref.get(controls.sends)).toBe(2);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect("records unknown chat outcome as uncertain and never resends", () =>
    Effect.gen(function* () {
      const controls = yield* recordingInbox;
      yield* Ref.set(
        controls.response,
        Option.some({
          commandName: ChatCommandName.make("today"),
          message: ChatMessageText.make("Updated TypeScript"),
        }),
      );
      yield* Ref.set(
        controls.sendFailure,
        Option.some(
          new ProviderError({
            provider: "twitch",
            operation: "sendChatMessage",
            kind: "outcome-unknown",
            status: 0,
            retryAfterMs: Option.none(),
          }),
        ),
      );
      const inbox = yield* controls.acquire;
      yield* inbox.accept(receipt);
      const restarted = yield* controls.acquire;
      yield* restarted.recover();
      yield* restarted.accept(receipt);
      expect(yield* restarted.getReceiptStatus()).toMatchObject({
        value: { status: "completed", chatCommandDelivery: Option.some("uncertain") },
      });
      expect(yield* Ref.get(controls.sends)).toBe(1);
    }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "acknowledges durable acceptance before Deferred-blocked delivery and dispatches on recovery",
    () =>
      Effect.gen(function* () {
        const controls = yield* recordingInbox;
        yield* Ref.set(
          controls.response,
          Option.some({
            commandName: ChatCommandName.make("today"),
            message: ChatMessageText.make("Updated TypeScript"),
          }),
        );
        yield* Ref.set(controls.blockSend, true);
        const inbox = yield* controls.acquire;

        const acknowledgment = yield* inbox
          .accept(chatReceipt)
          .pipe(Effect.timeout("1 second"), Effect.forkChild);

        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(acknowledgment).pipe(Effect.result)).toMatchObject({
          success: undefined,
        });
        expect(yield* inbox.getReceiptStatus()).toMatchObject({
          value: { status: "pending", attempts: 0 },
        });
        expect(yield* Ref.get(controls.sends)).toBe(0);

        const recovery = yield* inbox.recover().pipe(Effect.forkChild);
        yield* Deferred.await(controls.sendStarted);
        expect(yield* inbox.getReceiptStatus()).toMatchObject({
          value: { status: "pending", attempts: 1, chatCommandDelivery: Option.some("sending") },
        });
        yield* Deferred.succeed(controls.releaseSend, undefined);
        yield* Fiber.join(recovery);
        expect(yield* inbox.getReceiptStatus()).toMatchObject({
          value: { status: "completed", chatCommandDelivery: Option.some("sent") },
        });
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect(
    "persists sending before provider call and recovers interrupted lease as uncertain without resend",
    () =>
      Effect.gen(function* () {
        const controls = yield* recordingInbox;
        yield* Ref.set(
          controls.response,
          Option.some({
            commandName: ChatCommandName.make("today"),
            message: ChatMessageText.make("Updated TypeScript"),
          }),
        );
        yield* Ref.set(controls.blockSend, true);
        const inbox = yield* controls.acquire;
        yield* inbox.accept(chatReceipt);
        const fiber = yield* inbox.recover().pipe(Effect.forkChild);
        yield* Deferred.await(controls.sendStarted);
        expect(yield* controls.metrics.readRecordedTwitchAnalyticsCalls()).toEqual([]);
        expect(yield* inbox.getReceiptStatus()).toMatchObject({
          value: { status: "pending", attempts: 1, chatCommandDelivery: Option.some("sending") },
        });
        // A separately reconstructed service has no shared semaphore; the persisted lease alone prevents a second send.
        const concurrent = yield* controls.acquire;
        yield* concurrent.accept(chatReceipt);
        expect(yield* Ref.get(controls.sends)).toBe(1);
        yield* Fiber.interrupt(fiber);
        const restarted = yield* controls.acquire;
        yield* restarted.recover();
        expect(yield* restarted.getReceiptStatus()).toMatchObject({ value: { status: "pending" } });
        yield* TestClock.adjust("60 seconds");
        yield* restarted.recover();
        expect(yield* restarted.getReceiptStatus()).toMatchObject({
          value: { status: "completed", chatCommandDelivery: Option.some("uncertain") },
        });
        yield* restarted.accept(chatReceipt);
        expect(yield* Ref.get(controls.sends)).toBe(1);
        expect(yield* Ref.get(controls.dispatches)).toBe(1);
        expect(yield* controls.metrics.readRecordedTwitchAnalyticsCalls()).toMatchObject([
          { _tag: "ChatCommandMetric", metric: { status: "error", error: { _tag: "Some" } } },
        ]);
      }).pipe(Effect.provide(sqlite)),
  );

  it.effect("rejects persisted receipt corruption instead of dispatching from a stale copy", () =>
    Effect.gen(function* () {
      const controls = yield* recordingInbox;
      const inbox = yield* controls.acquire;
      yield* inbox.accept(receipt);
      yield* inbox.recover();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE eventsub_receipts SET receipt_json='{broken'`;
      const restarted = yield* controls.acquire;
      expect(yield* restarted.accept(receipt).pipe(Effect.result)).toMatchObject({
        failure: { reason: "corrupt" },
      });
      expect(yield* restarted.recover().pipe(Effect.result)).toMatchObject({
        failure: { reason: "corrupt" },
      });
      expect(yield* Ref.get(controls.dispatches)).toBe(1);
    }).pipe(Effect.provide(sqlite)),
  );
});
