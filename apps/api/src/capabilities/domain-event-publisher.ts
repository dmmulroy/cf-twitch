import { TaggedError } from "better-result";

import type { Event } from "../domain/domain-event";
import type { Result } from "better-result";

/** Expected failure when a domain event cannot be accepted by the Event Bus. */
export class DomainEventPublishError extends TaggedError("DomainEventPublishError")<{
	readonly eventId: string;
	readonly eventType: Event["type"];
	readonly failure: "transport" | "protocol" | "remote";
	readonly remoteErrorTag?: string;
	readonly message: string;
	readonly cause?: unknown;
}>() {
	constructor(args: {
		eventId: string;
		eventType: Event["type"];
		failure: "transport" | "protocol" | "remote";
		remoteErrorTag?: string;
		cause?: unknown;
	}) {
		super({ ...args, message: `Domain event publish failed (${args.failure})` });
	}
}

/** Publishes domain events with Event Bus idempotency and durable retry policy. */
export interface DomainEventPublisher {
	/** Accepts one parsed event for idempotent delivery to its registered handler. */
	publish(event: Event): Promise<Result<void, DomainEventPublishError>>;
}
