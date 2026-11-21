import { Clock, Context, Effect, Layer, Option, Result, Schema, Semaphore } from "effect";
import {
  encodeDomainEventJson,
  parseDomainEventJson,
  type DomainEvent,
} from "@cf-twitch/contracts/domain-event";
import {
  EventBusError,
  type DeadLetterEventItem,
  type EventBusOperation,
  type EventBusSubscription,
  type PendingEventItem,
} from "@cf-twitch/contracts/event-bus";
import { IsoTimestamp, type EventId } from "@cf-twitch/contracts/identity";
import type { IEventBusAdministration } from "./event-bus-administration.ts";
import { EventBusAlarm, eventBusAlarmLayer, eventBusAlarmTestLayer } from "./event-bus-alarm.ts";
import {
  EventBusDatabase,
  eventBusDatabaseLayer,
  eventBusDatabaseTestLayer,
  type DeadLetterRow,
  type PendingEventRow,
  type SubscriptionRow,
} from "./event-bus-database.ts";
import {
  EventHandler,
  eventHandlerLayerWithoutDependencies,
  eventHandlerTestLayer,
} from "./event-handler.ts";
import type { IEventPublisher } from "./event-publisher.ts";

/** Event Bus authority inside `EventBusDO`: publication, administration, and alarm-driven retry processing. */
export interface IEventBus extends IEventPublisher, IEventBusAdministration {
  /**
   * Delivers every due pending event, dead-letters exhausted or unreadable ones, purges expired
   * dead letters, and reschedules the alarm.
   *
   * **Details**
   *
   * Runs one batch at a time. A subscriber failure reschedules the delivery with 1, 4, and 16 second
   * backoff before it is dead-lettered for 30 days; it does not fail the batch.
   *
   * @returns Nothing, or fails with `EventBusError` when storage or the alarm is unavailable.
   */
  readonly processDue: () => Effect.Effect<void, EventBusError>;
  /**
   * Schedules the alarm for the earliest retry or dead-letter expiry, or clears it when none remain.
   *
   * @returns Nothing, or fails with `EventBusError` when storage or the alarm is unavailable.
   */
  readonly rebuildAlarm: () => Effect.Effect<void, EventBusError>;
}

/** Service for the Event Bus authority hosted by `EventBusDO`. */
export class EventBus extends Context.Service<EventBus, IEventBus>()("@cf-twitch/EventBus") {}

const MAX_ATTEMPTS = 3;

const BACKOFF_DELAYS_MS = [1_000, 4_000, 16_000] as const;

const DLQ_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const eventBusError = (
  operation: EventBusOperation,
  reason: EventBusError["reason"],
  eventId: Option.Option<EventId> = Option.none(),
) => new EventBusError({ operation, reason, eventId });

const parseComputedTimestamp = Schema.decodeEffect(IsoTimestamp);

// Clock arithmetic always yields a valid ISO instant; a refinement failure would be a runtime defect.
const timestampAt = (epochMillis: number) =>
  parseComputedTimestamp(new Date(epochMillis).toISOString()).pipe(Effect.orDie);

const nowAndAfter = (delayMillis: number) =>
  Effect.gen(function* () {
    const nowMillis = yield* Clock.currentTimeMillis;

    return {
      now: yield* timestampAt(nowMillis),
      after: yield* timestampAt(nowMillis + delayMillis),
    };
  });

const subscriptionFromRow = (row: SubscriptionRow): EventBusSubscription => ({
  id: row.id,
  subscriber: row.subscriber,
  eventType: row.event_type,
  createdAt: row.created_at,
});

// Administration lists keep unreadable stored events visible as `Option.none()` instead of failing the page.
const decodeEventOption = (encoded: string) => parseDomainEventJson(encoded).pipe(Effect.option);

const pendingItemFromRow = (row: PendingEventRow): Effect.Effect<PendingEventItem> =>
  decodeEventOption(row.event).pipe(
    Effect.map((event) => ({
      id: row.id,
      event,
      attempts: row.attempts,
      nextRetryAt: row.next_retry_at,
      createdAt: row.created_at,
    })),
  );

const deadLetterItemFromRow = (row: DeadLetterRow): Effect.Effect<DeadLetterEventItem> =>
  decodeEventOption(row.event).pipe(
    Effect.map((event) => ({
      id: row.id,
      event,
      error: row.error,
      attempts: row.attempts,
      firstFailedAt: row.first_failed_at,
      lastFailedAt: row.last_failed_at,
      expiresAt: row.expires_at,
    })),
  );

/**
 * Creates the Event Bus authority over its database, event handler, and alarm.
 *
 * @returns The Event Bus service; constructing it does not fail.
 */
