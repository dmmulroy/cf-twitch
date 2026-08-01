import { Result } from "better-result";

import {
	DLQItemNotFoundError,
	EventBusDbError,
	EventBusValidationError,
	type EventBusError,
} from "../../lib/errors";
import {
	DeleteDeadLetterEventResultCodec,
	GetDeadLetterEventsResultCodec,
	GetPendingEventsResultCodec,
	ReplayDeadLetterEventResultCodec,
} from "../../lib/event-bus-rpc-result-codecs";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type {
	DeadLetterList,
	DeadLetterReplayResult,
	EventBusAdministration,
	EventBusAdministrationError,
	PendingEventList,
} from "../../capabilities/event-bus-administration";
import type { Tracer } from "../../capabilities/tracer";
import type { Result as ResultType } from "better-result";

type EventBusAdministrationOperation = "getPending" | "getDLQ" | "replayDLQ" | "deleteDLQ";

/** Durable Object adapter for validated Event Bus administration RPC. */
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
			(value) => GetPendingEventsResultCodec.deserializeUnsafe(value),
		);
	}

	getDeadLetters(options: {
		readonly limit: number;
		readonly offset: number;
	}): Promise<ResultType<DeadLetterList, EventBusAdministrationError>> {
		return this.call(
			"getDLQ",
			(stub) => stub.getDLQ(options),
			(value) => GetDeadLetterEventsResultCodec.deserializeUnsafe(value),
		);
	}

	replayDeadLetter(
		id: string,
	): Promise<ResultType<DeadLetterReplayResult, EventBusAdministrationError>> {
		return this.call(
			"replayDLQ",
			(stub) => stub.replayDLQ(id),
			(value) => ReplayDeadLetterEventResultCodec.deserializeUnsafe(value),
		);
	}

	deleteDeadLetter(id: string): Promise<ResultType<void, EventBusAdministrationError>> {
		return this.call(
			"deleteDLQ",
			(stub) => stub.deleteDLQ(id),
			(value) => DeleteDeadLetterEventResultCodec.deserializeUnsafe(value),
		);
	}

	private call<T>(
		operation: EventBusAdministrationOperation,
		invoke: (
			stub: Awaited<ReturnType<DurableObjectEventBusAdministration["acquireStub"]>>,
		) => Promise<unknown>,
		deserializeUnsafe: (
			value: unknown,
		) => ResultType<T, EventBusError> | Promise<ResultType<T, EventBusError>>,
	): Promise<ResultType<T, EventBusAdministrationError>> {
		return this.tracer.span(`durable_object.event_bus.${operation}`, { operation }, async () => {
			let rawResult: unknown;
			try {
				rawResult = await invoke(await this.acquireStub());
			} catch (cause) {
				return Result.err(new EventBusDbError({ operation, cause }));
			}
			const result = await deserializeUnsafe(rawResult);
			if (result.status === "ok") return Result.ok(result.value);
			if (
				EventBusDbError.is(result.error) ||
				EventBusValidationError.is(result.error) ||
				DLQItemNotFoundError.is(result.error)
			) {
				return Result.err(result.error);
			}
			return Result.err(new EventBusDbError({ operation, cause: result.error }));
		});
	}

	private acquireStub() {
		return initializeDurableObjectAgentStub(this.namespace.getByName("event-bus"), "event-bus");
	}
}
