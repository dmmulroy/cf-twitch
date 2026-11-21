import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { DomainEvent, encodeDomainEventJson } from "@cf-twitch/contracts/domain-event";
import { EventId, IsoTimestamp, PageSize } from "@cf-twitch/contracts/identity";
import { EventBusError } from "@cf-twitch/contracts/event-bus";
import { EventBusAlarm } from "./event-bus-alarm.ts";
import {
  EventBusDatabase,
  eventBusDatabaseLayer,
  eventBusDatabaseTestLayer,
} from "./event-bus-database.ts";
import { EventHandler, EventHandlerError } from "./event-handler.ts";
import { EventBus, eventBusLayerWithoutDependencies } from "./event-bus.ts";

const eventId = Schema.decodeUnknownSync(EventId)("550e8400-e29b-41d4-a716-446655440000");

const replayEventId = Schema.decodeUnknownSync(EventId)("550e8400-e29b-41d4-a716-446655440001");

const timestamp = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T12:00:00.000Z");

const event = Schema.decodeUnknownSync(DomainEvent)({
  id: eventId,
  type: "song_request_success",
  v: 1,
  timestamp,
  source: "SongRequestSagaDO",
  userId: "viewer-1",
  userDisplayName: "Viewer",
  sagaId: "redemption-1",
  trackId: "abc123",
});

const replayEvent = DomainEvent.make({ ...event, id: replayEventId });

const firstPage = { limit: PageSize.make(10), offset: 0 };

const timestampAfter = (milliseconds: number): IsoTimestamp =>
  Schema.decodeUnknownSync(IsoTimestamp)(
    new Date(Date.parse(timestamp) + milliseconds).toISOString(),
  );

// The in-memory database Layer must cross the same interface with the same Event Bus behavior as SQLite.
const databaseLayers = [
  {
    store: "SQLite",
    databaseLayer: eventBusDatabaseLayer.pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  },
  { store: "in-memory test", databaseLayer: eventBusDatabaseTestLayer },
];

