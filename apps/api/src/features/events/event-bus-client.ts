import { Effect, Option, type Schema } from "effect";
import type { HttpClientError } from "effect/http";
import {
  EventBusError,
  type EventBusOperation,
  type EventBusSubscriptionId,
} from "@cf-twitch/contracts/event-bus";
import type { EventId } from "@cf-twitch/contracts/identity";

/** Safe identifiers an Event Bus client call already knows, attached to transport failures. */
export interface EventBusClientFailureContext {
  /** Event the call concerns, or `Option.none()` for list, stats, and reset calls. */
  readonly eventId: Option.Option<EventId>;
  /** Subscription the call concerns, or `Option.none()` when it targets no subscription. */
  readonly subscriptionId: Option.Option<EventBusSubscriptionId>;
}

const noFailureContext: EventBusClientFailureContext = {
  eventId: Option.none(),
  subscriptionId: Option.none(),
};

/**
 * Returns a combinator that classifies Event Bus client failures for one operation.
 *
 * **Details**
 *
 * `EventBusError` values decoded from the Durable Object pass through unchanged. Transport failures
 * become `transport_unavailable`, because the request may have reached the Event Bus, and
 * responses outside the contract become `invalid_response`.
 *
 * @returns A combinator whose result fails only with `EventBusError`.
 */
export const translateEventBusClientErrors =
  (operation: EventBusOperation, context: EventBusClientFailureContext = noFailureContext) =>
  <A, R>(
    request: Effect.Effect<
      A,
      EventBusError | HttpClientError.HttpClientError | Schema.SchemaError,
      R
    >,
  ): Effect.Effect<A, EventBusError, R> =>
    request.pipe(
      Effect.catchTags({
        EventBusError: (error) => Effect.fail(error),
        HttpClientError: () =>
          Effect.fail(
            new EventBusError({ operation, reason: "transport_unavailable", ...context }),
          ),
        SchemaError: () =>
          Effect.fail(new EventBusError({ operation, reason: "invalid_response", ...context })),
      }),
    );
