/**
 * API routes for public data access
 *
 * Provides endpoints for now playing, queue, and other stream data.
 */

import { Hono } from "hono";
import { z } from "zod";

import { constantTimeEquals } from "../lib/crypto";
import { getStub } from "../lib/durable-objects";
import { type AppRouteEnv, getRequestLogger } from "../lib/request-context";
import { TwitchService } from "../services/twitch-service";

import type { Env } from "../index";

const api = new Hono<AppRouteEnv<Env>>();

/**
 * Query params schema for /api/queue
 */
const QueueQuerySchema = z.object({
	limit: z.coerce.number().int().positive().max(100).default(10),
});

/**
 * Protect debug routes with ADMIN_SECRET bearer auth.
 */
api.use("/debug/*", async (c, next) => {
	const routeLogger = getRequestLogger(c).child({ route: c.req.path, component: "route" });
	const adminSecret = c.env.ADMIN_SECRET;

	if (!adminSecret) {
		routeLogger.error("Debug API auth misconfigured", {
			event: "api.debug_auth.misconfigured",
			path: c.req.path,
		});
		return c.json({ error: "Debug API not configured" }, 503);
	}

	const authHeader = c.req.header("Authorization");
	if (!authHeader) {
		routeLogger.warn("Debug API auth missing header", {
			event: "api.debug_auth.missing_header",
			path: c.req.path,
		});
		return c.json({ error: "Missing Authorization header" }, 401);
	}

	const [scheme, token] = authHeader.split(" ");
	if (scheme !== "Bearer" || !token) {
		routeLogger.warn("Debug API auth invalid format", {
			event: "api.debug_auth.invalid_format",
			path: c.req.path,
		});
		return c.json({ error: "Invalid Authorization header format. Expected: Bearer <token>" }, 401);
	}

	if (!constantTimeEquals(token, adminSecret)) {
		routeLogger.warn("Debug API auth denied", {
			event: "api.debug_auth.denied",
			path: c.req.path,
		});
		return c.json({ error: "Invalid token" }, 403);
	}

	routeLogger.info("Debug API auth authorized", {
		event: "api.debug_auth.authorized",
		path: c.req.path,
	});
	await next();
});

/**
 * GET /api/now-playing
 * Returns the currently playing track with requester attribution
 */
api.get("/now-playing", async (c) => {
	const routeLogger = getRequestLogger(c).child({ route: "/api/now-playing", component: "route" });
	routeLogger.info("Loading now playing", {
		event: "api.now_playing.started",
	});
	const stub = getStub("SONG_QUEUE_DO");
	const result = await stub.getCurrentlyPlaying();

	if (result.status === "error") {
		routeLogger.error("Failed to get now playing", {
			event: "api.now_playing.failed",
			...result.error,
		});
		return c.json({ error: "Failed to fetch now playing" }, 500);
	}

	routeLogger.info("Loaded now playing", {
		event: "api.now_playing.succeeded",
		has_track: result.value.track !== null,
		track_id: result.value.track?.id ?? undefined,
		requester_user_id: result.value.track?.requesterUserId ?? undefined,
		requester_display_name: result.value.track?.requesterDisplayName ?? undefined,
	});
	return c.json(result.value);
});

/**
 * GET /api/queue?limit=10
 * Returns upcoming tracks with requester attribution
 */
api.get("/queue", async (c) => {
	const routeLogger = getRequestLogger(c).child({ route: "/api/queue", component: "route" });
	const queryResult = QueueQuerySchema.safeParse({
		limit: c.req.query("limit"),
	});

	if (!queryResult.success) {
		routeLogger.warn("Queue query validation failed", {
			event: "api.queue.validation_failed",
		});
		return c.json({ error: "Invalid query parameters", details: queryResult.error.issues }, 400);
	}

	const { limit } = queryResult.data;
	routeLogger.info("Loading queue", {
		event: "api.queue.started",
		limit,
	});

	const stub = getStub("SONG_QUEUE_DO");
	const result = await stub.getSongQueue(limit);

	if (result.status === "error") {
		routeLogger.error("Failed to get queue", {
			event: "api.queue.failed",
			limit,
			...result.error,
		});
		return c.json({ error: "Failed to fetch queue" }, 500);
	}

	routeLogger.info("Loaded queue", {
		event: "api.queue.succeeded",
		limit,
		returned_count: result.value.tracks.length,
		total_count: result.value.totalCount,
	});
	return c.json(result.value);
});

