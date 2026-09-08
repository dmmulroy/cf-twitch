import { Effect, Layer } from "effect";
import type { AchievementError } from "@cf-twitch/contracts/achievement";
import { Achievements } from "../achievements/achievements-service.ts";
import { EventHandler, EventHandlerError } from "./event-bus-service.ts";

const eventHandlerReason = (reason: AchievementError["reason"]): EventHandlerError["reason"] => {
  switch (reason) {
    case "persistence_unavailable":
    case "transport_unavailable":
      return "consumer_unavailable";
    case "invalid_input":
    case "invalid_stored_data":
    case "invalid_response":
      return "consumer_rejected";
    default:
      return reason;
  }
};

/** Routes subscribed Event Bus deliveries into the idempotent Achievement inbox. */
export const achievementEventHandlerLayer = Layer.effect(
  EventHandler,
  Effect.gen(function* () {
    const achievements = yield* Achievements;
    return EventHandler.of({
      handleDomainEvent: Effect.fn("AchievementEventHandler.handleDomainEvent")(function* (event) {
        yield* achievements
          .handleEvent(event)
          .pipe(
            Effect.catchTag("AchievementError", (error) =>
              Effect.fail(new EventHandlerError({ reason: eventHandlerReason(error.reason) })),
            ),
          );
      }),
    });
  }),
);
