/**
 * Durable Objects utilities
 *
 * - getStub: Get typed DO stub with autocomplete and Result deserialization
 * - withResultSerialization: Wrap DO class for auto Result serialization via RpcResult
 *
 * ## Architecture
 *
 * The challenge: DO RPC methods need to return Results, but workerd throws
 * DataCloneError for class instances. We also need internal DO method calls
 * to work naturally with Results.
 *
 * Solution: RpcResult extends RpcTarget (allowed over RPC) and forwards all
 * Result methods. This enables:
 * - Internal calls: Get RpcResult instance, use .isErr() directly (forwarded)
 * - External calls: getStub() detects RpcResult stub, calls __unwrap__() via
 *   promise pipelining (single round trip), deserializes to real Result
 */

import { Ok, Err, Result } from "better-result";
import { RpcTarget, env as globalEnv } from "cloudflare:workers";

import { DurableObjectError } from "./errors";

// =============================================================================
// RpcResult - Result wrapper that can cross RPC boundary
// =============================================================================

/**
 * Wraps a Result to cross RPC boundaries. Extends RpcTarget so workerd allows
 * it over RPC (as a stub). Uses Proxy to auto-forward all Result methods.
 *
 * Internal callers receive the actual RpcResult instance and can use methods
 * like .isErr() directly (auto-forwarded to inner Result).
 *
 * External callers (via getStub) receive a stub; getStub() auto-calls
 * __unwrap__() via promise pipelining and deserializes to a real Result.
 */
export class RpcResult<T, E> extends RpcTarget {
	// Store result for serialization - must be accessible for RPC
	private readonly _result: Result<T, E>;

	constructor(result: Result<T, E>) {
		super();
		this._result = result;

		// Return Proxy that auto-forwards all Result methods/properties
		// oxlint-disable-next-line typescript/no-unsafe-return -- proxy wrapper
		return new Proxy(this, {
			get(target, prop, receiver) {
				// __unwrap__ must be an actual method for RPC stubs to access
				// Return the bound method from the target
				if (prop === "__unwrap__") {
					return target.__unwrap__.bind(target);
				}

				// Pass through RpcTarget/Object internals
				if (
					prop === Symbol.toStringTag ||
					prop === "constructor" ||
					prop === Symbol.for("nodejs.util.inspect.custom") ||
					prop === "_result"
				) {
					return Reflect.get(target, prop, receiver);
				}

				// Forward everything else to inner Result
				// oxlint-disable-next-line typescript/no-unsafe-assignment -- dynamic property access
				const value = Reflect.get(target._result, prop);

				// Non-function properties (status, value, error) - return directly
				if (typeof value !== "function") {
					return value;
				}

				// Function properties - wrap to handle Result returns
				return (...args: unknown[]) => {
					// oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-call -- dynamic call
					const result = value.apply(target._result, args);

					// Wrap Result returns in RpcResult for method chaining
					if (result instanceof Ok || result instanceof Err) {
						return new RpcResult(result);
					}

					// Handle async methods that return Promise<Result>
					if (result instanceof Promise) {
						return result.then((r: unknown) =>
							r instanceof Ok || r instanceof Err ? new RpcResult(r) : r,
						);
					}

					// Other returns (match results, unwrap values, etc.) - pass through
					return result;
				};
			},

			// Support `prop in rpcResult` checks
			has(target, prop) {
				return prop in target || prop in target._result;
			},
		});
	}

	/**
	 * Serializes the inner Result for RPC transport. Called by getStub() wrapper
	 * using promise pipelining for single round-trip extraction.
	 *
	 * Must be an actual method (not just Proxy-defined) so RPC stubs can access it.
	 */
	__unwrap__(): { status: "ok"; value: T } | { status: "error"; error: E } {
		return Result.serialize(this._result);
	}
}

/**
 * Get the typed global env from cloudflare:workers
 */
function getEnv(): Env {
	return globalEnv as Env;
}

// =============================================================================
// Type Utilities
// =============================================================================

/**
 * Extract DO namespace keys from Env type
 */
type DONamespaceKeys = {
	[K in keyof Env]: Env[K] extends DurableObjectNamespace<infer _T> ? K : never;
}[keyof Env] &
	keyof Env;

/**
 * Extract the DO type from a namespace key
 */
type ExtractDO<K extends DONamespaceKeys> =
	Env[K] extends DurableObjectNamespace<infer T> ? T : never;

/**
 * Custom Serializable that strips symbol keys.
 * CF's Rpc.Serializable maps symbol keys to `never`, breaking types for classes
 * like better-result's Result which has [Symbol.iterator].
 */
