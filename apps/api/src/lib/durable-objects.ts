/** Durable Object RPC serialization utilities. */

import { Err, Ok } from "better-result";

import { serializeRpcError } from "./rpc-result";

/**
 * Serializes a Result-returning Durable Object method into a clone-safe RPC envelope.
 * The declared method contract remains unchanged for local callers and generated stubs.
 */
export function rpc<This, Args extends unknown[], Return>(
	method: (this: This, ...args: Args) => Promise<Return>,
	_context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>,
): (this: This, ...args: Args) => Promise<Return> {
	return async function (this: This, ...args: Args): Promise<Return> {
		const result = await method.call(this, ...args);
		if (!(result instanceof Ok) && !(result instanceof Err)) return result;

		const serialized =
			result instanceof Ok
				? { status: "ok", value: result.value }
				: { status: "error", error: serializeRpcError(result.error) };
		// SAFETY: The clone-safe envelope is the wire representation of the declared Result.
		return serialized as Return;
	};
}
