import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { EventSubHttpApi } from "./eventsub-http-api.ts";
import { EventSubInbox } from "./eventsub-inbox.ts";

/** Layer that serves the EventSub receipt HTTP contract from the same inbox authority as recovery alarms. */
export const eventSubHttpHandlersLayer = HttpApiBuilder.group(
  EventSubHttpApi,
  "receipts",
  (handlers) =>
    Effect.gen(function* () {
      const inbox = yield* EventSubInbox;

      return handlers
        .handle("accept", ({ payload }) => inbox.accept(payload))
        .handle("getReceiptStatus", () => inbox.getReceiptStatus());
    }),
);