type Serializable<T> = T extends undefined | null | boolean | number | bigint | string
	? T
	: T extends Array<infer U>
		? Array<Serializable<U>>
		: T extends Map<infer K, infer V>
			? Map<Serializable<K>, Serializable<V>>
			: T extends Set<infer V>
				? Set<Serializable<V>>
				: T extends object
					? { [K in keyof T as K extends string | number ? K : never]: Serializable<T[K]> }
					: never;

/**
 * Adds DurableObjectError to a Result's error union
 */
export type WithDOError<R> =
	R extends Result<infer T, infer E>
		? Result<T, E | DurableObjectError>
		: Result<Serializable<R>, DurableObjectError>;

/**
 * Extract public RPC methods from a DO class (excludes lifecycle methods and symbols)
 */
type DOPublicMethods<T> = {
	[K in keyof T as K extends string
		? T[K] extends (...args: infer _A) => infer _R
			? K extends "fetch" | "alarm" | "webSocketMessage" | "webSocketClose" | "webSocketError"
				? never
				: K
			: never
		: never]: T[K];
};

/**
 * Maps DO methods to include DurableObjectError in return types.
 * Uses the DO class directly (not DurableObjectStub) to avoid CF's Rpc type transformation
 * which breaks on classes with Symbol properties.
 */
export type DeserializedStub<DO> = {
	[K in keyof DOPublicMethods<DO>]: DO[K] extends (...args: infer Args) => Promise<infer R>
		? (...args: Args) => Promise<WithDOError<R>>
		: DO[K];
} & Pick<DurableObjectStub, "id" | "name">;

// =============================================================================
// getStub - Client-side stub wrapper
// =============================================================================

/**
 * Mapping of DO namespace keys to their singleton IDs.
 */
const SINGLETON_IDS: Record<string, string> = {
	SPOTIFY_TOKEN_DO: "spotify-token",
	TWITCH_TOKEN_DO: "twitch-token",
	STREAM_LIFECYCLE_DO: "stream-lifecycle",
	SONG_QUEUE_DO: "song-queue",
	ACHIEVEMENTS_DO: "achievements",
	KEYBOARD_RAFFLE_DO: "keyboard-raffle",
	EVENT_BUS_DO: "event-bus",
	// Saga DOs are NOT singletons - they are keyed by redemption ID
	// Do not add SONG_REQUEST_SAGA_DO or KEYBOARD_RAFFLE_SAGA_DO here
};

/**
 * Get a typed DO stub with Result deserialization.
 *
 * Uses global env from cloudflare:workers with proper method binding to avoid
 * "Illegal invocation" errors.
 *
 * @example
 * const stub = getStub("SPOTIFY_TOKEN_DO");
 * const stub = getStub("SONG_QUEUE_DO", "custom-queue-id");
 */
export function getStub<K extends DONamespaceKeys>(
	key: K,
	id?: string,
): DeserializedStub<ExtractDO<K>> {
	const env = getEnv();
	const namespace = env[key];
	const resolvedId = id ?? SINGLETON_IDS[key];

	if (!resolvedId) {
		throw new Error(`No singleton ID mapped for "${key}". Pass an explicit ID.`);
	}

	// Bind methods to preserve `this` context on namespace methods.
	// Extracting methods from DO namespace bindings causes "Illegal invocation" errors
	// because workerd uses `this instanceof DurableObjectNamespace` checks internally.
	// See: https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors
	const idFromName = namespace.idFromName.bind(namespace);
	const get = namespace.get.bind(namespace);

	const doId = idFromName(resolvedId);
	const stub = get(doId);

	return wrapStub<ExtractDO<K>>(stub);
}

/**
 * Wrap a DO stub with RpcResult unwrapping and Result deserialization.
 *
 * When DO methods return RpcResult (via withResultSerialization), this wrapper:
 * 1. Uses promise pipelining to call __unwrap__() - single round trip
 * 2. Deserializes the SerializedResult back to a proper Result instance
 *
 * This enables seamless Result DX across RPC boundaries.
 */