/**
 * GET /api/song-requests/history?limit=10
 * Returns fulfilled song request history
 */
api.get("/song-requests/history", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/song-requests/history",
		component: "route",
	});
	const limit = Number(c.req.query("limit") ?? 10);
	routeLogger.info("Loading song request history", {
		event: "api.song_request_history.started",
		limit,
	});
	const stub = getStub("SONG_QUEUE_DO");
	const result = await stub.getRequestHistory(limit);

	if (result.status === "error") {
		routeLogger.error("Failed to get song request history", {
			event: "api.song_request_history.failed",
			limit,
			...result.error,
		});
		return c.json({ error: "Failed to fetch song request history" }, 500);
	}

	routeLogger.info("Loaded song request history", {
		event: "api.song_request_history.succeeded",
		limit,
		returned_count: result.value.history.length,
		total_count: result.value.totalCount,
	});
	return c.json(result.value);
});

/**
 * GET /api/debug/stream-state
 * Returns current stream state from StreamLifecycleDO
 */
api.get("/debug/stream-state", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/debug/stream-state",
		component: "route",
	});
	routeLogger.info("Loading debug stream state", {
		event: "api.debug.stream_state.started",
	});
	const stub = getStub("STREAM_LIFECYCLE_DO");
	const result = await stub.getStreamState();

	if (result.status === "error") {
		routeLogger.error("Failed to get stream state", {
			event: "api.debug.stream_state.failed",
			...result.error,
		});
		return c.json({ error: "Failed to fetch stream state" }, 500);
	}

	routeLogger.info("Loaded debug stream state", {
		event: "api.debug.stream_state.succeeded",
		is_live: result.value.isLive,
		started_at: result.value.startedAt,
		ended_at: result.value.endedAt,
		peak_viewer_count: result.value.peakViewerCount,
	});
	return c.json(result.value);
});

/**
 * GET /api/debug/keyboard-raffle/leaderboard
 * Returns keyboard raffle leaderboard
 */
api.get("/debug/keyboard-raffle/leaderboard", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/debug/keyboard-raffle/leaderboard",
		component: "route",
	});
	const sortBy = (c.req.query("sortBy") ?? "closest") as "rolls" | "wins" | "closest";
	const limit = Number(c.req.query("limit") ?? 10);
	routeLogger.info("Loading raffle leaderboard", {
		event: "api.debug.raffle_leaderboard.started",
		sort_by: sortBy,
		limit,
	});

	const stub = getStub("KEYBOARD_RAFFLE_DO");
	const result = await stub.getLeaderboard({ sortBy, limit });

	if (result.status === "error") {
		routeLogger.error("Failed to get keyboard raffle leaderboard", {
			event: "api.debug.raffle_leaderboard.failed",
			sort_by: sortBy,
			limit,
			...result.error,
		});
		return c.json({ error: result.error.message }, 500);
	}

	routeLogger.info("Loaded raffle leaderboard", {
		event: "api.debug.raffle_leaderboard.succeeded",
		sort_by: sortBy,
		limit,
		returned_count: result.value.length,
	});
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
	const routeLogger = getRequestLogger(c).child({
		route: "/api/achievements/definitions",
		component: "route",
	});
	routeLogger.info("Loading achievement definitions", {
		event: "api.achievements.definitions.started",
	});
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getDefinitions();

	if (result.status === "error") {
		routeLogger.error("Failed to get achievement definitions", {
			event: "api.achievements.definitions.failed",
			...result.error,
		});
		return c.json({ error: "Failed to fetch achievement definitions" }, 500);
	}

	routeLogger.info("Loaded achievement definitions", {
		event: "api.achievements.definitions.succeeded",
		count: result.value.length,
	});
	return c.json(result.value);
});

/**
 * GET /api/achievements/leaderboard?limit=10
 * Top users by achievement count
 *
 * Note: Must be defined before /:user to avoid route conflict
 */
api.get("/achievements/leaderboard", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/achievements/leaderboard",
		component: "route",
	});
	const limit = Number(c.req.query("limit") ?? 10);
	routeLogger.info("Loading achievement leaderboard", {
		event: "api.achievements.leaderboard.started",
		limit,
	});
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getLeaderboard({ limit });

	if (result.status === "error") {
		routeLogger.error("Failed to get achievement leaderboard", {
			event: "api.achievements.leaderboard.failed",
			limit,
			...result.error,
		});
		return c.json({ error: "Failed to fetch achievement leaderboard" }, 500);
	}

	routeLogger.info("Loaded achievement leaderboard", {
		event: "api.achievements.leaderboard.succeeded",
		limit,
		returned_count: result.value.length,
	});
	return c.json(result.value);
});

