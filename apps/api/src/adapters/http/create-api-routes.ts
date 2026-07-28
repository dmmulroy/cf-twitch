/**
 * API routes for public data access
 *
 * Provides endpoints for now playing, queue, and other stream data.
 */

import { Hono } from "hono";
import { z } from "zod";

import { SongQueueUnavailableError } from "../../capabilities/song-queue";
import { constantTimeEquals } from "../../lib/crypto";
import { readHttpQueryParameters } from "../../lib/http-query-parameters";
import { type AppRouteEnv, getRequestLogger } from "../../lib/request-context";

import type { AchievementReader, StreamLifecycle } from "../../capabilities/http-state-readers";
import type { RaffleStatistics } from "../../capabilities/raffle-statistics";
import type { SongQueue } from "../../capabilities/song-queue";
import type { RedactedValue } from "../../lib/redacted";
import type { TwitchService } from "../../services/twitch-service";

/** Exact dependencies required by public and debug API routes. */
export type ApiRouteDependencies = Readonly<{
	administratorSecret: RedactedValue<string>;
	songQueue: SongQueue;
	streamLifecycle: StreamLifecycle;
	raffles: RaffleStatistics;
	achievements: AchievementReader;
	twitchStreams: Pick<TwitchService, "getStreamInfo">;
	broadcasterDisplayName: string;
}>;

const BoundedLimitSchema = z.coerce.number().int().min(1).max(100).default(10);
const QueueQuerySchema = z.object({ limit: BoundedLimitSchema }).strict();
const RaffleLeaderboardQuerySchema = z
	.object({
		sortBy: z.enum(["rolls", "wins", "closest"]).default("closest"),
		limit: BoundedLimitSchema,
	})
	.strict();
const AchievementLeaderboardQuerySchema = z.object({ limit: BoundedLimitSchema }).strict();
const SongRequestHistoryQuerySchema = z.object({ limit: BoundedLimitSchema }).strict();
const TwitchStreamStartedAtSchema = z.iso.datetime({ offset: true });

