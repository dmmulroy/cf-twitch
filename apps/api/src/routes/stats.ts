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
import { type AppRouteEnv, getRequestLogger } from "../lib/request-context";

import type { Env } from "../index";

const stats = new Hono<AppRouteEnv<Env>>();

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
	const routeLogger = getRequestLogger(c).child({
		route: "/api/stats/top-tracks",
		component: "route",
	});
	const query = LimitSchema.safeParse({ limit: c.req.query("limit") });
	if (!query.success) {
		routeLogger.warn("Top tracks validation failed", {
			event: "stats.top_tracks.validation_failed",
		});
		return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
	}

	routeLogger.info("Loading top tracks", {
		event: "stats.top_tracks.started",
		limit: query.data.limit,
	});
	const result = await withEdgeCache(
		c,
		() => getStub("SONG_QUEUE_DO").getTopTracks(query.data.limit),
		(error) => {
			if (isDOInfraError(error)) {
				logger.error("DO infrastructure error", { method: error.method, message: error.message });
				return c.json({ error: "Service temporarily unavailable" }, 503);
			}
			routeLogger.error("Failed to get top tracks", {
				event: "stats.top_tracks.failed",
				limit: query.data.limit,
				error_message: error.message,
			});
			return c.json({ error: "Failed to fetch top tracks" }, 500);
		},
	);
	routeLogger.info("Loaded top tracks", {
		event: "stats.top_tracks.succeeded",
		limit: query.data.limit,
		status_code: result.status,
	});
	return result;
});

/**
 * GET /api/stats/top-tracks/:user
 * Returns most requested tracks by a specific user
 */
stats.get("/top-tracks/:user", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/stats/top-tracks/:user",
		component: "route",
	});
	const userId = c.req.param("user");
	const query = LimitSchema.safeParse({ limit: c.req.query("limit") });
	if (!query.success) {
		return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
	}
	routeLogger.info("Loading top tracks by user", {
		event: "stats.top_tracks_by_user.started",
		user_id: userId,
		limit: query.data.limit,
	});

	const result = await withEdgeCache(
		c,
		() => getStub("SONG_QUEUE_DO").getTopTracksByUser(userId, query.data.limit),
		(error) => {
			if (isDOInfraError(error)) {
				logger.error("DO infrastructure error", { method: error.method, message: error.message });
				return c.json({ error: "Service temporarily unavailable" }, 503);
			}
			routeLogger.error("Failed to get top tracks by user", {
				event: "stats.top_tracks_by_user.failed",
				user_id: userId,
				limit: query.data.limit,
				error_message: error.message,
			});
			return c.json({ error: "Failed to fetch top tracks" }, 500);
		},
	);
	routeLogger.info("Loaded top tracks by user", {
		event: "stats.top_tracks_by_user.succeeded",
		user_id: userId,
		limit: query.data.limit,
		status_code: result.status,
	});
	return result;
});

/**
 * GET /api/stats/top-requesters
 * Returns users with most song requests
 */
stats.get("/top-requesters", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/stats/top-requesters",
		component: "route",
	});
	const query = LimitSchema.safeParse({ limit: c.req.query("limit") });
	if (!query.success) {
		return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
	}
	routeLogger.info("Loading top requesters", {
		event: "stats.top_requesters.started",
		limit: query.data.limit,
	});
	const result = await withEdgeCache(
		c,
		() => getStub("SONG_QUEUE_DO").getTopRequesters(query.data.limit),
		(error) => {
			if (isDOInfraError(error)) {
				logger.error("DO infrastructure error", { method: error.method, message: error.message });
				return c.json({ error: "Service temporarily unavailable" }, 503);
			}
			routeLogger.error("Failed to get top requesters", {
				event: "stats.top_requesters.failed",
				limit: query.data.limit,
				error_message: error.message,
			});
			return c.json({ error: "Failed to fetch top requesters" }, 500);
		},
	);
	routeLogger.info("Loaded top requesters", {
		event: "stats.top_requesters.succeeded",
		limit: query.data.limit,
		status_code: result.status,
	});
	return result;
});

/**
 * GET /api/stats/raffle/leaderboard
 * Returns keyboard raffle leaderboard sorted by specified criteria
 */
stats.get("/raffle/leaderboard", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/stats/raffle/leaderboard",
		component: "route",
	});
	const query = LeaderboardQuerySchema.safeParse({
		sortBy: c.req.query("sortBy"),
		limit: c.req.query("limit"),
	});
	if (!query.success) {
		routeLogger.warn("Raffle leaderboard validation failed", {
			event: "stats.raffle_leaderboard.validation_failed",
		});
		return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
	}
	routeLogger.info("Loading raffle leaderboard", {
		event: "stats.raffle_leaderboard.started",
		sort_by: query.data.sortBy,
		limit: query.data.limit,
	});
	const result = await withEdgeCache(
		c,
		() => getStub("KEYBOARD_RAFFLE_DO").getLeaderboard(query.data),
		(error) => {
			if (isDOInfraError(error)) {
				logger.error("DO infrastructure error", { method: error.method, message: error.message });
				return c.json({ error: "Service temporarily unavailable" }, 503);
			}
			routeLogger.error("Failed to get raffle leaderboard", {
				event: "stats.raffle_leaderboard.failed",
				sort_by: query.data.sortBy,
				limit: query.data.limit,
				error_message: error.message,
			});
			return c.json({ error: "Failed to fetch leaderboard" }, 500);
		},
	);
	routeLogger.info("Loaded raffle leaderboard", {
		event: "stats.raffle_leaderboard.succeeded",
		sort_by: query.data.sortBy,
		limit: query.data.limit,
		status_code: result.status,
	});
	return result;
});

/**
 * GET /api/stats/raffle/user/:user
 * Returns raffle stats for a specific user
 */
stats.get("/raffle/user/:user", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/stats/raffle/user/:user",
		component: "route",
	});
	const userId = c.req.param("user");
	routeLogger.info("Loading raffle user stats", {
		event: "stats.raffle_user.started",
		user_id: userId,
	});

	const result = await withEdgeCache(
		c,
		() => getStub("KEYBOARD_RAFFLE_DO").getUserStats(userId),
		(error) => {
			if (isUserNotFound(error)) {
				routeLogger.warn("Raffle user stats not found", {
					event: "stats.raffle_user.not_found",
					user_id: userId,
				});
				return c.json({ error: "User not found" }, 404);
			}
			if (isDOInfraError(error)) {
				logger.error("DO infrastructure error", { method: error.method, message: error.message });
				return c.json({ error: "Service temporarily unavailable" }, 503);
			}
			routeLogger.error("Failed to get user raffle stats", {
				event: "stats.raffle_user.failed",
				user_id: userId,
				error_message: error.message,
			});
			return c.json({ error: "Failed to fetch user stats" }, 500);
		},
	);
	routeLogger.info("Loaded raffle user stats", {
		event: "stats.raffle_user.succeeded",
		user_id: userId,
		status_code: result.status,
	});
	return result;
});

export default stats;
