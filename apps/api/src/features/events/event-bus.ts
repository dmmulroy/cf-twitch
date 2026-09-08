import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import {
  encodeDomainEventJson,
  parseDomainEventJson,
  type DomainEvent,
} from "@cf-twitch/contracts/domain-event";
import {
  EventBusError,
  type DeadLetterEventItem,
  type EventBusSubscription,
  type PendingEventItem,
} from "@cf-twitch/contracts/event-bus";
import { IsoTimestamp, type EventId } from "@cf-twitch/contracts/identity";
import {
  EventBusDatabase,
  type DeadLetterRow,
  type PendingEventRow,
  type SubscriptionRow,
} from "./event-bus-database.ts";
import {
  EventBusAdministration,
  EventHandler,
  EventPublisher,
  type IEventBusAdministration,
  type IEventPublisher,
} from "./event-bus-service.ts";

const MAX_ATTEMPTS = 3;
const BACKOFF_DELAYS_MS = [1_000, 4_000, 16_000] as const;
const DLQ_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** Alarm capability used to rebuild retry and DLQ timers from SQLite authority. */
export interface IEventBusAlarm {
  readonly scheduleAt: (timestamp: IsoTimestamp) => Effect.Effect<void, EventBusError>;
  readonly clear: () => Effect.Effect<void, EventBusError>;
}

/** Event Bus wake-up boundary backed by Durable Object storage alarms. */
export class EventBusAlarm extends Context.Service<EventBusAlarm, IEventBusAlarm>()(
  "@cf-twitch/EventBusAlarm",
) {}

/** Recovery operation invoked by the physical Durable Object alarm. */
export interface IEventBusProcessor {
  readonly processDue: () => Effect.Effect<void, EventBusError>;
  readonly rebuildAlarm: () => Effect.Effect<void, EventBusError>;
}

/** Event Bus retry and cleanup processor. */
export class EventBusProcessor extends Context.Service<EventBusProcessor, IEventBusProcessor>()(
  "@cf-twitch/EventBusProcessor",
) {}

const eventBusError = (
  operation: EventBusError["operation"],
  reason: EventBusError["reason"],
  eventId: Option.Option<EventId> = Option.none(),
) => new EventBusError({ operation, reason, eventId });

const parseComputedTimestamp = Schema.decodeEffect(IsoTimestamp);

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

const decodeEventOption = (encoded: string) =>
  parseDomainEventJson(encoded).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none<DomainEvent>())),
  );

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

