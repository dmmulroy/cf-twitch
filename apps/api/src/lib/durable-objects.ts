/** Durable Object RPC serialization utilities. */

import type { RpcWireValue } from "./rpc-result";

interface OwnedRpcResultCodec {
	serializeUnsafe(result: never): RpcWireValue | Promise<RpcWireValue>;
}

/** Serializes one owned Durable Object RPC method through its named Result contract. */
export function rpc(codec: OwnedRpcResultCodec) {
	return function <This, Args extends unknown[], Return>(
		method: (this: This, ...args: Args) => Promise<Return>,
		_context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>,
	): (this: This, ...args: Args) => Promise<Return> {
		return async function (this: This, ...args: Args): Promise<Return> {
			const result = await method.call(this, ...args);
			// SAFETY: The decorator's codec owns this method's Result contract; `never` preserves its generic branch precision.
			const serialized = await codec.serializeUnsafe(result as never);
			// SAFETY: Cloudflare exposes the serialized envelope while local method typing retains Result.
			return serialized as Return;
		};
	};
}
