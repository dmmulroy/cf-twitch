/**
 * StreamLifecycleDO - Manages stream lifecycle events and viewer tracking
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { and, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/stream-lifecycle-do/migrations";
import { writeStreamSessionMetric, writeViewerCountMetric } from "../lib/analytics";
import { getStub } from "../lib/durable-objects";
import { DurableObjectError } from "../lib/errors";
import { logger } from "../lib/logger";
import { TwitchService } from "../services/twitch-service";
import * as schema from "./stream-lifecycle-do.schema";
import {
	type StreamState,
	streamState,
	type ViewerSnapshot,
	viewerSnapshots,
} from "./stream-lifecycle-do.schema";

import type { Env } from "../index";

const RecordViewerCountBodySchema = z.object({
	count: z.number(),
});

export class StreamLifecycleDO extends DurableObject<Env> {
	private db: ReturnType<typeof drizzle<typeof schema>>;
	private isLive = false;
	private sessionId: string | null = null;
	private sessionStartMs: number | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });

		void this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);

			// Load current stream state into cache
			const state = await this.db.query.streamState.findFirst();
			if (state) {
				this.isLive = state.isLive;
			} else {
				// Initialize stream state singleton
				await this.db.insert(streamState).values({
					id: 1,
					isLive: false,
					startedAt: null,
					endedAt: null,
					peakViewerCount: 0,
				});
			}
		});
	}

	/**
	 * Lifecycle handler: called when stream goes online
	 */
	async onStreamOnline(): Promise<void> {
		const now = new Date().toISOString();

		// Generate session ID for analytics correlation
		this.sessionId = crypto.randomUUID();
		this.sessionStartMs = Date.now();

		// Update stream state
		await this.db
			.update(streamState)
			.set({
				isLive: true,
				startedAt: now,
				endedAt: null,
				peakViewerCount: 0,
			})
			.where(eq(streamState.id, 1));

		this.isLive = true;

		logger.info("Stream online", { timestamp: now, sessionId: this.sessionId });

		// Notify token DOs of stream online (for proactive token refresh)
		await this.notifyTokenDOsOnline();

		// Start alarm for viewer count polling (60s interval)
		await this.ctx.storage.setAlarm(Date.now() + 60_000);

		// Broadcast to WebSocket clients
		this.broadcastToWebSockets({
			type: "stream_online",
			timestamp: now,
		});
	}

	/**
	 * Lifecycle handler: called when stream goes offline
	 */
	async onStreamOffline(): Promise<void> {
		const now = new Date().toISOString();

		// Get peak viewer count before updating state
		const currentState = await this.db.query.streamState.findFirst();
		const peakViewers = currentState?.peakViewerCount ?? 0;

		// Update stream state
		await this.db
			.update(streamState)
			.set({
				isLive: false,
				endedAt: now,
			})
			.where(eq(streamState.id, 1));

		this.isLive = false;

		// Write stream session metric
		if (this.sessionId && this.sessionStartMs) {
			const durationMs = Date.now() - this.sessionStartMs;
			writeStreamSessionMetric(this.env.ANALYTICS, {
				sessionId: this.sessionId,
				durationMs,
				peakViewers,
			});
			logger.info("Stream offline", {
				timestamp: now,
				sessionId: this.sessionId,
				durationMs,
				peakViewers,
			});
		} else {
			logger.info("Stream offline", { timestamp: now });
		}

		// Clear session state
		this.sessionId = null;
		this.sessionStartMs = null;

		// Notify token DOs of stream offline (to cancel proactive refresh alarms)
		await this.notifyTokenDOsOffline();

		// Cancel alarm
		await this.ctx.storage.deleteAlarm();

		// Broadcast to WebSocket clients
		this.broadcastToWebSockets({
			type: "stream_offline",
			timestamp: now,
		});

		// Close all WebSocket connections gracefully
		const webSockets = this.ctx.getWebSockets() as WebSocket[];
		for (const ws of webSockets) {
			ws.close(1000, "Stream offline");
		}
	}

	/**
	 * Record a viewer count snapshot
	 */
	async recordViewerCount(count: number): Promise<void> {
		const timestamp = new Date().toISOString();

		// Insert snapshot
		await this.db.insert(viewerSnapshots).values({
			timestamp,
			viewerCount: count,
		});

		// Update peak if this is a new peak
		const currentState = await this.db.query.streamState.findFirst();
		if (currentState && count > currentState.peakViewerCount) {
			await this.db
				.update(streamState)
				.set({ peakViewerCount: count })
				.where(eq(streamState.id, 1));
		}

		// Write Analytics Engine metric
		writeViewerCountMetric(this.env.ANALYTICS, { count });

		logger.debug("Recorded viewer count", { count, timestamp });
	}

	/**
	 * Get current stream state
	 */
	async getStreamState(): Promise<Result<StreamState, DurableObjectError>> {
		const result = await Result.tryPromise({
			try: () => this.db.query.streamState.findFirst(),
			catch: (cause) =>
				new DurableObjectError({ method: "getStreamState", message: "DB error", cause }),
		});

		if (result.status === "error") {
			return Result.err(result.error);
		}

		if (!result.value) {
			return Result.err(
				new DurableObjectError({
					method: "getStreamState",
					message: "Stream state not initialized",
				}),
			);
		}

		return Result.ok(result.value);
	}

	/**
	 * Get viewer history with optional date filters
	 */
	async getViewerHistory(since?: string, until?: string): Promise<{ snapshots: ViewerSnapshot[] }> {
		const conditions = [];

		if (since) {
			conditions.push(gte(viewerSnapshots.timestamp, since));
		}
		if (until) {
			conditions.push(lte(viewerSnapshots.timestamp, until));
		}

		const snapshots = await this.db
			.select()
			.from(viewerSnapshots)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(viewerSnapshots.timestamp);

		return { snapshots };
	}

	/**
	 * Quick check if stream is live
	 */
	async getIsLive(): Promise<boolean> {
		return this.isLive;
	}

	/**
	 * Health check endpoint
	 */
	async ping(): Promise<{ ok: boolean }> {
		return { ok: true };
	}

	/**
	 * Alarm handler: polls viewer count when stream is live
	 */
	async alarm(): Promise<void> {
		if (!this.isLive) {
			return;
		}

		// Poll viewer count using TwitchService (returns null on error)
		const viewerCount = await this.pollViewerCount();
		if (viewerCount !== null) {
			const recordResult = await Result.tryPromise({
				try: () => this.recordViewerCount(viewerCount),
				catch: (cause) =>
					new DurableObjectError({ method: "alarm.recordViewerCount", message: String(cause) }),
			});
			if (recordResult.status === "error") {
				logger.error("Failed to record viewer count", { error: recordResult.error.message });
			}
		}

		// Reschedule alarm if still live
		if (this.isLive) {
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
		}
	}

	/**
	 * Fetch handler for RPC-style method calls
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		try {
			switch (url.pathname) {
				case "/stream-online": {
					await this.onStreamOnline();
					return Response.json({ success: true });
				}

				case "/stream-offline": {
					await this.onStreamOffline();
					return Response.json({ success: true });
				}

				case "/record-viewer-count": {
					if (request.method !== "POST") {
						return Response.json({ error: "Method not allowed" }, { status: 405 });
					}
					const body = RecordViewerCountBodySchema.safeParse(await request.json());
					if (!body.success) {
						return Response.json({ error: body.error.message }, { status: 400 });
					}
					await this.recordViewerCount(body.data.count);
					return Response.json({ success: true });
				}

				case "/state": {
					const stateResult = await this.getStreamState();
					if (stateResult.status === "error") {
						return Response.json({ error: stateResult.error.message }, { status: 500 });
					}
					return Response.json(stateResult.value);
				}

				case "/history": {
					const since = url.searchParams.get("since") ?? undefined;
					const until = url.searchParams.get("until") ?? undefined;

					const history = await this.getViewerHistory(since, until);
					return Response.json(history);
				}

				case "/is-live": {
					const isLive = await this.getIsLive();
					return Response.json({ is_live: isLive });
				}

				case "/ping": {
					const result = await this.ping();
					return Response.json(result);
				}

				default:
					return Response.json({ error: "Not found" }, { status: 404 });
			}
		} catch (error) {
			logger.error("StreamLifecycleDO error", {
				error: error instanceof Error ? error.message : String(error),
				pathname: url.pathname,
			});

			return Response.json(
				{ error: error instanceof Error ? error.message : "Internal error" },
				{ status: 500 },
			);
		}
	}

	/**
	 * Poll viewer count from Twitch using TwitchService
	 */
	private async pollViewerCount(): Promise<number | null> {
		// Create TwitchService instance (not using service binding)
		const twitchService = new TwitchService(this.env);
		const result = await twitchService.getStreamInfo(this.env.TWITCH_BROADCASTER_NAME);

		if (result.status === "error") {
			logger.error("Error polling viewer count", {
				error: result.error.message,
				code: result.error._tag,
			});
			return null;
		}

		const streamInfo = result.value;
		if (!streamInfo) {
			return null;
		}

		return streamInfo.viewerCount;
	}

	/**
	 * Notify dependent DOs that stream is online (parallel, errors logged)
	 */
	private async notifyTokenDOsOnline(): Promise<void> {
		const spotifyStub = getStub("SPOTIFY_TOKEN_DO");
		const twitchStub = getStub("TWITCH_TOKEN_DO");
		const poolStub = getStub("WORKFLOW_POOL_DO");

		const [spotifyResult, twitchResult, poolResult] = await Promise.all([
			spotifyStub.onStreamOnline(),
			twitchStub.onStreamOnline(),
			poolStub.onStreamOnline(),
		]);

		if (spotifyResult.status === "error") {
			logger.error("Failed to notify SpotifyTokenDO of stream online", {
				error: spotifyResult.error.message,
			});
		}

		if (twitchResult.status === "error") {
			logger.error("Failed to notify TwitchTokenDO of stream online", {
				error: twitchResult.error.message,
			});
		}

		if (poolResult.status === "error") {
			logger.error("Failed to notify WorkflowPoolDO of stream online", {
				error: poolResult.error.message,
			});
		}
	}

	/**
	 * Notify dependent DOs that stream is offline (parallel, errors logged)
	 */
	private async notifyTokenDOsOffline(): Promise<void> {
		const spotifyStub = getStub("SPOTIFY_TOKEN_DO");
		const twitchStub = getStub("TWITCH_TOKEN_DO");
		const poolStub = getStub("WORKFLOW_POOL_DO");

		const [spotifyResult, twitchResult, poolResult] = await Promise.all([
			spotifyStub.onStreamOffline(),
			twitchStub.onStreamOffline(),
			poolStub.onStreamOffline(),
		]);

		if (spotifyResult.status === "error") {
			logger.error("Failed to notify SpotifyTokenDO of stream offline", {
				error: spotifyResult.error.message,
			});
		}

		if (twitchResult.status === "error") {
			logger.error("Failed to notify TwitchTokenDO of stream offline", {
				error: twitchResult.error.message,
			});
		}

		if (poolResult.status === "error") {
			logger.error("Failed to notify WorkflowPoolDO of stream offline", {
				error: poolResult.error.message,
			});
		}
	}

	/**
	 * Broadcast message to all connected WebSocket clients
	 */
	private broadcastToWebSockets(message: { type: string; timestamp: string }): void {
		const webSockets = this.ctx.getWebSockets() as WebSocket[];
		const messageStr = JSON.stringify(message);

		for (const ws of webSockets) {
			// ws.send can throw if connection is closing - use Result.try for sync operations
			const sendResult = Result.try({
				try: () => ws.send(messageStr),
				catch: (cause) => new Error(`WebSocket send failed: ${String(cause)}`),
			});
			if (sendResult.status === "error") {
				logger.error("Failed to broadcast to WebSocket", { error: sendResult.error.message });
			}
		}
	}
}
