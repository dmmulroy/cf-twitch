import { Result } from "better-result";
import { z } from "zod";

import {
	EventSubReceiptConflictError,
	EventSubReceiptCorruptError,
	type EventSubAcceptanceError,
} from "./errors";

const EventSubReceiptWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({
		_tag: z.literal("EventSubReceiptConflictError"),
		messageId: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("EventSubReceiptCorruptError"),
		parseError: z.string(),
		message: z.string(),
	}),
]);
type EventSubReceiptWireError = z.infer<typeof EventSubReceiptWireErrorSchema>;
const EventSubReceiptErrorToWireSchema = z
	.custom<EventSubAcceptanceError>(
		(value) => EventSubReceiptConflictError.is(value) || EventSubReceiptCorruptError.is(value),
	)
	.transform((error): EventSubReceiptWireError => ({ ...error, message: error.message }))
	.pipe(EventSubReceiptWireErrorSchema);
const EventSubReceiptErrorFromWireSchema = EventSubReceiptWireErrorSchema.transform(
	(error): EventSubAcceptanceError =>
		error._tag === "EventSubReceiptConflictError"
			? new EventSubReceiptConflictError(error.messageId)
			: new EventSubReceiptCorruptError(error.parseError),
);
const EventSubReceiptStatusSchema = z.object({
	status: z.enum(["pending", "completed", "dead_letter"]),
	attempts: z.number().int().nonnegative(),
	lastError: z.string().nullable(),
	chatCommandDelivery: z.enum(["sending", "sent", "uncertain"]).optional(),
});

/** RPC codec for accepting one durable EventSub receipt. */
export const AcceptEventSubReceiptResultCodec = Result.codec({
	serialize: { ok: z.undefined(), err: EventSubReceiptErrorToWireSchema },
	deserialize: { ok: z.undefined(), err: EventSubReceiptErrorFromWireSchema },
});
/** RPC codec for reading durable EventSub receipt progress. */
export const GetEventSubReceiptStatusResultCodec = Result.codec({
	serialize: { ok: EventSubReceiptStatusSchema.nullable(), err: EventSubReceiptErrorToWireSchema },
	deserialize: {
		ok: EventSubReceiptStatusSchema.nullable(),
		err: EventSubReceiptErrorFromWireSchema,
	},
});
