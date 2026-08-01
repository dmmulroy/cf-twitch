import { Result } from "better-result";

import { DomainEventHandleError } from "../../capabilities/domain-event-handler";
import { HandleAchievementEventResultCodec } from "../../lib/achievement-rpc-result-codecs";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type { DomainEventHandler } from "../../capabilities/domain-event-handler";
import type { Tracer } from "../../capabilities/tracer";
import type { Event } from "../../domain/domain-event";
import type { Result as ResultType } from "better-result";

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
				const parsed = await HandleAchievementEventResultCodec.deserializeUnsafe(rawResult);
				if (parsed.status === "ok") return Result.ok(undefined);
				return Result.err(
					new DomainEventHandleError({
						eventId: event.id,
						failure: "remote",
						remoteErrorTag: parsed.error._tag,
					}),
				);
			},
		);
	}
}
