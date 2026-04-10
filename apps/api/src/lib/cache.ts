/**
 * HTTP caching utilities for stats endpoints
 *
 * Uses Cloudflare Cache API for edge caching + browser Cache-Control.
 * All visitors share the same edge-cached response within TTL.
 */

import { logger, normalizeError } from "./logger";

import type { Result } from "better-result";
import type { Context } from "hono";

/**
 * Cache-through pattern using Cloudflare Cache API.
 *
 * 1. Check edge cache for existing response
 * 2. On hit: return cached response directly
 * 3. On miss: call fetcher, handle Result
 *    - Error: return error response (NOT cached)
 *    - Success: cache at edge, return response
 *
 * @param c - Hono context
 * @param fetcher - Returns Result<T, E> - only success is cached
 * @param onError - Error handler returns Response (not cached)
 * @param maxAge - Cache TTL in seconds (default: 60)
 */
export async function withEdgeCache<T, E extends { message: string }>(
	c: Context,
	fetcher: () => Promise<Result<T, E>>,
	onError: (error: E) => Response,
	maxAge = 60,
): Promise<Response> {
	const cache = caches.default;
	const cacheKey = new Request(c.req.url, { method: "GET" });
	const cacheLogger = logger.child({
		component: "cache",
		route: c.req.path,
		cache_key: cacheKey.url,
		ttl_seconds: maxAge,
	});

	cacheLogger.info("Looking up edge cache", {
		event: "cache.lookup",
	});

	try {
		const cached = await cache.match(cacheKey);
		if (cached) {
			cacheLogger.info("Edge cache hit", {
				event: "cache.hit",
			});
			return cached;
		}
	} catch (error) {
		cacheLogger.warn("Edge cache lookup failed", {
			event: "cache.fetch_failed",
			...normalizeError(error),
		});
	}

	cacheLogger.info("Edge cache miss", {
		event: "cache.miss",
	});
	const result = await fetcher();

	if (result.status === "error") {
		return onError(result.error);
	}

	const response = new Response(JSON.stringify(result.value), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": `public, max-age=${maxAge}`,
			Vary: "Accept-Encoding",
		},
	});

	cacheLogger.info("Scheduling edge cache store", {
		event: "cache.store_scheduled",
	});
	c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));

	return response;
}