function wrapStub<DO>(stub: DurableObjectStub): DeserializedStub<DO> {
	// Proxy/reflection code is inherently untyped - disable unsafe rules for this block
	// oxlint-disable-next-line typescript/no-unsafe-return -- proxy reflection
	return new Proxy(stub, {
		get(target, prop) {
			// For non-method properties, pass through directly
			// oxlint-disable-next-line typescript/no-unsafe-assignment -- Reflect.get returns any
			const original = Reflect.get(target, prop);

			if (typeof original !== "function") {
				// oxlint-disable-next-line typescript/no-unsafe-return -- proxy passthrough
				return original;
			}

			// Return a wrapper function that calls the original method
			return async (...args: unknown[]) => {
				try {
					// Call the method directly on the target stub
					// Using bracket notation to avoid .call() which causes DataCloneError
					const method = (target as unknown as Record<string, unknown>)[prop as string];
					if (typeof method !== "function") {
						throw new Error(`Method ${String(prop)} is not a function`);
					}

					// Don't await - use promise pipelining for RpcResult
					// oxlint-disable-next-line typescript/no-unsafe-assignment -- dynamic call
					const resultPromise = method(...args);

					// Try to unwrap RpcResult via promise pipelining (single round trip)
					// If the method returns RpcResult, __unwrap__() returns SerializedResult
					// oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- RPC pipelining
					const unwrapMethod = (resultPromise as Record<string, unknown>).__unwrap__;
					if (typeof unwrapMethod === "function") {
						// oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-call -- RPC pipelining
						const serialized = await unwrapMethod();
						const deserialized = Result.deserialize(serialized);
						if (deserialized !== null && !Result.isError(deserialized)) {
							return deserialized;
						}
						// Deserialization returned an error (bad format) - return it
						if (deserialized !== null) {
							return deserialized;
						}
					}

					// Fallback: await the result normally (non-RpcResult return)
					// oxlint-disable-next-line typescript/no-unsafe-assignment -- dynamic call
					const result = await resultPromise;

					// Try to deserialize if it's a SerializedResult
					const deserialized = Result.deserialize(result);
					if (deserialized !== null && !Result.isError(deserialized)) {
						return deserialized;
					}

					// Not a Result - wrap in Ok
					return Result.ok(result);
				} catch (error) {
					return Result.err(
						new DurableObjectError({
							method: String(prop),
							message: error instanceof Error ? error.message : String(error),
							cause: error,
						}),
					);
				}
			};
		},
	}) as DeserializedStub<DO>;
}

// =============================================================================
// withResultSerialization - DO class wrapper
// =============================================================================

/** Methods that should not have their return values transformed */
const LIFECYCLE_METHODS = [
	"fetch",
	"alarm",
	"webSocketMessage",
	"webSocketClose",
	"webSocketError",
];

function isResult(value: unknown): value is Ok<unknown, unknown> | Err<unknown, unknown> {
	return value instanceof Ok || value instanceof Err;
}

/**
 * Generic DO class type for withResultSerialization wrapper.
 * Uses `any` for both env and return to avoid type conflicts between
 * our typed Env (with DurableObjectNamespace<T>) and generated Cloudflare.Env.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- required for generic DO class wrapper
type AnyDurableObjectClass = new (ctx: DurableObjectState, env: any) => any;

/**
 * Wraps a DO class to automatically wrap Result returns in RpcResult.
 *
 * This enables:
 * - Internal calls: Get RpcResult instance, use .isErr() directly (methods forwarded)
 * - External RPC calls: Workerd allows RpcResult (extends RpcTarget), getStub() unwraps it
 *
 * The Proxy intercepts all method calls and wraps Result returns in RpcResult.
 * RpcResult forwards all Result methods, so internal callers can use Results naturally.
 */
export function withResultSerialization<DO extends AnyDurableObjectClass>(Base: DO): DO {
	// Proxy/reflection code is inherently untyped - disable unsafe rules for this block
	// oxlint-disable-next-line typescript/no-unsafe-return -- class wrapper
	return class extends (Base as AnyDurableObjectClass) {
		// oxlint-disable-next-line typescript/no-explicit-any -- generic env type
		constructor(ctx: DurableObjectState, env: any) {
			super(ctx, env);

			// oxlint-disable-next-line typescript/no-unsafe-return -- proxy wrapper
			return new Proxy(this, {
				get(target, prop, receiver) {
					// oxlint-disable-next-line typescript/no-unsafe-assignment -- Reflect.get returns any
					const original = Reflect.get(target, prop, receiver);

					if (typeof original !== "function" || LIFECYCLE_METHODS.includes(String(prop))) {
						// oxlint-disable-next-line typescript/no-unsafe-return -- proxy passthrough
						return original;
					}

					return async (...args: unknown[]) => {
						// oxlint-disable-next-line typescript/no-unsafe-assignment -- dynamic call
						const result = await (original as (...a: unknown[]) => unknown).apply(target, args);

						// Already an RpcTarget (including RpcResult) - pass through
						if (result instanceof RpcTarget) {
							return result;
						}

						// Wrap Result in RpcResult for RPC transport
						// RpcResult forwards all Result methods, so internal callers work naturally
						if (isResult(result)) {
							return new RpcResult(result);
						}

						// oxlint-disable-next-line typescript/no-unsafe-return -- proxy passthrough
						return result;
					};
				},
			});
		}
	} as DO;
}

// =============================================================================
// Legacy exports for backwards compatibility
// =============================================================================

export { wrapStub as stubWithResultDeserialization };
export type { DeserializedStub as HydratedStub, WithDOError as AddDOError };
