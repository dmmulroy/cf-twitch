import { Result } from "better-result";

import { DomainEventPublishError } from "../../capabilities/domain-event-publisher";
import { PublishDomainEventResultCodec } from "../../lib/event-bus-rpc-result-codecs";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type { DomainEventPublisher } from "../../capabilities/domain-event-publisher";
import type { Tracer } from "../../capabilities/tracer";
import type { Event } from "../../domain/domain-event";
import type { Result as ResultType } from "better-result";

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
				const parsed = await PublishDomainEventResultCodec.deserializeUnsafe(rawResult);
				if (parsed.status === "ok") return Result.ok(undefined);
				return Result.err(
					new DomainEventPublishError({
						eventId: event.id,
						eventType: event.type,
						failure: "remote",
						remoteErrorTag: parsed.error._tag,
					}),
				);
			},
		);
	}
}
