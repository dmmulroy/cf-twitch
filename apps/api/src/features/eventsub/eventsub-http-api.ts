import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  AcceptedEventSubReceipt,
  EventSubReceiptConflict,
  EventSubReceiptError,
  EventSubReceiptStatus,
} from "@cf-twitch/contracts/eventsub";
/** EventSub receipt HTTP contract acknowledges durable acceptance independently of dispatch completion. */
export class EventSubHttpApi extends HttpApi.make("EventSubHttpApi")
  .add(
    HttpApiGroup.make("receipts").add(
      HttpApiEndpoint.post("accept", "/receipt", {
        payload: AcceptedEventSubReceipt,
        success: Schema.Void,
        error: [EventSubReceiptConflict, EventSubReceiptError],
      }),
      HttpApiEndpoint.get("getReceiptStatus", "/receipt", {
        success: Schema.OptionFromNullOr(EventSubReceiptStatus),
        error: EventSubReceiptError,
      }),
    ),
  )
  .prefix("/v1") {}
