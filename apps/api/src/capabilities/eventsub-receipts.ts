import { TaggedError } from "better-result";
import { z } from "zod";

import { EventSubHeadersSchema } from "../lib/eventsub-webhook-message";

import type { Result } from "better-result";

/** Runtime parser for correlation persisted across detached EventSub processing. */
export const EventSubReceiptCorrelationSchema = z.object({
	traceId: z.uuid().brand<"TraceId">(),
	requestId: z.uuid().brand<"RequestId">(),
});

/** Correlation metadata persisted when EventSub processing can detach from HTTP. */
export type EventSubReceiptCorrelation = z.infer<typeof EventSubReceiptCorrelationSchema>;

/** Runtime parser for a parsed EventSub receipt accepted by the durable inbox. */
export const AcceptedEventSubReceiptSchema = z.object({
	headers: EventSubHeadersSchema,
	body: z.json(),
	correlation: EventSubReceiptCorrelationSchema,
});

/** Parsed EventSub receipt accepted by the durable inbox. */
export type AcceptedEventSubReceipt = z.infer<typeof AcceptedEventSubReceiptSchema>;

/** Expected failure when an EventSub receipt cannot be durably accepted. */
export class EventSubReceiptAcceptanceError extends TaggedError("EventSubReceiptAcceptanceError")<{
	readonly messageId: string;
	readonly failure: "transport" | "protocol" | "conflict" | "corrupt";
	readonly message: string;
	readonly cause?: unknown;
}> {
	constructor(args: {
		messageId: string;
		failure: "transport" | "protocol" | "conflict" | "corrupt";
		cause?: unknown;
	}) {
		super({
			...args,
			message: `EventSub receipt acceptance failed (${args.failure})`,
		});
	}
}

/** Durably accepts parsed EventSub receipts by Twitch message ID. */
export interface EventSubReceiptAcceptor {
	/** Persists one receipt and schedules retryable processing before HTTP acknowledgement. */
	accept(
		messageId: string,
		receipt: AcceptedEventSubReceipt,
	): Promise<Result<void, EventSubReceiptAcceptanceError>>;
}
