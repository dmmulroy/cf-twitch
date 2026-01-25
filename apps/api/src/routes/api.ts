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

/**
 * GET /api/debug/status
 * Aggregates state from all DOs for debugging
 */
api.get("/debug/status", async (c) => {
	const streamStub = getStub("STREAM_LIFECYCLE_DO");
	const poolStub = getStub("WORKFLOW_POOL_DO");
	const songQueueStub = getStub("SONG_QUEUE_DO");

	const [streamResult, poolResult, queueResult] = await Promise.all([
		streamStub.getStreamState(),
		poolStub.getPoolStatus(),
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
		workflowPool: {
			ok: poolResult.status === "ok",
			pools: poolResult.status === "ok" ? poolResult.value : null,
			error: poolResult.status === "error" ? poolResult.error.message : null,
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
