import { Result } from "better-result";
import { z } from "zod";

import { DomainEventHandleError } from "../../capabilities/domain-event-handler";
import { DurableObjectError } from "../../lib/errors";
import { fromRpcResult, type RpcPayloadParser } from "../../lib/rpc-result";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type { DomainEventHandler } from "../../capabilities/domain-event-handler";
import type { Tracer } from "../../capabilities/tracer";
import type { Event } from "../../domain/domain-event";
import type { Result as ResultType } from "better-result";

const AchievementEventWireErrorSchema = z
	.object({
		_tag: z.enum([
			"AchievementDbError",
			"AchievementNotFoundError",
			"AchievementEventValidationError",
			"AchievementQueryValidationError",
			"InvalidAchievementRecordError",
		]),
		message: z.string(),
	})
	.passthrough();

type AchievementEventWireError = z.infer<typeof AchievementEventWireErrorSchema>;

const parseVoidPayload: RpcPayloadParser<void> = (input) =>
	input === undefined ? Result.ok(undefined) : Result.err("Expected an undefined success value");
const parseAchievementEventWireError: RpcPayloadParser<AchievementEventWireError> = (input) => {
	const parsed = AchievementEventWireErrorSchema.safeParse(input);
	return parsed.success ? Result.ok(parsed.data) : Result.err(parsed.error.message);
};

/** Durable Object adapter that applies domain events to Achievement rules and state. */
export class DurableObjectAchievementEventHandler implements DomainEventHandler {
	constructor(
		private readonly namespace: Cloudflare.Env["ACHIEVEMENTS_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Handles one event through the runtime-validated Achievements RPC contract. */
	handleEvent(event: Event): Promise<ResultType<void, DomainEventHandleError>> {
		return this.tracer.span(
			"durable_object.achievements.handle_event",
			{ event_id: event.id, event_type: event.type },
			async () => {
				let rawResult: unknown;
				try {
					const stub = await initializeDurableObjectAgentStub(
						this.namespace.getByName("achievements"),
						"achievements",
					);
					rawResult = await stub.handleEvent(event);
				} catch (cause) {
					return Result.err(
						new DomainEventHandleError({ eventId: event.id, failure: "transport", cause }),
					);
				}
				const parsed = fromRpcResult(rawResult, "AchievementsDO.handleEvent", {
					success: parseVoidPayload,
					error: parseAchievementEventWireError,
				});
				if (parsed.status === "ok") return Result.ok(undefined);
				return Result.err(
					new DomainEventHandleError({
						eventId: event.id,
						failure: DurableObjectError.is(parsed.error) ? "protocol" : "remote",
						...(DurableObjectError.is(parsed.error)
							? { cause: parsed.error }
							: { remoteErrorTag: parsed.error._tag }),
					}),
				);
			},
		);
	}
}
