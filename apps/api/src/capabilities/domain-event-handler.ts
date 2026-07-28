import { TaggedError } from "better-result";

import type { Event } from "../domain/domain-event";
import type { Result } from "better-result";

/** Expected failure when Achievement rules cannot handle one domain event. */
export class DomainEventHandleError extends TaggedError("DomainEventHandleError")<{
	readonly eventId: string;
	readonly failure: "transport" | "protocol" | "remote";
	readonly remoteErrorTag?: string;
	readonly message: string;
	readonly cause?: unknown;
}>() {
	constructor(args: {
		eventId: string;
		failure: "transport" | "protocol" | "remote";
		remoteErrorTag?: string;
		cause?: unknown;
	}) {
		super({ ...args, message: `Domain event handling failed (${args.failure})` });
	}
}

/** Handles domain evidence by evaluating and persisting Achievement rules. */
export interface DomainEventHandler {
	/** Handles one idempotent domain event. */
	handleEvent(event: Event): Promise<Result<void, DomainEventHandleError>>;
}
