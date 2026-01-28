/**
 * API routes for public data access
 *
 * Provides endpoints for now playing, queue, and other stream data.
 */

import { Hono } from "hono";
import { z } from "zod";

import { getStub } from "../lib/durable-objects";
import { logger } from "../lib/logger";

import type { Env } from "../index";

const api = new Hono<{ Bindings: Env }>();

/**
 * Query params schema for /api/queue
 */
const QueueQuerySchema = z.object({
	limit: z.coerce.number().int().positive().max(100).default(10),
});

/**
 * GET /api/now-playing
 * Returns the currently playing track with requester attribution
 */
api.get("/now-playing", async (c) => {
	const stub = getStub("SONG_QUEUE_DO");
	const result = await stub.getCurrentlyPlaying();

	if (result.status === "error") {
		logger.error("Failed to get now playing", { error: result.error.message });
		return c.json({ error: "Failed to fetch now playing" }, 500);
	}

	return c.json(result.value);
});

/**
 * GET /api/queue?limit=10
 * Returns upcoming tracks with requester attribution
 */
api.get("/queue", async (c) => {
	const queryResult = QueueQuerySchema.safeParse({
		limit: c.req.query("limit"),
	});

	if (!queryResult.success) {
		return c.json({ error: "Invalid query parameters", details: queryResult.error.issues }, 400);
	}

	const { limit } = queryResult.data;

	const stub = getStub("SONG_QUEUE_DO");
	const result = await stub.getQueue(limit);

	if (result.status === "error") {
		logger.error("Failed to get queue", { error: result.error.message });
		return c.json({ error: "Failed to fetch queue" }, 500);
	}

	return c.json(result.value);
});

/**
 * GET /api/song-requests/history?limit=10
 * Returns fulfilled song request history
 */
api.get("/song-requests/history", async (c) => {
	const limit = Number(c.req.query("limit") ?? 10);
	const stub = getStub("SONG_QUEUE_DO");
	const result = await stub.getRequestHistory(limit);

	if (result.status === "error") {
		logger.error("Failed to get song request history", { error: result.error.message });
		return c.json({ error: "Failed to fetch song request history" }, 500);
	}

	return c.json(result.value);
});

/**
 * GET /api/debug/stream-state
 * Returns current stream state from StreamLifecycleDO
 */
api.get("/debug/stream-state", async (c) => {
	const stub = getStub("STREAM_LIFECYCLE_DO");
	const result = await stub.getStreamState();

	if (result.status === "error") {
		logger.error("Failed to get stream state", { error: result.error.message });
		return c.json({ error: "Failed to fetch stream state" }, 500);
	}

	return c.json(result.value);
});

/**
 * GET /api/debug/keyboard-raffle/leaderboard
 * Returns keyboard raffle leaderboard
 */
api.get("/debug/keyboard-raffle/leaderboard", async (c) => {
	const sortBy = (c.req.query("sortBy") ?? "closest") as "rolls" | "wins" | "closest";
	const limit = Number(c.req.query("limit") ?? 10);

	const stub = getStub("KEYBOARD_RAFFLE_DO");
	const result = await stub.getLeaderboard({ sortBy, limit });

	if (result.status === "error") {
		logger.error("Failed to get keyboard raffle leaderboard", { error: result.error.message });
		return c.json({ error: result.error.message }, 500);
	}

	return c.json(result.value);
});

// =============================================================================
// Achievement Routes
// =============================================================================

/**
 * GET /api/achievements/definitions
 * All achievement definitions
 */
api.get("/achievements/definitions", async (c) => {
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getDefinitions();

	if (result.status === "error") {
		logger.error("Failed to get achievement definitions", { error: result.error.message });
		return c.json({ error: "Failed to fetch achievement definitions" }, 500);
	}

	return c.json(result.value);
});

/**
 * GET /api/achievements/leaderboard?limit=10
 * Top users by achievement count
 *
 * Note: Must be defined before /:user to avoid route conflict
 */
api.get("/achievements/leaderboard", async (c) => {
	const limit = Number(c.req.query("limit") ?? 10);
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getLeaderboard({ limit });

	if (result.status === "error") {
		logger.error("Failed to get achievement leaderboard", { error: result.error.message });
		return c.json({ error: "Failed to fetch achievement leaderboard" }, 500);
	}

	return c.json(result.value);
});

/**
 * GET /api/achievements/:user
 * User's achievement progress
 */
api.get("/achievements/:user", async (c) => {
	const user = c.req.param("user");
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getUserAchievements(user);

	if (result.status === "error") {
		logger.error("Failed to get user achievements", { error: result.error.message, user });
		return c.json({ error: "Failed to fetch user achievements" }, 500);
	}

	return c.json(result.value);
});

/**
 * GET /api/achievements/:user/unlocked
 * User's unlocked achievements only
 */
api.get("/achievements/:user/unlocked", async (c) => {
	const user = c.req.param("user");
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getUnlockedAchievements(user);

	if (result.status === "error") {
		logger.error("Failed to get unlocked achievements", { error: result.error.message, user });
		return c.json({ error: "Failed to fetch unlocked achievements" }, 500);
	}

	return c.json(result.value);
});

// =============================================================================
// Debug Routes
// =============================================================================

/**
 * GET /api/debug/status
 * Aggregates state from all DOs for debugging
 */
api.get("/debug/status", async (c) => {
	const streamStub = getStub("STREAM_LIFECYCLE_DO");
	const songQueueStub = getStub("SONG_QUEUE_DO");

	const [streamResult, queueResult] = await Promise.all([
		streamStub.getStreamState(),
		songQueueStub.getQueue(5),
	]);

	const status = {
		timestamp: new Date().toISOString(),
		stream: {
			ok: streamResult.status === "ok",
			isLive: streamResult.status === "ok" ? streamResult.value.isLive : null,
			startedAt: streamResult.status === "ok" ? streamResult.value.startedAt : null,
			peakViewerCount: streamResult.status === "ok" ? streamResult.value.peakViewerCount : null,
			error: streamResult.status === "error" ? streamResult.error.message : null,
		},
		songQueue: {
			ok: queueResult.status === "ok",
			queueLength: queueResult.status === "ok" ? queueResult.value.totalCount : null,
			error: queueResult.status === "error" ? queueResult.error.message : null,
		},
	};

	return c.json(status);
});

export default api;
