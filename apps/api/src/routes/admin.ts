/**
 * Admin routes for DLQ inspection and management
 *
 * All routes require bearer token authentication via ADMIN_SECRET env var.
 */

import { Hono } from "hono";
import { z } from "zod";

import { UserStatsNotFoundError } from "../durable-objects/keyboard-raffle-do";
import { constantTimeEquals } from "../lib/crypto";
import { getStub } from "../lib/durable-objects";
import { DLQItemNotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";

import type { Env } from "../index";

const admin = new Hono<{ Bindings: Env }>();

// =============================================================================
// Auth Middleware
// =============================================================================

/**
 * Bearer token authentication middleware.
 * Requires Authorization: Bearer <ADMIN_SECRET> header.
 */
admin.use("*", async (c, next) => {
	const adminSecret = c.env.ADMIN_SECRET;

	if (!adminSecret) {
		logger.error("Admin: ADMIN_SECRET not configured");
		return c.json({ error: "Admin API not configured" }, 503);
	}

	const authHeader = c.req.header("Authorization");

	if (!authHeader) {
		return c.json({ error: "Missing Authorization header" }, 401);
	}

	const [scheme, token] = authHeader.split(" ");

	if (scheme !== "Bearer" || !token) {
		return c.json({ error: "Invalid Authorization header format. Expected: Bearer <token>" }, 401);
	}

	if (!constantTimeEquals(token, adminSecret)) {
		return c.json({ error: "Invalid token" }, 403);
	}

	await next();
});

// =============================================================================
// DLQ Routes
// =============================================================================

/**
 * Query params schema for GET /admin/dlq
 */
const DLQListQuerySchema = z.object({
	limit: z.coerce.number().int().positive().max(100).default(50),
	offset: z.coerce.number().int().nonnegative().default(0),
});

/**
 * GET /admin/dlq
 * List failed events from the dead letter queue (paginated)
 */
admin.get("/dlq", async (c) => {
	const queryResult = DLQListQuerySchema.safeParse({
		limit: c.req.query("limit"),
		offset: c.req.query("offset"),
	});

	if (!queryResult.success) {
		return c.json({ error: "Invalid query parameters", details: queryResult.error.issues }, 400);
	}

	const { limit, offset } = queryResult.data;

	const stub = getStub("EVENT_BUS_DO");
	const result = await stub.getDLQ({ limit, offset });

	if (result.status === "error") {
		logger.error("Admin: Failed to get DLQ", { error: result.error.message });
		return c.json({ error: "Failed to fetch DLQ" }, 500);
	}

	return c.json(result.value);
});

/**
 * GET /admin/event-bus/pending
 * List pending (retry queued) events from EventBusDO
 */
admin.get("/event-bus/pending", async (c) => {
	const queryResult = DLQListQuerySchema.safeParse({
		limit: c.req.query("limit"),
		offset: c.req.query("offset"),
	});

	if (!queryResult.success) {
		return c.json({ error: "Invalid query parameters", details: queryResult.error.issues }, 400);
	}

	const { limit, offset } = queryResult.data;

	const stub = getStub("EVENT_BUS_DO");
	const result = await stub.getPending({ limit, offset });

	if (result.status === "error") {
		logger.error("Admin: Failed to get pending events", { error: result.error.message });
		return c.json({ error: "Failed to fetch pending events" }, 500);
	}

	return c.json(result.value);
});

/**
 * POST /admin/dlq/:id/replay
 * Retry delivery of a specific failed event
 */
admin.post("/dlq/:id/replay", async (c) => {
	const id = c.req.param("id");

	const stub = getStub("EVENT_BUS_DO");
	const result = await stub.replayDLQ(id);

	if (result.status === "error") {
		logger.error("Admin: Failed to replay DLQ item", { id, error: result.error.message });

		if (DLQItemNotFoundError.is(result.error)) {
			return c.json({ error: result.error.message }, 404);
		}

		return c.json({ error: "Failed to replay DLQ item" }, 500);
	}

	const replayResult = result.value;

	if (replayResult.success) {
		return c.json({
			message: "Event replayed successfully",
			eventId: replayResult.eventId,
		});
	}

	return c.json(
		{
			message: "Replay failed - event remains in DLQ",
			eventId: replayResult.eventId,
			error: replayResult.error,
		},
		200,
	);
});

/**
 * DELETE /admin/dlq/:id
 * Discard a failed event from the DLQ
 */
admin.delete("/dlq/:id", async (c) => {
	const id = c.req.param("id");

	const stub = getStub("EVENT_BUS_DO");
	const result = await stub.deleteDLQ(id);

	if (result.status === "error") {
		logger.error("Admin: Failed to delete DLQ item", { id, error: result.error.message });

		if (DLQItemNotFoundError.is(result.error)) {
			return c.json({ error: result.error.message }, 404);
		}

		return c.json({ error: "Failed to delete DLQ item" }, 500);
	}

	return c.json({ message: "Event deleted from DLQ", eventId: id });
});

// =============================================================================
// Achievement Routes
// =============================================================================

/**
 * POST /admin/achievements/reset-one-time
 * Reset one-time cumulative achievements (close_call, closest_ever)
 *
 * Query params:
 * - user: (optional) Only reset for this user display name
 */
admin.post("/achievements/reset-one-time", async (c) => {
	const userDisplayName = c.req.query("user");

	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.resetOneTimeAchievements(userDisplayName);

	if (result.status === "error") {
		logger.error("Admin: Failed to reset one-time achievements", {
			error: result.error.message,
			user: userDisplayName,
		});
		return c.json({ error: "Failed to reset achievements" }, 500);
	}

	// If specific user requested but nothing deleted, user doesn't exist or has no achievements
	if (userDisplayName && result.value.deleted === 0) {
		return c.json(
			{
				error: "User not found or no one-time achievements to reset",
				user: userDisplayName,
			},
			404,
		);
	}

	return c.json({
		message: "One-time achievements reset",
		deleted: result.value.deleted,
		achievementIds: result.value.achievementIds,
		user: userDisplayName ?? "all",
	});
});

/**
 * GET /admin/achievements/debug/counts
 * Table-level counts for achievements state
 */
admin.get("/achievements/debug/counts", async (c) => {
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getDebugTableCounts();

	if (result.status === "error") {
		logger.error("Admin: Failed to get achievements debug counts", {
			error: result.error.message,
		});
		return c.json({ error: "Failed to fetch achievements debug counts" }, 500);
	}

	return c.json(result.value);
});

/**
 * GET /admin/achievements/debug/user/:user
 * Per-user debug snapshot with normalization diagnostics
 */
admin.get("/achievements/debug/user/:user", async (c) => {
	const user = c.req.param("user");

	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getDebugUserSnapshot(user);

	if (result.status === "error") {
		logger.error("Admin: Failed to get user debug snapshot", {
			user,
			error: result.error.message,
		});
		return c.json({ error: "Failed to fetch user debug snapshot" }, 500);
	}

	return c.json(result.value);
});

/**
 * GET /admin/debug/stats/:user
 * Debug what !stats <user> would resolve to.
 */
admin.get("/debug/stats/:user", async (c) => {
	const rawUser = c.req.param("user");
	const targetUser = rawUser.trim().replace(/^@+/, "");

	if (targetUser.length === 0) {
		return c.json({ error: "User is required" }, 400);
	}

	const achievementsStub = getStub("ACHIEVEMENTS_DO");
	const raffleStub = getStub("KEYBOARD_RAFFLE_DO");
	const songQueueStub = getStub("SONG_QUEUE_DO");

	const [unlockedResult, definitionsResult, songResult, raffleResult] = await Promise.all([
		achievementsStub.getUnlockedAchievements(targetUser),
		achievementsStub.getDefinitions(),
		songQueueStub.getUserRequestCountByDisplayName(targetUser),
		raffleStub.getUserStatsByDisplayName(targetUser),
	]);

	let unlockedCount: number | null = null;
	let definitionsCount: number | null = null;
	let achievementStats = "?/?";

	if (unlockedResult.status === "ok" && definitionsResult.status === "ok") {
		unlockedCount = unlockedResult.value.length;
		definitionsCount = definitionsResult.value.length;
		achievementStats = `${unlockedCount}/${definitionsCount}`;
	}

	const songCount = songResult.status === "ok" ? songResult.value : 0;

	const formatRaffleStats = (entry: {
		totalRolls: number;
		totalWins: number;
		closestDistance: number | null;
	}) => {
		const base = `${entry.totalRolls} rolls`;
		const extras: string[] = [];
		if (entry.closestDistance !== null) {
			extras.push(`closest: ${entry.closestDistance}`);
		}
		if (entry.totalWins > 0) {
			extras.push(`${entry.totalWins} win${entry.totalWins > 1 ? "s" : ""}!`);
		}
		return extras.length > 0 ? `${base} (${extras.join(", ")})` : base;
	};

	const raffleNotFound =
		raffleResult.status === "error" && UserStatsNotFoundError.is(raffleResult.error);

	const raffleStats = raffleResult.status === "ok" ? formatRaffleStats(raffleResult.value) : "0 rolls";

	const noStatsForTargetUser =
		songResult.status === "ok" &&
		songResult.value === 0 &&
		unlockedCount === 0 &&
		definitionsCount !== null &&
		raffleNotFound;

	const chatMessage = noStatsForTargetUser
		? `No records found for @${targetUser} yet — no songs, achievements, or raffle stats.`
		: `@${targetUser} — Songs: ${songCount} | Achievements: ${achievementStats} | Raffles: ${raffleStats}`;

	return c.json({
		targetUser,
		noStatsForTargetUser,
		chatMessage,
		components: {
			song: {
				status: songResult.status,
				count: songCount,
				error: songResult.status === "error" ? songResult.error.message : null,
			},
			achievements: {
				status:
					unlockedResult.status === "ok" && definitionsResult.status === "ok" ? "ok" : "error",
				unlockedCount,
				definitionsCount,
				error:
					unlockedResult.status === "error"
						? unlockedResult.error.message
						: definitionsResult.status === "error"
							? definitionsResult.error.message
							: null,
			},
			raffle: {
				status: raffleResult.status,
				notFound: raffleNotFound,
				stats: raffleStats,
				error: raffleResult.status === "error" ? raffleResult.error.message : null,
			},
		},
	});
});

export default admin;
