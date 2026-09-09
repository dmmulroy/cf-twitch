import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { DomainEvent, encodeDomainEventJson } from "@cf-twitch/contracts/domain-event";
import { EventId, IsoTimestamp, PageSize } from "@cf-twitch/contracts/identity";
import {
  EventBusDatabase,
  eventBusDatabaseLayerWithoutDependencies,
} from "./event-bus-database.ts";
import {
  EventBusAdministration,
  EventHandler,
  EventHandlerError,
  EventPublisher,
} from "./event-bus-service.ts";
import { EventBusAlarm, EventBusProcessor, eventBusLayerWithoutDependencies } from "./event-bus.ts";

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

const makeEventBusTestLayer = (
  handler: EventHandler["Service"],
  alarmUpdates: Ref.Ref<ReadonlyArray<Option.Option<IsoTimestamp>>>,
) => {
  const databaseLayer = eventBusDatabaseLayerWithoutDependencies.pipe(
    Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
  );

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

describe("Event Bus", () => {
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
        const publisher = yield* EventPublisher;
        const database = yield* EventBusDatabase;
        yield* publisher.publish(event);
        yield* publisher.publish(event);

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
          handleDomainEvent: () =>
            Effect.fail(new EventHandlerError({ reason: "consumer_unavailable" })),
        }),
        alarmUpdates,
      );

      yield* Effect.gen(function* () {
        const publisher = yield* EventPublisher;
        const processor = yield* EventBusProcessor;
        const database = yield* EventBusDatabase;

        yield* publisher.publish(event);
        expect((yield* database.listPending(firstPage)).rows[0]?.attempts).toBe(0);
        expect(yield* Ref.get(alarmUpdates)).toContainEqual(Option.some(timestampAfter(1_000)));

        yield* TestClock.adjust(999);
        yield* processor.processDue();
        expect((yield* database.listPending(firstPage)).rows[0]?.attempts).toBe(0);

        yield* TestClock.adjust(1);
        yield* processor.processDue();
        expect((yield* database.listPending(firstPage)).rows[0]).toMatchObject({
          attempts: 1,
          next_retry_at: timestampAfter(5_000),
        });

        yield* TestClock.adjust(4_000);
        yield* processor.processDue();
        expect((yield* database.listPending(firstPage)).rows[0]).toMatchObject({
          attempts: 2,
          next_retry_at: timestampAfter(21_000),
        });

        yield* TestClock.adjust(16_000);
        yield* processor.processDue();
        const terminal = (yield* database.listDeadLetters(firstPage)).rows[0];
        expect(terminal?.attempts).toBe(3);
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
        const processor = yield* EventBusProcessor;
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

        yield* processor.processDue();

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
          error: "Stored Event Bus delivery is invalid",
        });
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
        const administration = yield* EventBusAdministration;
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

        const status = yield* administration.getStatus();
        expect(status.nextRetryAt).toEqual(Option.some(timestampAfter(10_000)));
        expect(status.nextDeadLetterExpiryAt).toEqual(Option.some(timestampAfter(20_000)));
      }).pipe(Effect.provide(layer));
    }),
  );
});
