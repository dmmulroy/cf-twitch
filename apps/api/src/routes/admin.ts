/**
 * Admin routes for DLQ inspection and management
 *
 * All routes require bearer token authentication via ADMIN_SECRET env var.
 */

import { Hono } from "hono";
import { z } from "zod";

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

export default admin;
