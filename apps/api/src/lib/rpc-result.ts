import { Result, type SerializedResult } from "better-result";

import { DurableObjectError } from "./errors";

/** RPC-safe representation of a better-result value. */
export type RpcResult<T, E> = SerializedResult<T, E>;

/** Non-throwing parser used to validate one method-specific RPC payload variant. */
export type RpcPayloadParser<T> = (value: unknown) => Result<T, string>;

/** Method-specific parsers for both variants of a serialized RPC Result. */
export interface RpcResultParsers<T, E> {
	readonly success: RpcPayloadParser<T>;
	readonly error: RpcPayloadParser<E>;
}

/** Serialize a Result into a clone-safe Durable Object RPC payload. */
export function toRpcResult<T, E>(result: Result<T, E>): RpcResult<T, E> {
	const serialized = Result.serialize(result);
	if (serialized.status === "ok") return serialized;
	return {
		status: "error",
		// SAFETY: serializeRpcError preserves E's enumerable transport contract while replacing only the Error prototype.
		error: serializeRpcError(serialized.error) as E,
	};
}

/** Project an Error into plain clone-safe data while retaining its typed fields. */
export function serializeRpcError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	return { ...Object.fromEntries(Object.entries(error)), name: error.name, message: error.message };
}

function invalidRpcPayload(
	method: string,
	variant: "envelope" | "success" | "error",
	parseError: string,
): Result<never, DurableObjectError> {
	return Result.err(
		new DurableObjectError({
			method,
			message: `Invalid RPC ${variant} payload: ${parseError}`,
		}),
	);
}

/** Deserialize and parse both the envelope and selected method-specific RPC payload. */
export function fromRpcResult<T, E>(
	value: unknown,
	method: string,
	parsers: RpcResultParsers<T, E>,
): Result<T, E | DurableObjectError> {
	if (typeof value !== "object" || value === null || !("status" in value)) {
		return invalidRpcPayload(method, "envelope", "expected serialized Result object");
	}
	if (value.status === "ok" && "value" in value) {
		const parsed = parsers.success(value.value);
		return parsed.status === "ok"
			? Result.ok(parsed.value)
			: invalidRpcPayload(method, "success", parsed.error);
	}
	if (value.status === "error" && "error" in value) {
		const parsed = parsers.error(value.error);
		return parsed.status === "ok"
			? Result.err(parsed.value)
			: invalidRpcPayload(method, "error", parsed.error);
	}
	return invalidRpcPayload(method, "envelope", "unknown status or missing variant payload");
}

/** Normalize a Durable Object transport rejection into an expected infrastructure error. */
export function rpcInfraError(method: string, error: unknown): Result<never, DurableObjectError> {
	return Result.err(
		new DurableObjectError({
			method,
			message: error instanceof Error ? error.message : String(error),
			cause: error,
		}),
	);
}

/** Execute a Durable Object RPC call and parse its complete method-specific result contract. */
export async function callRpcResult<T, E>(
	method: string,
	call: Promise<unknown>,
	parsers: RpcResultParsers<T, E>,
): Promise<Result<T, E | DurableObjectError>> {
	try {
		return fromRpcResult(await call, method, parsers);
	} catch (error) {
		return rpcInfraError(method, error);
	}
}
