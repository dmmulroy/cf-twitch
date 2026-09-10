import { describe, expect, it } from "vite-plus/test";
import { Option, Schema } from "effect";
import { EventBusError, PendingEventItem } from "./event-bus.ts";

describe("Event Bus contracts", () => {
  it("owns a stable searchable error message", () => {
    const error = new EventBusError({
      operation: "publish",
      reason: "persistence_unavailable",
      eventId: Option.none(),
    });

    expect(error.message).toBe("Event Bus publish failed (persistence_unavailable)");
  });

  it("represents an unreadable persisted event explicitly", () => {
    const item = Schema.decodeUnknownSync(PendingEventItem)({
      id: "550e8400-e29b-41d4-a716-446655440000",
      event: null,
      attempts: 0,
      nextRetryAt: "2026-01-30T12:00:01.000Z",
      createdAt: "2026-01-30T12:00:00.000Z",
    });

    expect(Option.isNone(item.event)).toBe(true);
  });
});
