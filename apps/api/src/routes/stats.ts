/**
 * Stats routes for public analytics data
 *
 * All routes use 60s edge cache via Cloudflare Cache API.
 * Errors are NOT cached - only successful responses.
 */

import { Hono } from "hono";
import { z } from "zod";

import { UserStatsNotFoundError } from "../durable-objects/keyboard-raffle-do";
import { withEdgeCache } from "../lib/cache";
import { getStub } from "../lib/durable-objects";
import { DurableObjectError } from "../lib/errors";
import { logger } from "../lib/logger";

import type { Env } from "../index";

const stats = new Hono<{ Bindings: Env }>();

/**
 * Shared limit query param schema
 */
const LimitSchema = z.object({
	limit: z.coerce.number().int().positive().max(100).default(10),
});

/**
 * Leaderboard query params schema
 */
const LeaderboardQuerySchema = LimitSchema.extend({
	sortBy: z.enum(["rolls", "wins", "closest"]).default("closest"),
});

/**
 * Check if error is a DurableObjectError (infrastructure failure)
 * Uses _tag check for reliability across RPC serialization
 */
function isDOInfraError(error: unknown): error is DurableObjectError {
	return (
		DurableObjectError.is(error) ||
		(typeof error === "object" &&
			error !== null &&
			"_tag" in error &&
			error._tag === "DurableObjectError")
	);
}

/**
 * Check if error is UserStatsNotFoundError
 * Uses _tag check for reliability across RPC serialization
 */
function isUserNotFound(error: unknown): boolean {
	return (
		UserStatsNotFoundError.is(error) ||
		(typeof error === "object" &&
			error !== null &&
			"_tag" in error &&
			error._tag === "UserStatsNotFoundError")
	);
}

/**
 * GET /api/stats/top-tracks
 * Returns most requested tracks across all users
 */
stats.get("/top-tracks", async (c) => {
	const query = LimitSchema.safeParse({ limit: c.req.query("limit") });
	if (!query.success) {
		return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
	}

	return withEdgeCache(
		c,
		() => getStub("SONG_QUEUE_DO").getTopTracks(query.data.limit),
		(error) => {
			if (isDOInfraError(error)) {
				logger.error("DO infrastructure error", { method: error.method, message: error.message });
				return c.json({ error: "Service temporarily unavailable" }, 503);
			}
			logger.error("Failed to get top tracks", { error: error.message });
			return c.json({ error: "Failed to fetch top tracks" }, 500);
		},
	);
});

/**
 * GET /api/stats/top-tracks/:user
 * Returns most requested tracks by a specific user
 */
stats.get("/top-tracks/:user", async (c) => {
	const userId = c.req.param("user");
	const query = LimitSchema.safeParse({ limit: c.req.query("limit") });
	if (!query.success) {
		return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
	}

	return withEdgeCache(
		c,
		() => getStub("SONG_QUEUE_DO").getTopTracksByUser(userId, query.data.limit),
		(error) => {
			if (isDOInfraError(error)) {
				logger.error("DO infrastructure error", { method: error.method, message: error.message });
				return c.json({ error: "Service temporarily unavailable" }, 503);
			}
			logger.error("Failed to get top tracks by user", { error: error.message, userId });
			return c.json({ error: "Failed to fetch top tracks" }, 500);
		},
	);
});

/**
 * GET /api/stats/top-requesters
 * Returns users with most song requests
 */
stats.get("/top-requesters", async (c) => {
	const query = LimitSchema.safeParse({ limit: c.req.query("limit") });
	if (!query.success) {
		return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
	}

	return withEdgeCache(
		c,
		() => getStub("SONG_QUEUE_DO").getTopRequesters(query.data.limit),
		(error) => {
			if (isDOInfraError(error)) {
				logger.error("DO infrastructure error", { method: error.method, message: error.message });
				return c.json({ error: "Service temporarily unavailable" }, 503);
			}
			logger.error("Failed to get top requesters", { error: error.message });
			return c.json({ error: "Failed to fetch top requesters" }, 500);
		},
	);
});

/**
 * GET /api/stats/raffle/leaderboard
 * Returns keyboard raffle leaderboard sorted by specified criteria
 */
stats.get("/raffle/leaderboard", async (c) => {
	const query = LeaderboardQuerySchema.safeParse({
		sortBy: c.req.query("sortBy"),
		limit: c.req.query("limit"),
	});
	if (!query.success) {
		return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
	}

	return withEdgeCache(
		c,
		() => getStub("KEYBOARD_RAFFLE_DO").getLeaderboard(query.data),
		(error) => {
			if (isDOInfraError(error)) {
				logger.error("DO infrastructure error", { method: error.method, message: error.message });
				return c.json({ error: "Service temporarily unavailable" }, 503);
			}
			logger.error("Failed to get raffle leaderboard", { error: error.message });
			return c.json({ error: "Failed to fetch leaderboard" }, 500);
		},
	);
});

/**
 * GET /api/stats/raffle/user/:user
 * Returns raffle stats for a specific user
 */
stats.get("/raffle/user/:user", async (c) => {
	const userId = c.req.param("user");

	return withEdgeCache(
		c,
		() => getStub("KEYBOARD_RAFFLE_DO").getUserStats(userId),
		(error) => {
			if (isUserNotFound(error)) {
				return c.json({ error: "User not found" }, 404);
			}
			if (isDOInfraError(error)) {
				logger.error("DO infrastructure error", { method: error.method, message: error.message });
				return c.json({ error: "Service temporarily unavailable" }, 503);
			}
			logger.error("Failed to get user raffle stats", { error: error.message, userId });
			return c.json({ error: "Failed to fetch user stats" }, 500);
		},
	);
});

export default stats;
