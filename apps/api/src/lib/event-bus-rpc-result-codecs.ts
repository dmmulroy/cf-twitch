import { Result } from "better-result";
import { z } from "zod";

import {
	DeadLetterListSchema,
	DeadLetterReplayResultSchema,
	PendingEventListSchema,
} from "../capabilities/event-bus-administration";
import {
	DLQItemNotFoundError,
	EventBusDbError,
	EventBusHandlerError,
	EventBusRoutingError,
	EventBusValidationError,
	type EventBusError,
} from "./errors";

const EventBusWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({ _tag: z.literal("EventBusRoutingError"), eventType: z.string(), message: z.string() }),
	z.object({
		_tag: z.literal("EventBusHandlerError"),
		eventType: z.string(),
		handlerName: z.string(),
		cause: z.unknown(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("EventBusValidationError"),
		parseError: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("EventBusDbError"),
		operation: z.string(),
		cause: z.unknown().optional(),
		message: z.string(),
	}),
	z.object({ _tag: z.literal("DLQItemNotFoundError"), eventId: z.string(), message: z.string() }),
]);
type EventBusWireError = z.infer<typeof EventBusWireErrorSchema>;
const EventBusErrorToWireSchema = z
	.custom<EventBusError>((value) => typeof value === "object" && value !== null && "_tag" in value)
	.transform((error): EventBusWireError => ({ ...error, message: error.message }))
	.pipe(EventBusWireErrorSchema);
const EventBusErrorFromWireSchema = EventBusWireErrorSchema.transform((error): EventBusError => {
	switch (error._tag) {
		case "EventBusRoutingError":
			return new EventBusRoutingError({ eventType: error.eventType });
		case "EventBusHandlerError":
			return new EventBusHandlerError({
				eventType: error.eventType,
				handlerName: error.handlerName,
				cause: error.cause,
			});
		case "EventBusValidationError":
			return new EventBusValidationError({ parseError: error.parseError });
		case "EventBusDbError":
			return new EventBusDbError({ operation: error.operation, cause: error.cause });
		case "DLQItemNotFoundError":
			return new DLQItemNotFoundError({ eventId: error.eventId });
	}
});
function createEventBusResultCodec<T>(okSchema: z.ZodType<T>) {
	return Result.codec({
		serialize: { ok: okSchema, err: EventBusErrorToWireSchema },
		deserialize: { ok: okSchema, err: EventBusErrorFromWireSchema },
	});
}

/** RPC codec for publishing one Domain Event. */
export const PublishDomainEventResultCodec = createEventBusResultCodec(z.undefined());
/** RPC codec for counting pending Domain Events. */
export const GetPendingEventCountResultCodec = createEventBusResultCodec(
	z.number().int().nonnegative(),
);
/** RPC codec for reading pending Domain Events. */
export const GetPendingEventsResultCodec = createEventBusResultCodec(PendingEventListSchema);
/** RPC codec for reading dead-letter Domain Events. */
export const GetDeadLetterEventsResultCodec = createEventBusResultCodec(DeadLetterListSchema);
/** RPC codec for replaying one dead-letter Domain Event. */
export const ReplayDeadLetterEventResultCodec = createEventBusResultCodec(
	DeadLetterReplayResultSchema,
);
/** RPC codec for deleting one dead-letter Domain Event. */
export const DeleteDeadLetterEventResultCodec = createEventBusResultCodec(z.undefined());
