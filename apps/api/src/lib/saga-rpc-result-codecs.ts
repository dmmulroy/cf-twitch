import { Result } from "better-result";
import { z } from "zod";

/** Stable wire projection for expected Saga host failures handled by RPC callers. */
export const SagaHostWireErrorSchema = z
	.object({
		_tag: z.enum([
			"SagaAlreadyExistsError",
			"SagaInputParseError",
			"SagaNotFoundError",
			"SagaPersistedDataError",
			"SagaRunnerDbError",
			"SagaScheduleError",
			"SagaStepError",
			"SagaStepRetrying",
			"SagaEffectOutcomeUnknown",
		]),
		message: z.string(),
	})
	.passthrough();
export type SagaHostWireError = z.infer<typeof SagaHostWireErrorSchema>;
const SagaHostErrorToWireSchema = z
	.custom<SagaHostWireError>((value) => SagaHostWireErrorSchema.safeParse(value).success)
	.transform((error): SagaHostWireError => ({ ...error, message: error.message }))
	.pipe(SagaHostWireErrorSchema);
const SagaStatusSchema = z.enum([
	"RUNNING",
	"COMPLETED",
	"FAILED",
	"COMPENSATING",
	"COMPENSATION_FAILED",
	"OUTCOME_UNKNOWN",
	"POST_COMMIT_FAILED",
]);
const SagaHostStatusSchema = z.object({
	sagaId: z.string(),
	status: SagaStatusSchema,
	fulfilledAt: z.string().nullable(),
	error: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

/** RPC codec for starting or resuming one durable Saga. */
export const StartSagaResultCodec = Result.codec({
	serialize: { ok: z.undefined(), err: SagaHostErrorToWireSchema },
	deserialize: { ok: z.undefined(), err: SagaHostWireErrorSchema },
});
/** RPC codec for reading one durable Saga status projection. */
export const GetSagaStatusResultCodec = Result.codec({
	serialize: { ok: SagaHostStatusSchema.nullable(), err: SagaHostErrorToWireSchema },
	deserialize: { ok: SagaHostStatusSchema.nullable(), err: SagaHostWireErrorSchema },
});