/** Construct Event Bus publication, administration, and alarm processing services. */
export const makeEventBus = Effect.gen(function* () {
  const database = yield* EventBusDatabase;
  const handler = yield* EventHandler;
  const alarm = yield* EventBusAlarm;

  const rebuildAlarm = Effect.fn("EventBus.rebuildAlarm")(function* () {
    const wakeAt = yield* database.earliestWakeAt();
    if (Option.isSome(wakeAt)) yield* alarm.scheduleAt(wakeAt.value);
    else yield* alarm.clear();
  });

  const deliver = Effect.fn("EventBus.deliver")(function* (
    event: DomainEvent,
    operation: EventBusError["operation"],
  ) {
    const subscriptions = yield* database.listSubscriptions();
    if (subscriptions.some((subscription) => subscription.event_type === event.type)) {
      yield* handler
        .handleDomainEvent(event)
        .pipe(
          Effect.mapError(() =>
            eventBusError(operation, "subscriber_unavailable", Option.some(event.id)),
          ),
        );
    }
  });

  const recordSuccess = Effect.fn("EventBus.recordSuccess")(function* (
    eventId: EventId,
    operation: EventBusError["operation"],
  ) {
    const { now } = yield* nowAndAfter(0);
    yield* database
      .recordDelivered({ eventId, deliveredAt: now })
      .pipe(
        Effect.mapError(() =>
          eventBusError(operation, "persistence_unavailable", Option.some(eventId)),
        ),
      );
  });

  const processPending = Effect.fn("EventBus.processPending")(function* (pending: PendingEventRow) {
    const attempt = pending.attempts + 1;
    const decodedEvent = yield* Effect.result(parseDomainEventJson(pending.event));
    if (decodedEvent._tag === "Failure") {
      const { now, after: expiresAt } = yield* nowAndAfter(DLQ_RETENTION_MS);
      yield* database.moveToDeadLetter({
        pending,
        error: "Stored Event Bus delivery is invalid",
        attempts: attempt,
        failedAt: now,
        expiresAt,
      });
      return;
    }
    const result = yield* Effect.result(deliver(decodedEvent.success, "retryDue"));
    if (result._tag === "Success") {
      yield* recordSuccess(decodedEvent.success.id, "retryDue");
      return;
    }

    if (attempt >= MAX_ATTEMPTS) {
      const { now, after: expiresAt } = yield* nowAndAfter(DLQ_RETENTION_MS);
      yield* database.moveToDeadLetter({
        pending,
        error: "Event subscriber unavailable",
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

  const processDue = Effect.fn("EventBus.processDue")(function* () {
    const { now } = yield* nowAndAfter(0);
    const due = yield* database.listDue(now);
    for (const pending of due) {
      yield* processPending(pending);
    }
    yield* database.purgeExpiredDeadLetters(now);
    yield* rebuildAlarm();
  });

  const publisher: IEventPublisher = {
    publish: Effect.fn("EventPublisher.publish")(function* (event) {
      const encodedEvent = yield* encodeDomainEventJson(event).pipe(
        Effect.mapError(() =>
          eventBusError("publish", "stored_event_invalid", Option.some(event.id)),
        ),
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

      const delivery = yield* Effect.result(deliver(event, "publish"));
      if (delivery._tag === "Success") yield* recordSuccess(event.id, "publish");
      yield* rebuildAlarm();
    }),
  };

  const administration: IEventBusAdministration = {
    getStats: Effect.fn("EventBusAdministration.getStats")(function* () {
      return yield* database.counts();
    }),
    getStatus: Effect.fn("EventBusAdministration.getStatus")(function* () {
      const [stats, nextRetryAt, nextDeadLetterExpiryAt] = yield* Effect.all([
        database.counts(),
        database.earliestRetryAt(),
        database.earliestDeadLetterExpiryAt(),
      ]);
      return {
        healthy: true,
        nextRetryAt,
        nextDeadLetterExpiryAt,
        stats,
      };
    }),
    listPending: Effect.fn("EventBusAdministration.listPending")(function* (input) {
      const page = yield* database.listPending(input);
      return {
        items: yield* Effect.all(page.rows.map(pendingItemFromRow)),
        totalCount: page.totalCount,
        limit: input.limit,
        offset: input.offset,
      };
    }),
    listDeadLetters: Effect.fn("EventBusAdministration.listDeadLetters")(function* (input) {
      const page = yield* database.listDeadLetters(input);
      return {
        items: yield* Effect.all(page.rows.map(deadLetterItemFromRow)),
        totalCount: page.totalCount,
        limit: input.limit,
        offset: input.offset,
      };
    }),
    replayDeadLetter: Effect.fn("EventBusAdministration.replayDeadLetter")(function* (input) {
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
      if (delivery._tag === "Success") {
        yield* recordSuccess(event.id, "replayDeadLetter");
        yield* rebuildAlarm();
        return { success: true, eventId: input.eventId, error: Option.none() };
      }
      const { now } = yield* nowAndAfter(0);
      const message = "Event subscriber unavailable";
      yield* database.recordDeadLetterReplayFailure({
        eventId: input.eventId,
        error: message,
        failedAt: now,
      });
      yield* rebuildAlarm();
      return { success: false, eventId: input.eventId, error: Option.some(message) };
    }),
    retryPending: Effect.fn("EventBusAdministration.retryPending")(function* (input) {
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
    }),
    deleteDeadLetter: Effect.fn("EventBusAdministration.deleteDeadLetter")(function* (input) {
      if (!(yield* database.deleteDeadLetter(input.eventId))) {
        return yield* eventBusError(
          "deleteDeadLetter",
          "event_not_found",
          Option.some(input.eventId),
        );
      }
      yield* rebuildAlarm();
    }),
    purgeExpiredDeadLetters: Effect.fn("EventBusAdministration.purgeExpiredDeadLetters")(
      function* () {
        const { now } = yield* nowAndAfter(0);
        const count = yield* database.purgeExpiredDeadLetters(now);
        yield* rebuildAlarm();
        return count;
      },
    ),
    listSubscriptions: Effect.fn("EventBusAdministration.listSubscriptions")(function* () {
      return (yield* database.listSubscriptions()).map(subscriptionFromRow);
    }),
    registerSubscription: Effect.fn("EventBusAdministration.registerSubscription")(
      function* (input) {
        const { now } = yield* nowAndAfter(0);
        return (yield* database.registerSubscriptions({
          subscriber: input.subscriber,
          eventTypes: input.eventTypes,
          createdAt: now,
        })).map(subscriptionFromRow);
      },
    ),
    unregisterSubscription: Effect.fn("EventBusAdministration.unregisterSubscription")(
      function* (input) {
        if (!(yield* database.unregisterSubscription(input.subscriptionId))) {
          return yield* eventBusError("unregisterSubscription", "subscription_not_found");
        }
      },
    ),
    reset: Effect.fn("EventBusAdministration.reset")(function* () {
      yield* database.reset();
      yield* alarm.clear();
    }),
  };

  return {
    publisher: EventPublisher.of(publisher),
    administration: EventBusAdministration.of(administration),
    processor: EventBusProcessor.of({ processDue, rebuildAlarm }),
  };
});

/** Event Bus services acquired once with SQL, consumer, and alarm requirements visible. */
export const eventBusLayerWithoutDependencies = Layer.effectContext(
  Effect.gen(function* () {
    const services = yield* makeEventBus;
    return Context.make(EventPublisher, services.publisher).pipe(
      Context.add(EventBusAdministration, services.administration),
      Context.add(EventBusProcessor, services.processor),
    );
  }),
);
