import { Schema } from "effect";
import { DomainEvent } from "@cf-twitch/contracts/domain-event";
import {
  DeadLetterEventList,
  DeadLetterReplayResult,
  EventBusError,
  EventBusPageInput,
  EventBusStats,
  EventBusStatus,
  EventBusSubscription,
  EventBusSubscriptionId,
  PendingEventList,
  RegisterEventBusSubscriptionInput,
} from "@cf-twitch/contracts/event-bus";
import { EventId, NonNegativeInt } from "@cf-twitch/contracts/identity";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

const EventIdInput = Schema.Struct({ eventId: EventId });

const SubscriptionIdInput = Schema.Struct({ subscriptionId: EventBusSubscriptionId });

const UnitSuccess = Schema.Struct({ success: Schema.Literal(true) });

/** Versioned Event Bus endpoints shared by the singleton server and invocation-scoped client. */
export class EventBusHttpApiGroup extends HttpApiGroup.make("eventBus")
  .add(
    HttpApiEndpoint.post("publish", "/events", {
      payload: DomainEvent,
      success: UnitSuccess,
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.post("processDue", "/events/process-due", {
      success: UnitSuccess,
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getStats", "/events/stats", {
      success: EventBusStats,
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getStatus", "/events/status", {
      success: EventBusStatus,
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.post("listPending", "/events/pending/list", {
      payload: EventBusPageInput,
      success: PendingEventList,
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.post("listDeadLetters", "/events/dead-letters/list", {
      payload: EventBusPageInput,
      success: DeadLetterEventList,
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.post("replayDeadLetter", "/events/dead-letters/replay", {
      payload: EventIdInput,
      success: DeadLetterReplayResult,
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.post("retryPending", "/events/pending/retry", {
      payload: EventIdInput,
      success: UnitSuccess,
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint["delete"]("deleteDeadLetter", "/events/dead-letters", {
      payload: EventIdInput,
      success: UnitSuccess,
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.post("purgeExpiredDeadLetters", "/events/dead-letters/purge", {
      success: Schema.Struct({ deletedCount: NonNegativeInt }),
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.get("listSubscriptions", "/events/subscriptions", {
      success: Schema.Array(EventBusSubscription),
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.post("registerSubscription", "/events/subscriptions", {
      payload: RegisterEventBusSubscriptionInput,
      success: Schema.Array(EventBusSubscription),
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint["delete"]("unregisterSubscription", "/events/subscriptions", {
      payload: SubscriptionIdInput,
      success: UnitSuccess,
      error: EventBusError,
    }),
  )
  .add(
    HttpApiEndpoint.post("reset", "/events/reset", {
      success: UnitSuccess,
      error: EventBusError,
    }),
  ) {}

/** Internal HTTP API hosted by the physical EventBusDO class. */
export class EventBusHttpApi extends HttpApi.make("EventBusHttpApi")
  .add(EventBusHttpApiGroup)
  .prefix("/v1") {}
