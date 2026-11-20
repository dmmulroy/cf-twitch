import { describe, expect, it } from "vite-plus/test";
import { Option, Schema } from "effect";
import { EventBusError, EventBusSubscriptionId, PendingEventItem } from "./event-bus.ts";
import { EventId } from "./identity.ts";

const eventId = EventId.make("550e8400-e29b-41d4-a716-446655440000");

describe("Event Bus contracts", () => {
  it("names the operation, reason, and event, and gives one way forward", () => {
    const error = new EventBusError({
      operation: "publish",
      reason: "persistence_unavailable",
      eventId: Option.some(eventId),
    });

    expect(error.message).toBe(
      `Event Bus storage is unavailable during event publication for event ${eventId}. Retry the same operation; Event Bus deduplicates deliveries by event ID.`,
    );
  });

  it("acknowledges an unknown outcome when the Event Bus cannot be reached", () => {
    const error = new EventBusError({
      operation: "retryPending",
      reason: "transport_unavailable",
      eventId: Option.none(),
    });

    expect(error.message).toBe(
      "Event Bus could not be reached during pending event retry, so the outcome is unknown. Retry the same operation; Event Bus deduplicates deliveries by event ID.",
    );
  });

  it("defaults the subscription identifier and names it when known", () => {
    expect(
      new EventBusError({
        operation: "unregisterSubscription",
        reason: "subscription_not_found",
        eventId: Option.none(),
      }).subscriptionId,
    ).toEqual(Option.none());

    expect(
      new EventBusError({
        operation: "unregisterSubscription",
        reason: "subscription_not_found",
        eventId: Option.none(),
        subscriptionId: Option.some(EventBusSubscriptionId.make("achievements:raffle_roll")),
      }).message,
    ).toBe(
      "Event Bus subscription not found during subscription removal for subscription achievements:raffle_roll. List the subscriptions to find the current ID and try again.",
    );
  });

  it("represents an unreadable persisted event explicitly", () => {
    const item = Schema.decodeUnknownSync(PendingEventItem)({
      id: eventId,
      event: null,
      attempts: 0,
      nextRetryAt: "2026-01-30T12:00:01.000Z",
      createdAt: "2026-01-30T12:00:00.000Z",
    });

    expect(Option.isNone(item.event)).toBe(true);
  });
});