describe.each(databaseLayers)("Event Bus ($store database)", ({ databaseLayer }) => {
  const makeEventBusTestLayer = (
    handler: EventHandler["Service"],
    alarmUpdates: Ref.Ref<ReadonlyArray<Option.Option<IsoTimestamp>>>,
  ) => {
    const applicationLayer = eventBusLayerWithoutDependencies.pipe(
      Layer.provide(databaseLayer),
      Layer.provide(Layer.succeed(EventHandler, handler)),
      Layer.provide(
        Layer.succeed(
          EventBusAlarm,
          EventBusAlarm.of({
            scheduleAt: (scheduledAt) =>
              Ref.update(alarmUpdates, (updates) => [...updates, Option.some(scheduledAt)]),
            clear: () => Ref.update(alarmUpdates, (updates) => [...updates, Option.none()]),
          }),
        ),
      ),
    );

    return Layer.merge(databaseLayer, applicationLayer);
  };

  it.effect("deduplicates producer retries after a transactional delivery receipt", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const alarmUpdates = yield* Ref.make<ReadonlyArray<Option.Option<IsoTimestamp>>>([]);

      const layer = makeEventBusTestLayer(
        EventHandler.of({
          handleDomainEvent: () => Ref.update(calls, (count) => count + 1),
        }),
        alarmUpdates,
      );

      yield* Effect.gen(function* () {
        const eventBus = yield* EventBus;
        const database = yield* EventBusDatabase;
        yield* eventBus.publish(event);
        yield* eventBus.publish(event);

        expect(yield* Ref.get(calls)).toBe(1);
        expect((yield* database.counts()).deliveredCount).toBe(1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries only when due at 1, 4, and 16 seconds before the 30-day DLQ", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(timestamp));
      const alarmUpdates = yield* Ref.make<ReadonlyArray<Option.Option<IsoTimestamp>>>([]);

      const layer = makeEventBusTestLayer(
        EventHandler.of({
          handleDomainEvent: (delivered) =>
            Effect.fail(
              new EventHandlerError({
                operation: "handleDomainEvent",
                reason: "consumer_unavailable",
                eventId: delivered.id,
                eventType: delivered.type,
              }),
            ),
        }),
        alarmUpdates,
      );

      yield* Effect.gen(function* () {
        const eventBus = yield* EventBus;
        const database = yield* EventBusDatabase;

        yield* eventBus.publish(event);
        expect((yield* database.listPending(firstPage)).rows[0]?.attempts).toBe(0);
        expect(yield* Ref.get(alarmUpdates)).toContainEqual(Option.some(timestampAfter(1_000)));

        yield* TestClock.adjust(999);
        yield* eventBus.processDue();
        expect((yield* database.listPending(firstPage)).rows[0]?.attempts).toBe(0);

        yield* TestClock.adjust(1);
        yield* eventBus.processDue();
        expect((yield* database.listPending(firstPage)).rows[0]).toMatchObject({
          attempts: 1,
          next_retry_at: timestampAfter(5_000),
        });

        yield* TestClock.adjust(4_000);
        yield* eventBus.processDue();
        expect((yield* database.listPending(firstPage)).rows[0]).toMatchObject({
          attempts: 2,
          next_retry_at: timestampAfter(21_000),
        });

        yield* TestClock.adjust(16_000);
        yield* eventBus.processDue();
        const terminal = (yield* database.listDeadLetters(firstPage)).rows[0];
        expect(terminal?.attempts).toBe(3);
        expect(terminal?.error).toBe(
          new EventBusError({
            operation: "retryDue",
            reason: "subscriber_unavailable",
            eventId: Option.some(eventId),
          }).message,
        );
        expect(
          new Date(terminal?.expires_at ?? 0).getTime() -
            new Date(terminal?.last_failed_at ?? 0).getTime(),
        ).toBe(30 * 24 * 60 * 60 * 1_000);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("quarantines corrupt pending evidence and continues valid due delivery", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(timestamp));
      const alarmUpdates = yield* Ref.make<ReadonlyArray<Option.Option<IsoTimestamp>>>([]);

      const layer = makeEventBusTestLayer(
        EventHandler.of({ handleDomainEvent: () => Effect.void }),
        alarmUpdates,
      );

      yield* Effect.gen(function* () {
        const database = yield* EventBusDatabase;
        const eventBus = yield* EventBus;
        const encodedReplayEvent = yield* encodeDomainEventJson(replayEvent);

        yield* database.accept({
          eventId,
          encodedEvent: "{corrupt-event-json",
          now: timestamp,
          firstRetryAt: timestamp,
        });
        yield* database.accept({
          eventId: replayEventId,
          encodedEvent: encodedReplayEvent,
          now: timestamp,
          firstRetryAt: timestamp,
        });

        yield* eventBus.processDue();

        const counts = yield* database.counts();
        expect(counts).toMatchObject({
          pendingCount: 0,
          deadLetterCount: 1,
          deliveredCount: 1,
        });
        const deadLetters = yield* database.listDeadLetters(firstPage);
        expect(deadLetters.rows[0]).toMatchObject({
          id: eventId,
          event: "{corrupt-event-json",
          error: new EventBusError({
            operation: "retryDue",
            reason: "stored_event_invalid",
            eventId: Option.some(eventId),
          }).message,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("projects valid and corrupt administrative event evidence as Options", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(timestamp));
      const alarmUpdates = yield* Ref.make<ReadonlyArray<Option.Option<IsoTimestamp>>>([]);

      const layer = makeEventBusTestLayer(
        EventHandler.of({ handleDomainEvent: () => Effect.void }),
        alarmUpdates,
      );

      yield* Effect.gen(function* () {
        const database = yield* EventBusDatabase;
        const eventBus = yield* EventBus;
        const encodedReplayEvent = yield* encodeDomainEventJson(replayEvent);
        yield* database.accept({
          eventId,
          encodedEvent: "{corrupt-event-json",
          now: timestamp,
          firstRetryAt: timestampAfter(10_000),
        });
        yield* database.accept({
          eventId: replayEventId,
          encodedEvent: encodedReplayEvent,
          now: timestamp,
          firstRetryAt: timestampAfter(10_000),
        });

        const pending = yield* eventBus.listPending(firstPage);

        expect(pending.items.map((item) => item.event)).toEqual([
          Option.none(),
          Option.some(replayEvent),
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("serializes concurrent due processing before external delivery", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(timestamp));
      const alarmUpdates = yield* Ref.make<ReadonlyArray<Option.Option<IsoTimestamp>>>([]);
      const deliveryCount = yield* Ref.make(0);
      const firstDeliveryEntered = yield* Deferred.make<void>();
      const concurrentDeliveryEntered = yield* Deferred.make<void>();

      const layer = makeEventBusTestLayer(
        EventHandler.of({
          handleDomainEvent: () =>
            Effect.gen(function* () {
              const delivery = yield* Ref.getAndUpdate(deliveryCount, (count) => count + 1);

              if (delivery === 0) {
                yield* Deferred.succeed(firstDeliveryEntered, undefined);
                yield* Effect.never;
              } else {
                yield* Deferred.succeed(concurrentDeliveryEntered, undefined);
              }
            }),
        }),
        alarmUpdates,
      );

      yield* Effect.gen(function* () {
        const database = yield* EventBusDatabase;
        const eventBus = yield* EventBus;
        const encodedEvent = yield* encodeDomainEventJson(event);
        yield* database.accept({
          eventId,
          encodedEvent,
          now: timestamp,
          firstRetryAt: timestamp,
        });

        const first = yield* Effect.forkChild(eventBus.processDue());
        yield* Deferred.await(firstDeliveryEntered);
        const second = yield* Effect.forkChild(eventBus.processDue());
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        expect(yield* Deferred.isDone(concurrentDeliveryEntered)).toBe(false);
        yield* Fiber.interrupt(first);
        yield* Fiber.join(second);
        expect(yield* Ref.get(deliveryCount)).toBe(2);
        expect((yield* database.counts()).deliveredCount).toBe(1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reports retry and dead-letter wake times from their separate authorities", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(timestamp));
      const alarmUpdates = yield* Ref.make<ReadonlyArray<Option.Option<IsoTimestamp>>>([]);

      const layer = makeEventBusTestLayer(
        EventHandler.of({ handleDomainEvent: () => Effect.void }),
        alarmUpdates,
      );

      yield* Effect.gen(function* () {
        const database = yield* EventBusDatabase;
        const eventBus = yield* EventBus;
        const encodedEvent = yield* encodeDomainEventJson(event);
        const encodedReplayEvent = yield* encodeDomainEventJson(replayEvent);
        yield* database.accept({
          eventId,
          encodedEvent,
          now: timestamp,
          firstRetryAt: timestampAfter(10_000),
        });
        yield* database.accept({
          eventId: replayEventId,
          encodedEvent: encodedReplayEvent,
          now: timestamp,
          firstRetryAt: timestampAfter(5_000),
        });
        const deadLetterPending = yield* database.findPending(replayEventId);

        if (Option.isNone(deadLetterPending)) return yield* Effect.die("expected pending event");
        yield* database.moveToDeadLetter({
          pending: deadLetterPending.value,
          error: "Event subscriber unavailable",
          attempts: 3,
          failedAt: timestamp,
          expiresAt: timestampAfter(20_000),
        });

        const status = yield* eventBus.getStatus();
        expect(status.nextRetryAt).toEqual(Option.some(timestampAfter(10_000)));
        expect(status.nextDeadLetterExpiryAt).toEqual(Option.some(timestampAfter(20_000)));
      }).pipe(Effect.provide(layer));
    }),
  );
});
