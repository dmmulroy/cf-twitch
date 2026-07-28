import { Result } from "better-result";
import { z } from "zod";

import {
	DeadLetterListSchema,
	DeadLetterReplayResultSchema,
	PendingEventListSchema,
	type DeadLetterList,
	type DeadLetterReplayResult,
	type EventBusAdministration,
	type EventBusAdministrationError,
	type PendingEventList,
} from "../../capabilities/event-bus-administration";
import {
	DLQItemNotFoundError,
	DurableObjectError,
	EventBusDbError,
	EventBusValidationError,
} from "../../lib/errors";
import { fromRpcResult, type RpcPayloadParser } from "../../lib/rpc-result";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type { Tracer } from "../../capabilities/tracer";
import type { Result as ResultType } from "better-result";

const EventBusAdministrationWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({ _tag: z.literal("EventBusDbError"), operation: z.string(), message: z.string() }),
	z.object({
		_tag: z.literal("EventBusValidationError"),
		parseError: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("DLQItemNotFoundError"),
		eventId: z.string(),
		message: z.string(),
	}),
]);
type EventBusAdministrationWireError = z.infer<typeof EventBusAdministrationWireErrorSchema>;
type EventBusAdministrationOperation = "getPending" | "getDLQ" | "replayDLQ" | "deleteDLQ";

function parseSchema<T>(schema: z.ZodType<T>): RpcPayloadParser<T> {
	return (input) => {
		const parsed = schema.safeParse(input);
		return parsed.success ? Result.ok(parsed.data) : Result.err(parsed.error.message);
	};
}

const parseWireError = parseSchema(EventBusAdministrationWireErrorSchema);
const parseVoid: RpcPayloadParser<void> = (input) =>
	input === undefined ? Result.ok(undefined) : Result.err("Expected an undefined success value");

function translateWireError(error: EventBusAdministrationWireError): EventBusAdministrationError {
	switch (error._tag) {
		case "EventBusDbError":
			return new EventBusDbError({ operation: error.operation });
		case "EventBusValidationError":
			return new EventBusValidationError({ parseError: error.parseError });
		case "DLQItemNotFoundError":
			return new DLQItemNotFoundError({ eventId: error.eventId });
	}
}

/** Parsed Durable Object adapter for Event Bus pending and dead-letter administration. */
export class DurableObjectEventBusAdministration implements EventBusAdministration {
	constructor(
		private readonly namespace: Cloudflare.Env["EVENT_BUS_DO"],
		private readonly tracer: Tracer,
	) {}

	getPending(options: {
		readonly limit: number;
		readonly offset: number;
	}): Promise<ResultType<PendingEventList, EventBusAdministrationError>> {
		return this.call(
			"getPending",
			(stub) => stub.getPending(options),
			parseSchema(PendingEventListSchema),
		);
	}

	getDeadLetters(options: {
		readonly limit: number;
		readonly offset: number;
	}): Promise<ResultType<DeadLetterList, EventBusAdministrationError>> {
		return this.call("getDLQ", (stub) => stub.getDLQ(options), parseSchema(DeadLetterListSchema));
	}

	replayDeadLetter(
		id: string,
	): Promise<ResultType<DeadLetterReplayResult, EventBusAdministrationError>> {
		return this.call(
			"replayDLQ",
			(stub) => stub.replayDLQ(id),
			parseSchema(DeadLetterReplayResultSchema),
		);
	}

	deleteDeadLetter(id: string): Promise<ResultType<void, EventBusAdministrationError>> {
		return this.call("deleteDLQ", (stub) => stub.deleteDLQ(id), parseVoid);
	}

	private call<T>(
		operation: EventBusAdministrationOperation,
		invoke: (
			stub: Awaited<ReturnType<DurableObjectEventBusAdministration["acquireStub"]>>,
		) => Promise<unknown>,
		success: RpcPayloadParser<T>,
	): Promise<ResultType<T, EventBusAdministrationError>> {
		return this.tracer.span(`durable_object.event_bus.${operation}`, { operation }, async () => {
			let rawResult: unknown;
			try {
				rawResult = await invoke(await this.acquireStub());
			} catch (cause) {
				return Result.err(new EventBusDbError({ operation, cause }));
			}
			const parsed = fromRpcResult(rawResult, `EventBusDO.${operation}`, {
				success,
				error: parseWireError,
			});
			if (parsed.status === "ok") return Result.ok(parsed.value);
			return Result.err(
				DurableObjectError.is(parsed.error)
					? new EventBusDbError({ operation, cause: parsed.error })
					: translateWireError(parsed.error),
			);
		});
	}

	private acquireStub() {
		return initializeDurableObjectAgentStub(this.namespace.getByName("event-bus"), "event-bus");
	}
}
