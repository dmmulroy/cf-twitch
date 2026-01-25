/**
 * HTTP caching utilities for stats endpoints
 *
 * Uses Cloudflare Cache API for edge caching + browser Cache-Control.
 * All visitors share the same edge-cached response within TTL.
 */

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

	// Check edge cache first
	const cached = await cache.match(cacheKey);
	if (cached) {
		return cached;
	}

	// Cache miss - fetch data
	const result = await fetcher();

	if (result.status === "error") {
		// Errors are NOT cached
		return onError(result.error);
	}

	// Success - create response and cache
	const response = new Response(JSON.stringify(result.value), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": `public, max-age=${maxAge}`,
			Vary: "Accept-Encoding",
		},
	});

	// Store in edge cache (non-blocking)
	c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));

	return response;
}
