import { Result } from "better-result";
import { z } from "zod";

import { DomainEventPublishError } from "../../capabilities/domain-event-publisher";
import { DurableObjectError } from "../../lib/errors";
import { fromRpcResult, type RpcPayloadParser } from "../../lib/rpc-result";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type { DomainEventPublisher } from "../../capabilities/domain-event-publisher";
import type { Tracer } from "../../capabilities/tracer";
import type { Event } from "../../domain/domain-event";
import type { Result as ResultType } from "better-result";

const DomainEventPublishWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({ _tag: z.literal("EventBusDbError"), message: z.string() }).passthrough(),
	z.object({ _tag: z.literal("EventBusHandlerError"), message: z.string() }).passthrough(),
	z.object({ _tag: z.literal("EventBusRoutingError"), message: z.string() }).passthrough(),
	z.object({ _tag: z.literal("EventBusValidationError"), message: z.string() }).passthrough(),
]);

type DomainEventPublishWireError = z.infer<typeof DomainEventPublishWireErrorSchema>;

const parseVoidPayload: RpcPayloadParser<void> = (input) =>
	input === undefined ? Result.ok(undefined) : Result.err("Expected an undefined success value");
const parsePublishWireError: RpcPayloadParser<DomainEventPublishWireError> = (input) => {
	const parsed = DomainEventPublishWireErrorSchema.safeParse(input);
	return parsed.success ? Result.ok(parsed.data) : Result.err(parsed.error.message);
};

/** Durable Object adapter for runtime-validated domain event publication. */
export class DurableObjectDomainEventPublisher implements DomainEventPublisher {
	constructor(
		private readonly namespace: Cloudflare.Env["EVENT_BUS_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Publishes one event through the singleton Event Bus RPC contract. */
	publish(event: Event): Promise<ResultType<void, DomainEventPublishError>> {
		return this.tracer.span(
			"durable_object.event_bus.publish",
			{ event_id: event.id, event_type: event.type },
			async () => {
				let rawResult: unknown;
				try {
					const stub = await initializeDurableObjectAgentStub(
						this.namespace.getByName("event-bus"),
						"event-bus",
					);
					rawResult = await stub.publish(event);
				} catch (cause) {
					return Result.err(
						new DomainEventPublishError({
							eventId: event.id,
							eventType: event.type,
							failure: "transport",
							cause,
						}),
					);
				}
				const parsed = fromRpcResult(rawResult, "EventBusDO.publish", {
					success: parseVoidPayload,
					error: parsePublishWireError,
				});
				if (parsed.status === "ok") return Result.ok(undefined);
				return Result.err(
					new DomainEventPublishError({
						eventId: event.id,
						eventType: event.type,
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
