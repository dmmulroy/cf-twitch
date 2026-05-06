/**
 * StreamLifecycleDO - Manages stream lifecycle events and viewer tracking
 */

import { Agent, type AgentContext } from "agents";
import { Result } from "better-result";
import { and, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/stream-lifecycle-do/migrations";
import { type Clock, type IsoTimestamp, SystemClock } from "../lib/clock";
import { getStub, rpc, withRpcSerialization } from "../lib/durable-objects";
import { DurableObjectError } from "../lib/errors";
import { logger } from "../lib/logger";
import { TwitchService } from "../services/twitch-service";
import { createStreamOfflineEvent, createStreamOnlineEvent } from "./schemas/event-bus-do.schema";
import * as schema from "./stream-lifecycle-do.schema";
import { type ViewerSnapshot, viewerSnapshots } from "./stream-lifecycle-do.schema";
import {
	goOffline,
	goOnline,
	initialOfflineState,
	parsePersistedStreamLifecycleState,
	type LiveStreamAgentState,
	type StreamLifecycleAgentState,
	type StreamLifecycleState,
} from "./stream-lifecycle-state";

import type { Env } from "../index";

const VIEWER_POLL_INTERVAL_SECONDS = 60;

const RecordViewerCountBodySchema = z.object({
	count: z.number(),
});

class _StreamLifecycleDO extends Agent<Env, StreamLifecycleAgentState> {
	private db: ReturnType<typeof drizzle<typeof schema>>;
	private nextViewerSnapshotAtMs = 0;
	private readonly clock: Clock = new SystemClock();

	initialState: StreamLifecycleAgentState = initialOfflineState();

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });
	}

	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);

			const normalized = parsePersistedStreamLifecycleState(this.state, this.clock);
			this.setState(normalized);

			if (normalized._tag === "LiveStream") {
				await this.ensureViewerPollingSchedule();
			}
		});
	}

	/**
	 * Lifecycle handler: called when stream goes online
	 *
	 * @param eventTimestamp - Optional authoritative timestamp from upstream event source.
	 * When provided, stale out-of-order events are ignored.
	 */
	async onStreamOnline(eventTimestamp?: string): Promise<void> {
		const transitionAt = this.clock.resolveIsoTimestamp(eventTimestamp);
		const latestTransitionAt = this.getLatestTransitionAt(this.state);

		if (latestTransitionAt && this.clock.isBefore(transitionAt, latestTransitionAt)) {
			logger.warn("Ignoring stale stream.online event", {
				eventTimestamp: transitionAt,
				latestTransitionAt,
				stateTag: this.state._tag,
			});
			return;
		}

		if (this.state._tag === "LiveStream") {
			logger.info("Ignoring duplicate stream.online event", {
				eventTimestamp: transitionAt,
				startedAt: this.state.startedAt,
			});
			return;
		}

		const streamSessionId = crypto.randomUUID();
		this.setState(goOnline(this.state, transitionAt, streamSessionId));

		logger.info("Stream online", { timestamp: transitionAt, streamSessionId });

		const sideEffects = await Promise.allSettled([
			this.notifyTokenDOsOnline(transitionAt, streamSessionId),
			this.ensureViewerPollingSchedule(),
		]);
		this.logRejectedSideEffects("stream online", sideEffects);
	}

	/**
	 * Lifecycle handler: called when stream goes offline
	 *
	 * @param eventTimestamp - Optional authoritative timestamp from upstream event source.
	 * When provided, stale out-of-order events are ignored.
	 */
	async onStreamOffline(eventTimestamp?: string): Promise<void> {
		const transitionAt = this.clock.resolveIsoTimestamp(eventTimestamp);
		const latestTransitionAt = this.getLatestTransitionAt(this.state);

		if (latestTransitionAt && this.clock.isBefore(transitionAt, latestTransitionAt)) {
			logger.warn("Ignoring stale stream.offline event", {
				eventTimestamp: transitionAt,
				latestTransitionAt,
				stateTag: this.state._tag,
			});
			return;
		}

		if (this.state._tag === "OfflineStream") {
			logger.info("Ignoring duplicate stream.offline event", {
				eventTimestamp: transitionAt,
				endedAt: this.state.endedAt,
			});
			return;
		}

		const liveState = this.state;
		this.setState(goOffline(liveState, transitionAt));

		logger.info("Stream offline", {
			timestamp: transitionAt,
			streamSessionId: liveState.streamSessionId,
		});

		const sideEffects = await Promise.allSettled([
			this.notifyTokenDOsOffline(transitionAt, liveState.streamSessionId),
			this.cancelViewerPollingSchedule(liveState),
		]);
		this.logRejectedSideEffects("stream offline", sideEffects);
	}

	/**
	 * Record a viewer count snapshot
	 */
	async recordViewerCount(count: number): Promise<void> {
		const timestamp = this.createViewerSnapshotTimestamp();

		await this.db.insert(viewerSnapshots).values({
			timestamp,
			viewerCount: count,
		});

		if (count > this.state.peakViewerCount) {
			this.setState({ ...this.state, peakViewerCount: count });
		}

		logger.debug("Recorded viewer count", { count, timestamp });
	}

	/**
	 * Get current stream state
	 */
	@rpc
	async getStreamState(): Promise<Result<StreamLifecycleState, DurableObjectError>> {
		return Result.ok(this.toStreamState());
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
		return this.state._tag === "LiveStream";
	}

	/**
	 * Scheduled callback: polls viewer count when stream is live.
	 */
	async pollViewerCountTick(): Promise<void> {
		if (this.state._tag !== "LiveStream") {
			return;
		}

		const viewerCount = await this.pollViewerCount();
		if (viewerCount === null) {
			return;
		}

		const recordResult = await Result.tryPromise({
			try: () => this.recordViewerCount(viewerCount),
			catch: (cause) =>
				new DurableObjectError({
					method: "pollViewerCountTick.recordViewerCount",
					message: String(cause),
					cause,
				}),
		});

		if (recordResult.status === "error") {
			logger.error("Failed to record viewer count", { error: recordResult.error.message });
		}
	}

	/**
	 * HTTP routing for compatibility endpoints.
	 */
	async onRequest(request: Request): Promise<Response> {
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

	private toStreamState(state: StreamLifecycleAgentState = this.state): StreamLifecycleState {
		if (state._tag === "LiveStream") {
			return {
				isLive: true,
				startedAt: state.startedAt,
				endedAt: null,
				peakViewerCount: state.peakViewerCount,
			};
		}

		return {
			isLive: false,
			startedAt: state.lastStartedAt,
			endedAt: state.endedAt,
			peakViewerCount: state.peakViewerCount,
		};
	}

	private createViewerSnapshotTimestamp(): string {
		const nowMs = this.clock.now().getTime();
		const nextMs = nowMs > this.nextViewerSnapshotAtMs ? nowMs : this.nextViewerSnapshotAtMs + 1;
		this.nextViewerSnapshotAtMs = nextMs;
		return new Date(nextMs).toISOString();
	}

	private async ensureViewerPollingSchedule(): Promise<void> {
		if (this.state._tag !== "LiveStream") {
			return;
		}

		const schedule = await this.scheduleEvery(VIEWER_POLL_INTERVAL_SECONDS, "pollViewerCountTick");

		if (this.state.viewerPollScheduleId === schedule.id) {
			return;
		}

		this.setState({ ...this.state, viewerPollScheduleId: schedule.id });
	}

	private async cancelViewerPollingSchedule(liveState: LiveStreamAgentState): Promise<void> {
		if (liveState.viewerPollScheduleId === null) {
			return;
		}

		await this.cancelSchedule(liveState.viewerPollScheduleId);
	}

	/**
	 * Poll viewer count from Twitch using TwitchService.
	 */
	private async pollViewerCount(): Promise<number | null> {
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

	private logRejectedSideEffects(
		transition: "stream online" | "stream offline",
		results: PromiseSettledResult<unknown>[],
	): void {
		for (const result of results) {
			if (result.status === "rejected") {
				logger.error("Stream lifecycle side effect failed", {
					transition,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				});
			}
		}
	}

	/**
	 * Get the latest state transition timestamp from persisted stream state.
	 */
	private getLatestTransitionAt(state: StreamLifecycleAgentState): IsoTimestamp | null {
		if (state._tag === "LiveStream") {
			return state.startedAt;
		}

		if (state.lastStartedAt && state.endedAt) {
			return this.clock.isBefore(state.lastStartedAt, state.endedAt)
				? state.endedAt
				: state.lastStartedAt;
		}

		return state.lastStartedAt ?? state.endedAt ?? null;
	}

	/**
	 * Notify dependent DOs that stream is online and publish stream_online event.
	 */
	private async notifyTokenDOsOnline(startedAt: string, streamSessionId: string): Promise<void> {
		const spotifyStub = getStub("SPOTIFY_TOKEN_DO");
		const twitchStub = getStub("TWITCH_TOKEN_DO");
		const eventBusStub = getStub("EVENT_BUS_DO");

		const event = createStreamOnlineEvent({
			id: crypto.randomUUID(),
			streamId: streamSessionId,
			startedAt,
		});

		const [spotifyResult, twitchResult, eventBusResult] = await Promise.all([
			spotifyStub.onStreamOnline(),
			twitchStub.onStreamOnline(),
			eventBusStub.publish(event),
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

		if (eventBusResult.status === "error") {
			logger.warn("EventBusDO publish stream_online failed (will retry via alarm)", {
				error: eventBusResult.error.message,
				eventId: event.id,
			});
		} else {
			logger.info("Published stream_online event", { eventId: event.id });
		}
	}

	/**
	 * Notify dependent DOs that stream is offline and publish stream_offline event.
	 */
	private async notifyTokenDOsOffline(endedAt: string, streamSessionId: string): Promise<void> {
		const spotifyStub = getStub("SPOTIFY_TOKEN_DO");
		const twitchStub = getStub("TWITCH_TOKEN_DO");
		const eventBusStub = getStub("EVENT_BUS_DO");

		const event = createStreamOfflineEvent({
			id: crypto.randomUUID(),
			streamId: streamSessionId,
			endedAt,
		});

		const [spotifyResult, twitchResult, eventBusResult] = await Promise.all([
			spotifyStub.onStreamOffline(),
			twitchStub.onStreamOffline(),
			eventBusStub.publish(event),
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

		if (eventBusResult.status === "error") {
			logger.warn("EventBusDO publish stream_offline failed (will retry via alarm)", {
				error: eventBusResult.error.message,
				eventId: event.id,
			});
		} else {
			logger.info("Published stream_offline event", { eventId: event.id });
		}
	}
}

export const StreamLifecycleDO = withRpcSerialization(_StreamLifecycleDO);
