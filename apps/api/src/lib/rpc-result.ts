import { Result, type SerializedResult } from "better-result";

import { DurableObjectError } from "./errors";

import type { JsonValue } from "./codecs";

/** Clone-safe wire representation of a better-result value. */
export type RpcResult<T, E> = SerializedResult<T, E>;

/** Untrusted JSON-safe value returned by Durable Object RPC before boundary decoding. */
export type RpcWireValue = JsonValue | undefined;

/** Normalize a Durable Object transport rejection into an expected infrastructure error. */
export function rpcInfraError<Cause>(
	method: string,
	error: Cause,
): Result<never, DurableObjectError> {
	return Result.err(
		new DurableObjectError({
			method,
			message: error instanceof Error ? error.message : String(error),
			cause: error,
		}),
	);
}

/** Execute an owned Durable Object RPC and decode its named Result contract. */
export async function callRpcResultUnsafe<T, E, WireValue>(
	method: string,
	call: Promise<WireValue>,
	deserializeUnsafe: (value: WireValue) => Result<T, E> | Promise<Result<T, E>>,
): Promise<Result<T, E | DurableObjectError>> {
	let value: WireValue;
	try {
		value = await call;
	} catch (error) {
		return rpcInfraError(method, error);
	}
	return await deserializeUnsafe(value);
}
