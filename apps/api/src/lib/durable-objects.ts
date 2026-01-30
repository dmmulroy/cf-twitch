/**
 * Durable Objects utilities
 *
 * - getStub: Get typed DO stub with autocomplete and Result deserialization
 * - withResultSerialization: Wrap DO class for auto Result serialization
 */

import { Ok, Err, Result } from "better-result";
import { RpcTarget, env as globalEnv } from "cloudflare:workers";

import { DurableObjectError } from "./errors";

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
 * Wrap a DO stub with Result deserialization and error handling.
 * Cast: CF's Rpc types break on classes with Symbol properties (like Result's [Symbol.iterator]).
 * We use our own DeserializedStub type that works directly with the DO class.
 *
 * NOTE: We use .call() at invocation time to preserve `this` binding.
 * Can't use .bind() because it causes DataCloneError when serializing across RPC.
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
					// oxlint-disable-next-line typescript/no-unsafe-assignment -- dynamic call
					const result = await method(...args);

					const deserialized = Result.deserialize(result);
					if (deserialized !== null) {
						return deserialized;
					}

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

						if (result instanceof RpcTarget) {
							return result;
						}

						if (isResult(result)) {
							return Result.serialize(result);
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
