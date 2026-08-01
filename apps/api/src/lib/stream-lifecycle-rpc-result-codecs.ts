import { Result } from "better-result";
import { z } from "zod";

import { StreamLifecycleStateSchema } from "../domain/stream-lifecycle";
import { InvalidIsoTimestampError } from "./clock";
import { DurableObjectError, StreamLifecycleEffectsPendingError } from "./errors";

const StreamTransitionWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({ _tag: z.literal("InvalidIsoTimestampError"), input: z.string(), message: z.string() }),
	z.object({
		_tag: z.literal("StreamLifecycleEffectsPendingError"),
		transition: z.enum(["stream.online", "stream.offline"]),
		message: z.string(),
	}),
]);
type StreamTransitionError = InvalidIsoTimestampError | StreamLifecycleEffectsPendingError;
type StreamTransitionWireError = z.infer<typeof StreamTransitionWireErrorSchema>;
const StreamTransitionErrorToWireSchema = z
	.custom<StreamTransitionError>(
		(value) => InvalidIsoTimestampError.is(value) || StreamLifecycleEffectsPendingError.is(value),
	)
	.transform((error): StreamTransitionWireError => ({ ...error, message: error.message }))
	.pipe(StreamTransitionWireErrorSchema);
const StreamTransitionErrorFromWireSchema = StreamTransitionWireErrorSchema.transform(
	(error): StreamTransitionError =>
		error._tag === "InvalidIsoTimestampError"
			? new InvalidIsoTimestampError(error.input)
			: new StreamLifecycleEffectsPendingError(error.transition),
);

const DurableObjectWireErrorSchema = z.object({
	_tag: z.literal("DurableObjectError"),
	method: z.string(),
	message: z.string(),
	cause: z.unknown().optional(),
});
const DurableObjectErrorToWireSchema = z
	.custom<DurableObjectError>((value) => DurableObjectError.is(value))
	.transform(
		(error): z.infer<typeof DurableObjectWireErrorSchema> => ({
			_tag: error._tag,
			method: error.method,
			message: error.message,
			cause: error.cause,
		}),
	)
	.pipe(DurableObjectWireErrorSchema);
const DurableObjectErrorFromWireSchema = DurableObjectWireErrorSchema.transform(
	(error) =>
		new DurableObjectError({ method: error.method, message: error.message, cause: error.cause }),
);

/** RPC codec for accepting an online Stream Lifecycle transition. */
export const StreamOnlineResultCodec = Result.codec({
	serialize: { ok: z.undefined(), err: StreamTransitionErrorToWireSchema },
	deserialize: { ok: z.undefined(), err: StreamTransitionErrorFromWireSchema },
});
/** RPC codec for accepting an offline Stream Lifecycle transition. */
export const StreamOfflineResultCodec = Result.codec({
	serialize: { ok: z.undefined(), err: StreamTransitionErrorToWireSchema },
	deserialize: { ok: z.undefined(), err: StreamTransitionErrorFromWireSchema },
});
/** RPC codec for reading the current Stream Lifecycle state. */
export const GetStreamLifecycleStateResultCodec = Result.codec({
	serialize: { ok: StreamLifecycleStateSchema, err: DurableObjectErrorToWireSchema },
	deserialize: { ok: StreamLifecycleStateSchema, err: DurableObjectErrorFromWireSchema },
});