export const makeEventBus = Effect.gen(function* () {
  const database = yield* EventBusDatabase;
  const handler = yield* EventHandler;
  const alarm = yield* EventBusAlarm;
  const dueProcessingSemaphore = yield* Semaphore.make(1);

  const rebuildAlarm = Effect.fn("EventBus.rebuildAlarm")(function* () {
    const wakeAt = yield* database.earliestWakeAt();

    if (Option.isSome(wakeAt)) yield* alarm.scheduleAt(wakeAt.value);
    else yield* alarm.clear();
  });

  // Fails with `subscriber_unavailable` or `subscriber_rejected` when a subscribed consumer does not accept the event.
  const deliver = Effect.fn("EventBus.deliver")(function* (
    event: DomainEvent,
    operation: EventBusOperation,
  ) {
    const subscriptions = yield* database.listSubscriptions();

    if (subscriptions.some((subscription) => subscription.event_type === event.type)) {
      yield* handler
        .handleDomainEvent(event)
        .pipe(
          Effect.catchTag("EventHandlerError", (error) =>
            Effect.fail(
              eventBusError(
                operation,
                error.reason === "consumer_unavailable"
                  ? "subscriber_unavailable"
                  : "subscriber_rejected",
                Option.some(event.id),
              ),
            ),
          ),
        );
    }
  });

  // The database labels failures by its own step; the receipt belongs to the caller's operation and event.
  const recordSuccess = Effect.fn("EventBus.recordSuccess")(function* (
    eventId: EventId,
    operation: EventBusOperation,
  ) {
    const { now } = yield* nowAndAfter(0);
    yield* database
      .recordDelivered({ eventId, deliveredAt: now })
      .pipe(
        Effect.catchTag("EventBusError", (error) =>
          Effect.fail(eventBusError(operation, error.reason, Option.some(eventId))),
        ),
      );
  });

  // Subscriber failures reschedule or dead-letter the row; only storage failures fail this step.
  const processPending = Effect.fn("EventBus.processPending")(function* (pending: PendingEventRow) {
    const attempt = pending.attempts + 1;
    const decodedEvent = yield* Effect.result(parseDomainEventJson(pending.event));

    if (Result.isFailure(decodedEvent)) {
      const { now, after: expiresAt } = yield* nowAndAfter(DLQ_RETENTION_MS);
      yield* database.moveToDeadLetter({
        pending,
        error: eventBusError("retryDue", "stored_event_invalid", Option.some(pending.id)).message,
        attempts: attempt,
        failedAt: now,
        expiresAt,
      });

      return;
    }

    const result = yield* Effect.result(deliver(decodedEvent.success, "retryDue"));

    if (Result.isSuccess(result)) {
      yield* recordSuccess(decodedEvent.success.id, "retryDue");

      return;
    }

    if (attempt >= MAX_ATTEMPTS) {
      const { now, after: expiresAt } = yield* nowAndAfter(DLQ_RETENTION_MS);
      yield* database.moveToDeadLetter({
        pending,
        error: result.failure.message,
        attempts: attempt,
        failedAt: now,
        expiresAt,
      });

      return;
    }

    const delay = BACKOFF_DELAYS_MS[attempt] ?? BACKOFF_DELAYS_MS.at(-1) ?? 16_000;
    const { after: nextRetryAt } = yield* nowAndAfter(delay);
    yield* database.reschedule({ eventId: pending.id, attempts: attempt, nextRetryAt });
  });

  const processDueWithoutPermit = Effect.fn("EventBus.processDueWithoutPermit")(function* () {
    const { now } = yield* nowAndAfter(0);
    const due = yield* database.listDue(now);

    for (const pending of due) {
      yield* processPending(pending);
    }

    yield* database.purgeExpiredDeadLetters(now);
    yield* rebuildAlarm();
  });

  const processDue: IEventBus["processDue"] = Effect.fn("EventBus.processDue")(() =>
    dueProcessingSemaphore.withPermit(processDueWithoutPermit()),
  );

  const publish: IEventBus["publish"] = Effect.fn("EventBus.publish")(function* (event) {
    const encodedEvent = yield* encodeDomainEventJson(event).pipe(
      Effect.mapError(() => eventBusError("publish", "event_invalid", Option.some(event.id))),
    );

    const { now, after: firstRetryAt } = yield* nowAndAfter(BACKOFF_DELAYS_MS[0]);

    const acceptance = yield* database.accept({
      eventId: event.id,
      encodedEvent,
      now,
      firstRetryAt,
    });

    if (acceptance !== "accepted") {
      yield* rebuildAlarm();

      return;
    }

    // An accepted event is durable; a subscriber outage leaves it pending for the alarm to retry.
    const delivery = yield* Effect.result(deliver(event, "publish"));

    if (Result.isSuccess(delivery)) yield* recordSuccess(event.id, "publish");
    yield* rebuildAlarm();
  });

  const replayDeadLetter: IEventBus["replayDeadLetter"] = Effect.fn("EventBus.replayDeadLetter")(
    function* (input) {
      const dead = yield* database.findDeadLetter(input.eventId);

      if (Option.isNone(dead)) {
        return yield* eventBusError(
          "replayDeadLetter",
          "event_not_found",
          Option.some(input.eventId),
        );
      }

      const event = yield* parseDomainEventJson(dead.value.event).pipe(
        Effect.mapError(() =>
          eventBusError("replayDeadLetter", "stored_event_invalid", Option.some(input.eventId)),
        ),
      );

      const delivery = yield* Effect.result(deliver(event, "replayDeadLetter"));

      if (Result.isSuccess(delivery)) {
        yield* recordSuccess(event.id, "replayDeadLetter");
        yield* rebuildAlarm();

        return { success: true, eventId: input.eventId, error: Option.none() };
      }

      const { now } = yield* nowAndAfter(0);
      const message = delivery.failure.message;
      yield* database.recordDeadLetterReplayFailure({
        eventId: input.eventId,
        error: message,
        failedAt: now,
      });
      yield* rebuildAlarm();

      return { success: false, eventId: input.eventId, error: Option.some(message) };
    },
  );

  const retryPending: IEventBus["retryPending"] = Effect.fn("EventBus.retryPending")(
    function* (input) {
      const pending = yield* database.findPending(input.eventId);

      if (Option.isNone(pending)) {
        return yield* eventBusError("retryPending", "event_not_found", Option.some(input.eventId));
      }

      const { now } = yield* nowAndAfter(0);
      yield* database.reschedule({
        eventId: input.eventId,
        attempts: pending.value.attempts,
        nextRetryAt: now,
      });
      yield* processDue();
    },
  );

  return EventBus.of({
    publish,
    processDue,
    rebuildAlarm,
    replayDeadLetter,
    retryPending,
    getStats: Effect.fn("EventBus.getStats")(function* () {
      return yield* database.counts();
    }),
    getStatus: Effect.fn("EventBus.getStatus")(function* () {
      const [stats, nextRetryAt, nextDeadLetterExpiryAt] = yield* Effect.all([
        database.counts(),
        database.earliestRetryAt(),
        database.earliestDeadLetterExpiryAt(),
      ]);

      return { healthy: true, nextRetryAt, nextDeadLetterExpiryAt, stats };
    }),
    listPending: Effect.fn("EventBus.listPending")(function* (input) {
      const page = yield* database.listPending(input);

      return {
        items: yield* Effect.all(page.rows.map(pendingItemFromRow)),
        totalCount: page.totalCount,
        limit: input.limit,
        offset: input.offset,
      };
    }),
    listDeadLetters: Effect.fn("EventBus.listDeadLetters")(function* (input) {
      const page = yield* database.listDeadLetters(input);

      return {
        items: yield* Effect.all(page.rows.map(deadLetterItemFromRow)),
        totalCount: page.totalCount,
        limit: input.limit,
        offset: input.offset,
      };
    }),
    deleteDeadLetter: Effect.fn("EventBus.deleteDeadLetter")(function* (input) {
      if (!(yield* database.deleteDeadLetter(input.eventId))) {
        return yield* eventBusError(
          "deleteDeadLetter",
          "event_not_found",
          Option.some(input.eventId),
        );
      }

      yield* rebuildAlarm();
    }),
    purgeExpiredDeadLetters: Effect.fn("EventBus.purgeExpiredDeadLetters")(function* () {
      const { now } = yield* nowAndAfter(0);
      const count = yield* database.purgeExpiredDeadLetters(now);
      yield* rebuildAlarm();

      return count;
    }),
    listSubscriptions: Effect.fn("EventBus.listSubscriptions")(function* () {
      return (yield* database.listSubscriptions()).map(subscriptionFromRow);
    }),
    registerSubscription: Effect.fn("EventBus.registerSubscription")(function* (input) {
      const { now } = yield* nowAndAfter(0);

      return (yield* database.registerSubscriptions({
        subscriber: input.subscriber,
        eventTypes: input.eventTypes,
        createdAt: now,
      })).map(subscriptionFromRow);
    }),
    unregisterSubscription: Effect.fn("EventBus.unregisterSubscription")(function* (input) {
      if (!(yield* database.unregisterSubscription(input.subscriptionId))) {
        return yield* new EventBusError({
          operation: "unregisterSubscription",
          reason: "subscription_not_found",
          eventId: Option.none(),
          subscriptionId: Option.some(input.subscriptionId),
        });
      }
    }),
    reset: Effect.fn("EventBus.reset")(function* () {
      yield* database.reset();
      yield* alarm.clear();
    }),
  });
});

/** Layer that provides the Event Bus and keeps its database, event handler, and alarm requirements visible. */
export const eventBusLayerWithoutDependencies = Layer.effect(EventBus, makeEventBus);

/**
 * Production Event Bus Layer selecting SQLite persistence, the native alarm, and Achievement routing.
 *
 * **Details**
 *
 * Still requires the Durable Object's SQL client and state, which exist only in the runtime phase,
 * and `Achievements`, which `EventBusServer` captures during outer initialization and bridges in.
 */
export const eventBusLayer = eventBusLayerWithoutDependencies.pipe(
  Layer.provide([eventBusDatabaseLayer, eventBusAlarmLayer, eventHandlerLayerWithoutDependencies]),
);

/** Layer that provides a complete in-memory Event Bus with an always-available subscriber and a recording alarm. */
export const eventBusTestLayer = eventBusLayerWithoutDependencies.pipe(
  Layer.provide([eventBusDatabaseTestLayer, eventBusAlarmTestLayer, eventHandlerTestLayer]),
);
