import { Context, Effect, Option } from "effect";
import type {
  AcceptedEventSubReceipt,
  EventSubReceiptConflict,
  EventSubReceiptError,
  EventSubReceiptStatus,
} from "@cf-twitch/contracts/eventsub";
import type { EventSubMessageId } from "@cf-twitch/contracts/identity";

/** Durable inbox acceptance acknowledges persisted work, not downstream completion. */
export interface IEventSubReceipts {
  readonly accept: (
    input: AcceptedEventSubReceipt,
  ) => Effect.Effect<void, EventSubReceiptConflict | EventSubReceiptError>;
  readonly getReceiptStatus: (
    messageId: EventSubMessageId,
  ) => Effect.Effect<Option.Option<EventSubReceiptStatus>, EventSubReceiptError>;
}
/** EventSub receipt clients route every operation by the authenticated message ID. */
export class EventSubReceipts extends Context.Service<EventSubReceipts, IEventSubReceipts>()(
  "@cf-twitch/EventSubReceipts",
) {}
