/**
 * Validated edge caching for public stats responses.
 */

import { z } from "zod";

import { logger, normalizeError } from "./logger";

import type { Result } from "better-result";
import type { Context } from "hono";

/** Configuration that gives a stats response one canonical, runtime-validated cache contract. */
export interface EdgeCacheOptions<T> {
	/** Canonical URL derived from parsed route input rather than the raw request URL. */
	readonly cacheKey: string;
	/** Runtime schema used when data re-enters through RPC results or the Cache API. */
	readonly valueSchema: z.ZodType<T>;
	/** Converts malformed successful data into an uncached HTTP failure. */
	readonly onInvalidValue: (issues: readonly z.core.$ZodIssue[]) => Response;
	/** Converts an unexpected fetcher rejection into an uncached HTTP failure. */
	readonly onFetcherFailure: (cause: unknown) => Response;
	/** Shared edge and browser cache lifetime in seconds; defaults to 60. */
	readonly maxAge?: number;
}

/**
 * Cache a successful stats response after validating both fresh and cached serialized data.
 *
 * Cache lookup, eviction, and storage failures are non-fatal and receive outcome-specific
 * telemetry. Fetch and schema failures are never cached.
 */
export async function withEdgeCache<T, E extends { message: string }>(
	c: Context,
	fetcher: () => Promise<Result<unknown, E>>,
	onError: (error: E) => Response,
	options: EdgeCacheOptions<T>,
): Promise<Response> {
	const cache = caches.default;
	const maxAge = options.maxAge ?? 60;
	const cacheKey = new Request(options.cacheKey, { method: "GET" });
	const cacheLogger = logger.child({
		component: "cache",
		route: c.req.path,
		cache_key: cacheKey.url,
		ttl_seconds: maxAge,
	});

	cacheLogger.info("Looking up edge cache", { event: "cache.lookup" });
	try {
		const cached = await cache.match(cacheKey);
		if (cached) {
			try {
				const parsed = options.valueSchema.safeParse(await cached.clone().json());
				if (parsed.success) {
					cacheLogger.info("Edge cache hit", { event: "cache.hit" });
					return cached;
				}
				cacheLogger.warn("Invalid edge cache entry", {
					event: "cache.invalid",
					issue_count: parsed.error.issues.length,
				});
			} catch (cause) {
				cacheLogger.warn("Failed to parse edge cache entry", {
					event: "cache.parse_failed",
					...normalizeError(cause),
				});
			}
			c.executionCtx.waitUntil(
				cache.delete(cacheKey).then(
					() =>
						cacheLogger.info("Evicted invalid edge cache entry", {
							event: "cache.evict_succeeded",
						}),
					(cause) =>
						cacheLogger.warn("Failed to evict invalid edge cache entry", {
							event: "cache.evict_failed",
							...normalizeError(cause),
						}),
				),
			);
		}
	} catch (cause) {
		cacheLogger.warn("Edge cache lookup failed", {
			event: "cache.lookup_failed",
			...normalizeError(cause),
		});
	}

	cacheLogger.info("Edge cache miss", { event: "cache.miss" });
	let result: Result<unknown, E>;
	try {
		result = await fetcher();
	} catch (cause) {
		cacheLogger.error("Stats fetcher rejected", {
			event: "cache.fetcher_failed",
			...normalizeError(cause),
		});
		return options.onFetcherFailure(cause);
	}

	if (result.status === "error") return onError(result.error);

	const parsed = options.valueSchema.safeParse(result.value);
	if (!parsed.success) {
		cacheLogger.error("Fresh stats response validation failed", {
			event: "cache.value_invalid",
			issue_count: parsed.error.issues.length,
		});
		return options.onInvalidValue(parsed.error.issues);
	}

	const response = Response.json(parsed.data, {
		status: 200,
		headers: {
			"Cache-Control": `public, max-age=${maxAge}`,
			Vary: "Accept-Encoding",
		},
	});

	c.executionCtx.waitUntil(
		cache.put(cacheKey, response.clone()).then(
			() => cacheLogger.info("Stored edge cache response", { event: "cache.store_succeeded" }),
			(cause) =>
				cacheLogger.warn("Failed to store edge cache response", {
					event: "cache.store_failed",
					...normalizeError(cause),
				}),
		),
	);
	return response;
}