/** Creates public and debug API routes without Worker binding lookup. */
export function createApiRoutes(dependencies: ApiRouteDependencies): Hono<AppRouteEnv<object>> {
	const api = new Hono<AppRouteEnv<object>>();

	/**
	 * Protect debug routes with administrator bearer authentication.
	 */
	api.use("/debug/*", async (c, next) => {
		const routeLogger = getRequestLogger(c).child({ route: c.req.path, component: "route" });
		const adminSecret = dependencies.administratorSecret.unsafeUnwrapForFinalIo();

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
			return c.json(
				{ error: "Invalid Authorization header format. Expected: Bearer <token>" },
				401,
			);
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
	 * GET /api/queue?limit=10
	 * Returns upcoming tracks with requester attribution
	 */
	api.get("/queue", async (c) => {
		const routeLogger = getRequestLogger(c).child({ route: "/api/queue", component: "route" });
		const queryResult = QueueQuerySchema.safeParse(readHttpQueryParameters(c.req.url));

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

		const result = await dependencies.songQueue.getSpotifyQueue(limit);

		if (result.status === "error") {
			routeLogger.error("Failed to get queue", {
				event: "api.queue.failed",
				limit,
				...result.error,
			});
			return SongQueueUnavailableError.is(result.error)
				? c.json({ error: "Service temporarily unavailable" }, 503)
				: c.json({ error: "Failed to fetch queue" }, 500);
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
		const queryResult = SongRequestHistoryQuerySchema.safeParse(readHttpQueryParameters(c.req.url));
		if (!queryResult.success) {
			return c.json({ error: "Invalid query parameters", details: queryResult.error.issues }, 400);
		}
		const { limit } = queryResult.data;
		routeLogger.info("Loading song request history", {
			event: "api.song_request_history.started",
			limit,
		});
		const result = await dependencies.songQueue.getRequestHistory(limit);

		if (result.status === "error") {
			routeLogger.error("Failed to get song request history", {
				event: "api.song_request_history.failed",
				limit,
				...result.error,
			});
			return SongQueueUnavailableError.is(result.error)
				? c.json({ error: "Service temporarily unavailable" }, 503)
				: c.json({ error: "Failed to fetch song request history" }, 500);
		}

		routeLogger.info("Loaded song request history", {
			event: "api.song_request_history.succeeded",
			limit,
			returned_count: result.value.requests.length,
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
		const result = await dependencies.streamLifecycle.getStreamState();

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
		const queryResult = RaffleLeaderboardQuerySchema.safeParse(readHttpQueryParameters(c.req.url));
		if (!queryResult.success) {
			routeLogger.warn("Raffle leaderboard query validation failed", {
				event: "api.debug.raffle_leaderboard.validation_failed",
			});
			return c.json({ error: "Invalid query parameters", details: queryResult.error.issues }, 400);
		}
		const { sortBy, limit } = queryResult.data;
		routeLogger.info("Loading raffle leaderboard", {
			event: "api.debug.raffle_leaderboard.started",
			sort_by: sortBy,
			limit,
		});

		const result = await dependencies.raffles.getLeaderboard({ sortBy, limit });

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
		const result = await dependencies.achievements.getDefinitions();

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
		const queryResult = AchievementLeaderboardQuerySchema.safeParse(
			readHttpQueryParameters(c.req.url),
		);
		if (!queryResult.success) {
			routeLogger.warn("Achievement leaderboard query validation failed", {
				event: "api.achievements.leaderboard.validation_failed",
			});
			return c.json({ error: "Invalid query parameters", details: queryResult.error.issues }, 400);
		}
		const { limit } = queryResult.data;
		routeLogger.info("Loading achievement leaderboard", {
			event: "api.achievements.leaderboard.started",
			limit,
		});
		const result = await dependencies.achievements.getLeaderboard({ limit });

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
		const result = await dependencies.achievements.getViewerAchievements(user);

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
		const result = await dependencies.achievements.getViewerUnlockedAchievements(user);

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
			broadcaster_name: dependencies.broadcasterDisplayName,
		});

		const [streamStateResult, twitchStreamResult] = await Promise.all([
			dependencies.streamLifecycle.getStreamState(),
			dependencies.twitchStreams.getStreamInfo(dependencies.broadcasterDisplayName),
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

		if (twitchStream !== null) {
			const startedAtResult = TwitchStreamStartedAtSchema.safeParse(twitchStream.startedAt);
			if (!startedAtResult.success) {
				routeLogger.error("Twitch returned an invalid stream start timestamp", {
					event: "api.reconcile_stream_state.twitch_timestamp_invalid",
				});
				return c.json({ error: "Invalid Twitch stream status response" }, 502);
			}
			const onlineResult = await dependencies.streamLifecycle.markStreamOnline(
				startedAtResult.data,
			);
			if (onlineResult.status === "error") {
				routeLogger.error("Failed to reconcile online Stream Lifecycle effects", {
					event: "api.reconcile_stream_state.set_online.failed",
					...onlineResult.error,
				});
				return c.json({ error: "Failed to reconcile online stream state" }, 500);
			}
			if (!before.isLive) action = "set_online";
		} else {
			const offlineResult = await dependencies.streamLifecycle.markStreamOffline();
			if (offlineResult.status === "error") {
				routeLogger.error("Failed to reconcile offline Stream Lifecycle effects", {
					event: "api.reconcile_stream_state.set_offline.failed",
					...offlineResult.error,
				});
				return c.json({ error: "Failed to reconcile offline stream state" }, 500);
			}
			if (before.isLive) action = "set_offline";
		}

		routeLogger.info("Selected reconciliation action", {
			event: "api.reconcile_stream_state.action_selected",
			action,
			before_is_live: before.isLive,
			twitch_is_live: twitchIsLive,
		});

		let queueWarmup: "not_needed" | "ok" | "error" = "not_needed";
		if (action === "set_online") {
			const queueWarmResult = await dependencies.songQueue.getNowPlaying();
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

		const afterResult = await dependencies.streamLifecycle.getStreamState();
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
		const routeLogger = getRequestLogger(c).child({
			route: "/api/debug/status",
			component: "route",
		});
		routeLogger.info("Loading debug status", {
			event: "api.debug.status.started",
		});
		const [streamResult, queueResult, twitchResult] = await Promise.all([
			dependencies.streamLifecycle.getStreamState(),
			dependencies.songQueue.getSpotifyQueue(5),
			dependencies.twitchStreams.getStreamInfo(dependencies.broadcasterDisplayName),
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

	return api;
}