/**
 * GET /api/achievements/:user
 * User's achievement progress
 */
api.get("/achievements/:user", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/achievements/:user",
		component: "route",
	});
	const user = c.req.param("user");
	routeLogger.info("Loading user achievements", {
		event: "api.achievements.user.started",
		target_user: user,
	});
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getUserAchievements(user);

	if (result.status === "error") {
		routeLogger.error("Failed to get user achievements", {
			event: "api.achievements.user.failed",
			target_user: user,
			...result.error,
		});
		return c.json({ error: "Failed to fetch user achievements" }, 500);
	}

	routeLogger.info("Loaded user achievements", {
		event: "api.achievements.user.succeeded",
		target_user: user,
		returned_count: result.value.length,
	});
	return c.json(result.value);
});

/**
 * GET /api/achievements/:user/unlocked
 * User's unlocked achievements only
 */
api.get("/achievements/:user/unlocked", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/achievements/:user/unlocked",
		component: "route",
	});
	const user = c.req.param("user");
	routeLogger.info("Loading user unlocked achievements", {
		event: "api.achievements.user_unlocked.started",
		target_user: user,
	});
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getUnlockedAchievements(user);

	if (result.status === "error") {
		routeLogger.error("Failed to get unlocked achievements", {
			event: "api.achievements.user_unlocked.failed",
			target_user: user,
			...result.error,
		});
		return c.json({ error: "Failed to fetch unlocked achievements" }, 500);
	}

	routeLogger.info("Loaded user unlocked achievements", {
		event: "api.achievements.user_unlocked.succeeded",
		target_user: user,
		returned_count: result.value.length,
	});
	return c.json(result.value);
});

// =============================================================================
// Debug Routes
// =============================================================================

/**
 * POST /api/debug/reconcile-stream-state
 * Reconciles StreamLifecycleDO state with Twitch's current stream status.
 * Useful when EventSub delivery is delayed or out-of-order.
 */
