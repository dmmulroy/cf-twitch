/**
 * Durable Objects utilities
 *
 * - @rpc: Method decorator for auto-serializing Result returns
 * - getStub: Get typed DO stub with autocomplete and Result deserialization
 *
 * ## Architecture
 *
 * The challenge: DO RPC methods need to return Results, but workerd throws
 * DataCloneError for class instances.
 *
 * Solution: Serialize Results to plain objects on DO side, deserialize on caller side.
 *
 * ### DO side - use @rpc decorator
 * ```typescript
 * class SongQueueDO extends DurableObject<Env> {
 *   @rpc
 *   async getData(): Promise<Result<Data, Error>> {
 *     return Result.tryPromise({...});
 *   }
 * }
 * ```
 *
 * ### Caller side - getStub auto-deserializes
 * ```typescript
 * const stub = getStub("SONG_QUEUE_DO");
 * const result = await stub.getData(); // Result<Data, Error | DurableObjectError>
 * ```
 *
 * ## Important: DO NOT use Reflect.get() on DO stubs
 *
 * workerd's DO stubs have special property access behavior where Reflect.get()
 * returns a different (broken) function than direct property access. Always use
 * direct property access: `stub[prop]` not `Reflect.get(stub, prop)`.
 */

import { Result } from "better-result";
import { env as globalEnv } from "cloudflare:workers";

import { DurableObjectError } from "./errors";
import { logger, normalizeError, startTimer } from "./logger";

// =============================================================================
// rpcReturn - Result Serialization for RPC
// =============================================================================

/**
 * DEPRECATED: No-op wrapper, kept for backward compatibility.
 * workerd bypasses prototype modifications - use rpcReturn() in DO methods instead.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- mixin pattern requires any[]
export function withRpcSerialization<T extends new (...args: any[]) => object>(BaseClass: T): T {
	return BaseClass;
}

// =============================================================================
// @rpc Decorator - TC39 Stage 3 Method Decorator
// =============================================================================

import { Ok, Err } from "better-result";

/**
 * Check if a value is a Result instance
 */
function isResult(value: unknown): value is Ok<unknown, unknown> | Err<unknown, unknown> {
	return value instanceof Ok || value instanceof Err;
}

/**
 * Method decorator for DO methods that return Results over RPC.
 * Automatically serializes Result return values for RPC transport.
 *
 * Uses TC39 Stage 3 decorators (TypeScript 5.0+ native support).
 *
 * @example
 * ```typescript
 * class SongQueueDO extends DurableObject<Env> {
 *   @rpc
 *   async getCurrentlyPlaying(): Promise<Result<Track, Error>> {
 *     return Result.tryPromise({...});
 *   }
 * }
 * ```
 */
export function rpc<This, Args extends unknown[], Return>(
	method: (this: This, ...args: Args) => Promise<Return>,
	_context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>,
): (this: This, ...args: Args) => Promise<Return> {
	return async function (this: This, ...args: Args): Promise<Return> {
		const result = await method.call(this, ...args);

		if (isResult(result)) {
			return Result.serialize(result) as Return;
		}

		return result;
	};
}

/**
 * Serialize a Result for RPC transport.
 *
 * Call this at the end of every DO RPC method that returns a Result.
 * The `wrapStub()` on the caller side will deserialize back to Result.
 *
 * @example
 * ```typescript
 * async getCurrentlyPlaying(): Promise<SerializedResult<Track, Error>> {
 *   const result = await this.doWork();
 *   return rpcReturn(result);
 * }
 * ```
 */
export function rpcReturn<T, E>(result: Result<T, E>): ReturnType<typeof Result.serialize<T, E>> {
	return Result.serialize(result);
}

// =============================================================================
// Environment Access
// =============================================================================

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
	COMMANDS_DO: "commands",
	// Saga DOs are NOT singletons - they are keyed by redemption ID
	// Do not add SONG_REQUEST_SAGA_DO or KEYBOARD_RAFFLE_SAGA_DO here
};

/**
 * Get a typed DO stub with Result deserialization.
 *
 * Uses global env from cloudflare:workers with proper method binding
 * to avoid "Illegal invocation" errors.
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

	return wrapStub<ExtractDO<K>>(stub, resolvedId);
}

/**
 * Wrap a DO stub with Result deserialization.
 *
 * When DO methods return serialized Results (via rpcReturn),
 * this wrapper deserializes them back to proper Result instances.
 *
 * IMPORTANT: DO NOT use Reflect.get() on DO stubs - workerd's stubs have
 * special property access behavior where Reflect.get returns a different
 * (broken) function than direct property access.
 */
