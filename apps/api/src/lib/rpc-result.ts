import { Result, type SerializedResult } from "better-result";

import { DurableObjectError } from "./errors";

/**
 * RPC-safe representation of a {@link Result}.
 *
 * Durable Object RPC cannot clone `better-result` class instances directly, so
 * Result values must cross the wire as plain serialized objects.
 */
export type RpcResult<T, E> = SerializedResult<T, E>;

/**
 * Serializes a project-native {@link Result} into an RPC-safe payload.
 *
 * Use this on the server side at the last transport boundary, typically from a
 * `RpcTarget` method right before the value is returned to a remote caller.
 *
 * @template T Success value type.
 * @template E Error value type.
 * @param result Result produced by Durable Object business logic.
 * @returns A plain-object payload that can be returned over Durable Object RPC.
 * @throws {never} This helper does not throw for valid Result inputs.
 * @example
 * ```ts
 * class SongQueueHandle extends RpcTarget {
 *   getSongQueue(limit: number) {
 *     return queue.getSongQueueInternal(limit).then(toRpcResult);
 *   }
 * }
 * ```
 */
export function toRpcResult<T, E>(result: Result<T, E>): RpcResult<T, E> {
	const serialized = Result.serialize(result);
	if (serialized.status === "ok") return serialized;

	return {
		status: "error",
		// SAFETY: RPC error serialization preserves E's enumerable data contract while
		// replacing an uncloneable Error prototype with a plain transport projection.
		error: serializeRpcError(serialized.error) as E,
	};
}

/**
 * Projects an Error into a plain RPC-safe object while preserving typed context.
 *
 * Non-Error values already use their transport representation and pass through
 * unchanged. Standard Error fields are copied explicitly because they are not
 * enumerable; custom tagged-error fields are retained through object entries.
 *
 * @param error Error value crossing a Durable Object RPC boundary.
 * @returns An RPC-safe error projection, or the original non-Error value.
 */
export function serializeRpcError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;

	return {
		...Object.fromEntries(Object.entries(error)),
		name: error.name,
		message: error.message,
	};
}

/**
 * Deserializes an unknown RPC payload back into a project-native {@link Result}.
 *
 * If the payload is not a serialized Result, the failure is converted into a
 * {@link DurableObjectError} so callers still receive an error-as-value.
 *
 * @template T Success value type expected by the caller.
 * @template E Error value type expected by the caller.
 * @param value Raw value returned by a remote RPC call.
 * @param method Logical RPC method name used in infrastructure error messages.
 * @returns The deserialized Result on success, or `Result.err(DurableObjectError)`
 * when the payload is not a valid serialized Result.
 * @throws {never} Invalid payloads are wrapped as `DurableObjectError` values.
 * @example
 * ```ts
 * const raw = await handle.getSongQueue(25);
 * const result = fromRpcResult<QueueResult, SongQueueDbError>(raw, "getSongQueue");
 * ```
 */
export function fromRpcResult<T, E>(
	value: unknown,
	method: string,
): Result<T, E | DurableObjectError> {
	const deserialized = Result.deserialize<T, E>(value);

	if (deserialized !== null) {
		return deserialized;
	}

	return Result.err(
		new DurableObjectError({
			method,
			message: "Invalid RPC result payload",
		}),
	);
}

/**
 * Normalizes an RPC transport failure into a {@link DurableObjectError} Result.
 *
 * Use this when the RPC call itself failed before a serialized Result payload
 * could be returned, for example due to a rejected promise or infrastructure
 * exception.
 *
 * @param method Logical RPC method name used in the generated error message.
 * @param error Unknown thrown or rejected value from the RPC layer.
 * @returns `Result.err(DurableObjectError)` describing the transport failure.
 * @throws {never} This helper always returns an error Result instead of throwing.
 * @example
 * ```ts
 * try {
 *   await handle.getSongQueue(25);
 * } catch (error) {
 *   return rpcInfraError("getSongQueue", error);
 * }
 * ```
 */
export function rpcInfraError(method: string, error: unknown): Result<never, DurableObjectError> {
	return Result.err(
		new DurableObjectError({
			method,
			message: error instanceof Error ? error.message : String(error),
			cause: error,
		}),
	);
}

/**
 * Executes a remote RPC call and converts its transport payload back into a
 * project-native {@link Result}.
 *
 * This is the client-side convenience wrapper used by typed facades. It handles
 * both success-path deserialization and infrastructure failures so callers can
 * continue working with `Result<T, E | DurableObjectError>`.
 *
 * @template T Success value type expected from the RPC method.
 * @template E Domain error value type expected from the RPC method.
 * @param method Logical RPC method name used for error reporting.
 * @param call Promise for the raw RPC payload returned by the remote handle.
 * @returns A deserialized Result value. Infrastructure failures are returned as
 * `DurableObjectError` values instead of being thrown.
 * @throws {never} Rejections are caught and converted into `DurableObjectError`.
 * @example
 * ```ts
 * return callRpcResult<QueueResult, SongQueueDbError>(
 *   "getSongQueue",
 *   handle.getSongQueue(limit),
 * );
 * ```
 */
export async function callRpcResult<T, E>(
	method: string,
	call: Promise<unknown>,
): Promise<Result<T, E | DurableObjectError>> {
	try {
		const raw = await call;
		return fromRpcResult<T, E>(raw, method);
	} catch (error) {
		return rpcInfraError(method, error);
	}
}
