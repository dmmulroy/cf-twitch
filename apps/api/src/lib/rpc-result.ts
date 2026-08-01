import { Result, type SerializedResult } from "better-result";

import { DurableObjectError } from "./errors";

/** Clone-safe wire representation of a better-result value. */
export type RpcResult<T, E> = SerializedResult<T, E>;

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

/** Execute an owned Durable Object RPC and decode its named Result contract. */
export async function callRpcResultUnsafe<T, E>(
	method: string,
	call: Promise<unknown>,
	deserializeUnsafe: (value: unknown) => Result<T, E> | Promise<Result<T, E>>,
): Promise<Result<T, E | DurableObjectError>> {
	let value: unknown;
	try {
		value = await call;
	} catch (error) {
		return rpcInfraError(method, error);
	}
	return await deserializeUnsafe(value);
}