function wrapStub<DO>(stub: DurableObjectStub, stubName?: string): DeserializedStub<DO> {
	const stubLogger = logger.child({
		component: "durable_object",
		do_name: stubName,
		do_id: stub.id.toString(),
		code_path: "lib/durable-objects.wrapStub",
	});
	let hasInitializedName = false;
	let initializeNamePromise: Promise<void> | null = null;

	const ensureAgentName = async (): Promise<void> => {
		if (!stubName || hasInitializedName) {
			return;
		}

		if (initializeNamePromise) {
			await initializeNamePromise;
			return;
		}

		initializeNamePromise = (async () => {
			stubLogger.info("Initializing durable object agent name", {
				event: "do.stub.set_name.started",
			});
			// Agent-based Durable Object stubs expose setName(). Production traffic can hit
			// RPC methods before the agent runtime has persisted a name, which surfaces as:
			// "Attempting to read .name on <Agent> before it was set".
			//
			// Calling the native PartyServer set-name fetch route is a more reliable bootstrap
			// path than RPC setName() for cold-start entrypoints like alarm(), because it uses
			// the same initialization flow PartyServer expects for request-based startup.
			// Fall back to RPC setName() in case fetch-based initialization is unavailable.
			// oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- dynamic access
			const setName = (stub as Record<string | symbol, unknown>).setName;
			if (typeof setName !== "function") {
				hasInitializedName = true;
				return;
			}

			try {
				const request = new Request(
					"http://dummy-example.cloudflare.com/cdn-cgi/partyserver/set-name/",
				);
				request.headers.set("x-partykit-room", stubName);
				const response = await stub.fetch(request);
				await response.text();
				stubLogger.info("Initialized durable object agent name", {
					event: "do.stub.set_name.succeeded",
				});
			} catch (error) {
				try {
					// oxlint-disable-next-line typescript/no-unsafe-call -- dynamic call on RPC stub
					await setName(stubName);
					stubLogger.info("Initialized durable object agent name", {
						event: "do.stub.set_name.succeeded",
						outcome: "rpc_fallback",
					});
				} catch (fallbackError) {
					stubLogger.error("Failed to initialize durable object agent name", {
						event: "do.stub.set_name.failed",
						...normalizeError(error),
						fallback_error_message:
							fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
					});
					throw fallbackError;
				}
			}

			hasInitializedName = true;
		})();

		try {
			await initializeNamePromise;
		} finally {
			initializeNamePromise = null;
		}
	};

	// oxlint-disable-next-line typescript/no-unsafe-return -- proxy reflection
	return new Proxy(stub, {
		get(target, prop) {
			// CRITICAL: Use direct property access, NOT Reflect.get!
			// DO stubs have special behavior where Reflect.get returns a different function
			// that fails with "Could not serialize object of type 'DurableObject'"
			// oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- dynamic access
			const original = (target as Record<string | symbol, unknown>)[prop];

			if (typeof original !== "function") {
				// oxlint-disable-next-line typescript/no-unsafe-return -- proxy passthrough
				return original;
			}

			// Return a wrapper function that calls the original method
			return async (...args: unknown[]) => {
				const rpcMethod = String(prop);
				const timer = startTimer();
				stubLogger.info("Durable Object RPC started", {
					event: "do.rpc.started",
					rpc_method: rpcMethod,
				});
				try {
					if (prop === "setName") {
						const result = await (original as (...a: unknown[]) => unknown)(...args);
						hasInitializedName = true;
						stubLogger.info("Durable Object RPC succeeded", {
							event: "do.rpc.succeeded",
							rpc_method: rpcMethod,
							duration_ms: timer(),
							result_status: "ok",
						});
						return Result.ok(result);
					}

					await ensureAgentName();

					// oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-call -- dynamic call
					const result = await (original as (...a: unknown[]) => unknown)(...args);
					const deserialized = Result.deserialize(result);
					if (deserialized !== null) {
						stubLogger.info("Durable Object RPC succeeded", {
							event: "do.rpc.succeeded",
							rpc_method: rpcMethod,
							duration_ms: timer(),
							result_status: deserialized.status,
							...(deserialized.status === "error" ? normalizeError(deserialized.error) : {}),
						});
						return deserialized;
					}

					stubLogger.info("Durable Object RPC succeeded", {
						event: "do.rpc.succeeded",
						rpc_method: rpcMethod,
						duration_ms: timer(),
						result_status: "ok",
					});
					return Result.ok(result);
				} catch (error) {
					stubLogger.error("Durable Object RPC failed", {
						event: "do.rpc.failed",
						rpc_method: rpcMethod,
						duration_ms: timer(),
						...normalizeError(error),
					});
					return Result.err(
						new DurableObjectError({
							method: rpcMethod,
							message: error instanceof Error ? error.message : String(error),
							cause: error,
						}),
					);
				}
			};
		},
	}) as DeserializedStub<DO>;
}
