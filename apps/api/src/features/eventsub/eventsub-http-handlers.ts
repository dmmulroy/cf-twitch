import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { EventSubHttpApi } from "./eventsub-http-api.ts";
import { EventSubInbox } from "./eventsub-inbox.ts";
/** Receipt handlers use the same inbox authority as recovery alarms. */
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