api.post("/debug/reconcile-stream-state", async (c) => {
	const routeLogger = getRequestLogger(c).child({
		route: "/api/debug/reconcile-stream-state",
		component: "route",
	});
	routeLogger.info("Reconciling stream state", {
		event: "api.reconcile_stream_state.started",
		broadcaster_name: c.env.TWITCH_BROADCASTER_NAME,
	});
	const streamStub = getStub("STREAM_LIFECYCLE_DO");
	const songQueueStub = getStub("SONG_QUEUE_DO");
	const twitchService = new TwitchService(c.env);

	const [streamStateResult, twitchStreamResult] = await Promise.all([
		streamStub.getStreamState(),
		twitchService.getStreamInfo(c.env.TWITCH_BROADCASTER_NAME),
	]);

	if (streamStateResult.status === "error") {
		routeLogger.error("Failed to reconcile stream state: stream state unavailable", {
			event: "api.reconcile_stream_state.current_state_loaded",
			outcome: "error",
			...streamStateResult.error,
		});
		return c.json({ error: "Failed to fetch current stream state" }, 500);
	}

	const before = streamStateResult.value;
	routeLogger.info("Loaded current stream state", {
		event: "api.reconcile_stream_state.current_state_loaded",
		before_is_live: before.isLive,
		before_started_at: before.startedAt,
	});

	if (twitchStreamResult.status === "error") {
		routeLogger.error("Failed to reconcile stream state: Twitch lookup failed", {
			event: "api.reconcile_stream_state.twitch_loaded",
			outcome: "error",
			...twitchStreamResult.error,
		});
		return c.json({ error: "Failed to fetch Twitch stream status" }, 500);
	}

	const twitchStream = twitchStreamResult.value;
	const twitchIsLive = twitchStream !== null;
	routeLogger.info("Loaded Twitch stream state", {
		event: "api.reconcile_stream_state.twitch_loaded",
		twitch_is_live: twitchIsLive,
		twitch_started_at: twitchStream?.startedAt ?? undefined,
		viewer_count: twitchStream?.viewerCount ?? undefined,
	});

	let action: "noop" | "set_online" | "set_offline" = "noop";

	if (twitchIsLive && !before.isLive) {
		const onlineResult = await streamStub.onStreamOnline();
		if (onlineResult.status === "error") {
			routeLogger.error("Failed to set stream online during reconciliation", {
				event: "api.reconcile_stream_state.set_online.failed",
				...onlineResult.error,
			});
			return c.json({ error: "Failed to update stream state to online" }, 500);
		}
		action = "set_online";
	} else if (!twitchIsLive && before.isLive) {
		const offlineResult = await streamStub.onStreamOffline();
		if (offlineResult.status === "error") {
			routeLogger.error("Failed to set stream offline during reconciliation", {
				event: "api.reconcile_stream_state.set_offline.failed",
				...offlineResult.error,
			});
			return c.json({ error: "Failed to update stream state to offline" }, 500);
		}
		action = "set_offline";
	}

	routeLogger.info("Selected reconciliation action", {
		event: "api.reconcile_stream_state.action_selected",
		action,
		before_is_live: before.isLive,
		twitch_is_live: twitchIsLive,
	});

	let queueWarmup: "not_needed" | "ok" | "error" = "not_needed";
	if (action === "set_online") {
		const queueWarmResult = await songQueueStub.getCurrentlyPlaying();
		if (queueWarmResult.status === "error") {
			queueWarmup = "error";
			routeLogger.warn("Queue warmup failed after stream reconciliation", {
				event: "api.reconcile_stream_state.queue_warmup.failed",
				...queueWarmResult.error,
			});
		} else {
			queueWarmup = "ok";
			routeLogger.info("Queue warmup succeeded after stream reconciliation", {
				event: "api.reconcile_stream_state.queue_warmup.succeeded",
			});
		}
	}

	const afterResult = await streamStub.getStreamState();
	if (afterResult.status === "error") {
		routeLogger.error("Reconciled stream state but failed to read final state", {
			event: "api.reconcile_stream_state.completed",
			outcome: "final_state_read_failed",
			...afterResult.error,
		});
		return c.json(
			{
				error: "Reconciliation completed but failed to read final state",
				action,
				before,
			},
			500,
		);
	}

	routeLogger.info("Reconciled stream state", {
		event: "api.reconcile_stream_state.completed",
		action,
		queue_warmup: queueWarmup,
		after_is_live: afterResult.value.isLive,
	});
	return c.json({
		action,
		queueWarmup,
		before,
		after: afterResult.value,
		twitch: {
			isLive: twitchIsLive,
			startedAt: twitchStream ? twitchStream.startedAt : null,
			viewerCount: twitchStream ? twitchStream.viewerCount : null,
			title: twitchStream ? twitchStream.title : null,
			gameName: twitchStream ? twitchStream.gameName : null,
		},
	});
});

/**
 * GET /api/debug/status
 * Aggregates state from all DOs for debugging
 */
api.get("/debug/status", async (c) => {
	const routeLogger = getRequestLogger(c).child({ route: "/api/debug/status", component: "route" });
	routeLogger.info("Loading debug status", {
		event: "api.debug.status.started",
	});
	const streamStub = getStub("STREAM_LIFECYCLE_DO");
	const songQueueStub = getStub("SONG_QUEUE_DO");
	const twitchService = new TwitchService(c.env);

	const [streamResult, queueResult, twitchResult] = await Promise.all([
		streamStub.getStreamState(),
		songQueueStub.getSongQueue(5),
		twitchService.getStreamInfo(c.env.TWITCH_BROADCASTER_NAME),
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
		twitch: {
			ok: twitchResult.status === "ok",
			isLive: twitchResult.status === "ok" ? twitchResult.value !== null : null,
			startedAt:
				twitchResult.status === "ok"
					? twitchResult.value
						? twitchResult.value.startedAt
						: null
					: null,
			viewerCount:
				twitchResult.status === "ok"
					? twitchResult.value
						? twitchResult.value.viewerCount
						: null
					: null,
			error: twitchResult.status === "error" ? twitchResult.error.message : null,
		},
		songQueue: {
			ok: queueResult.status === "ok",
			queueLength: queueResult.status === "ok" ? queueResult.value.totalCount : null,
			error: queueResult.status === "error" ? queueResult.error.message : null,
		},
	};

	const partialFailureCount = [streamResult, queueResult, twitchResult].filter(
		(result) => result.status === "error",
	).length;
	routeLogger.info("Loaded debug status", {
		event: "api.debug.status.completed",
		stream_ok: status.stream.ok,
		twitch_ok: status.twitch.ok,
		song_queue_ok: status.songQueue.ok,
		partial_failure_count: partialFailureCount,
	});
	return c.json(status);
});

export default api;
