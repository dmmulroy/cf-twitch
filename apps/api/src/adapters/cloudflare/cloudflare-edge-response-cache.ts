import { Result, TaggedError } from "better-result";
import { z } from "zod";

import { normalizeError } from "../../lib/logger";

import type { Logger } from "../../lib/logging";
import type { Result as ResultType } from "better-result";

/** Expected failure when fresh data violates a route's edge-response contract. */
export class EdgeCacheValueError extends TaggedError("EdgeCacheValueError")<{
	readonly operation: "parseFreshValue";
	readonly message: string;
	readonly parseError: string;
}>() {
	constructor(parseError: string) {
		super({
			operation: "parseFreshValue",
			message: "Edge cache fresh value parsing failed",
			parseError,
		});
	}
}

/** Expected failure when a cache loader rejects instead of returning a Result. */
export class EdgeCacheLoadError extends TaggedError("EdgeCacheLoadError")<{
	readonly operation: "loadFreshValue";
	readonly message: string;
	readonly cause: unknown;
}>() {
	constructor(cause: unknown) {
		super({ operation: "loadFreshValue", message: "Edge cache fresh value loading failed", cause });
	}
}

/** Options for one validated read-through edge response. */
export type ReadThroughEdgeResponseOptions<T, E> = Readonly<{
	key: string;
	maxAgeSeconds: number;
	schema: z.ZodType<T>;
	load: () => Promise<ResultType<T, E>>;
}>;

/** Owns validated read-through edge caching and best-effort detached writes. */
export class CloudflareEdgeResponseCache {
	constructor(
		private readonly cache: Cache,
		private readonly schedule: (task: Promise<void>) => void,
		private readonly logger: Logger,
	) {}

	/** Reads a validated cached value or loads, validates, and schedules storage of a fresh value. */
	async readThrough<T, E>(
		options: ReadThroughEdgeResponseOptions<T, E>,
	): Promise<ResultType<T, E | EdgeCacheValueError | EdgeCacheLoadError>> {
		const request = new Request(options.key, { method: "GET" });
		const cacheLogger = this.logger.child({
			component: "cache",
			cache_key: request.url,
			ttl_seconds: options.maxAgeSeconds,
		});
		cacheLogger.info("Looking up edge cache", { event: "cache.lookup" });

		try {
			const cached = await this.cache.match(request);
			if (cached !== undefined) {
				const parsed = await this.parseCachedResponse(cached, options.schema);
				if (parsed.status === "ok") {
					cacheLogger.info("Edge cache hit", { event: "cache.hit" });
					return parsed;
				}
				cacheLogger.warn("Invalid edge cache entry", {
					event: "cache.invalid",
					error_tag: parsed.error._tag,
				});
				this.schedule(this.deleteBestEffort(request, cacheLogger));
			}
		} catch (cause) {
			cacheLogger.warn("Edge cache lookup failed", {
				event: "cache.lookup_failed",
				...normalizeError(cause),
			});
		}

		cacheLogger.info("Edge cache miss", { event: "cache.miss" });
		let loaded: ResultType<T, E>;
		try {
			loaded = await options.load();
		} catch (cause) {
			return Result.err(new EdgeCacheLoadError(cause));
		}
		if (loaded.status === "error") return Result.err(loaded.error);

		const parsedFresh = options.schema.safeParse(loaded.value);
		if (!parsedFresh.success) return Result.err(new EdgeCacheValueError(parsedFresh.error.message));
		this.schedule(
			this.storeBestEffort(request, parsedFresh.data, options.maxAgeSeconds, cacheLogger),
		);
		return Result.ok(parsedFresh.data);
	}

	private async parseCachedResponse<T>(
		response: Response,
		schema: z.ZodType<T>,
	): Promise<ResultType<T, EdgeCacheValueError>> {
		try {
			const parsed = schema.safeParse(await response.json());
			return parsed.success
				? Result.ok(parsed.data)
				: Result.err(new EdgeCacheValueError(parsed.error.message));
		} catch (cause) {
			return Result.err(new EdgeCacheValueError(String(cause)));
		}
	}

	private async deleteBestEffort(request: Request, logger: Logger): Promise<void> {
		try {
			await this.cache.delete(request);
			logger.info("Evicted invalid edge cache entry", { event: "cache.evict_succeeded" });
		} catch (cause) {
			logger.warn("Failed to evict invalid edge cache entry", {
				event: "cache.evict_failed",
				...normalizeError(cause),
			});
		}
	}

	private async storeBestEffort<T>(
		request: Request,
		value: T,
		maxAgeSeconds: number,
		logger: Logger,
	): Promise<void> {
		try {
			await this.cache.put(
				request,
				Response.json(value, {
					headers: {
						"Cache-Control": `public, max-age=${maxAgeSeconds}`,
						Vary: "Accept-Encoding",
					},
				}),
			);
			logger.info("Stored edge cache response", { event: "cache.store_succeeded" });
		} catch (cause) {
			logger.warn("Failed to store edge cache response", {
				event: "cache.store_failed",
				...normalizeError(cause),
			});
		}
	}
}
