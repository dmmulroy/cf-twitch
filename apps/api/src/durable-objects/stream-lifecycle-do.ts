/**
 * StreamLifecycleDO - Manages stream lifecycle events and viewer tracking
 */

import { Agent, type AgentContext } from "agents";
import { Result, TaggedError } from "better-result";
import { and, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/stream-lifecycle-do/migrations";
import {
	DurableObjectSpotifyAccessTokens,
	DurableObjectTwitchAccessTokens,
} from "../adapters/cloudflare/durable-object-access-tokens";
import { DurableObjectDomainEventPublisher } from "../adapters/cloudflare/durable-object-domain-event-publisher";
import { LoggingTracer } from "../capabilities/tracer";
import { parseWorkerConfiguration } from "../configuration/worker-configuration";
import { createStreamOfflineEvent, createStreamOnlineEvent } from "../domain/domain-event";
import {
	type Clock,
	type InvalidIsoTimestampError,
	type IsoTimestamp,
	SystemClock,
} from "../lib/clock";
import { rpc } from "../lib/durable-objects";
import { DurableObjectError } from "../lib/errors";
import { logger } from "../lib/logger";
import { TwitchService } from "../services/twitch-service";
import * as schema from "./stream-lifecycle-do.schema";
import { type ViewerSnapshot, viewerSnapshots } from "./stream-lifecycle-do.schema";
import {
	goOffline,
	goOnline,
	initialOfflineState,
	parsePersistedStreamLifecycleState,
	type StreamLifecycleAgentState,
	type StreamLifecycleTransitionIntent,
} from "./stream-lifecycle-state";

import type { DomainEventPublisher } from "../capabilities/domain-event-publisher";
import type { ProviderTokenLifecycle } from "../capabilities/provider-access-tokens";
import type { StreamLifecycleState } from "../domain/stream-lifecycle";
import type { Env } from "../index";

const VIEWER_POLL_INTERVAL_SECONDS = 60;

/** Expected retry signal when a durable Stream Lifecycle transition still has incomplete effects. */
export class StreamLifecycleEffectsPendingError extends TaggedError(
	"StreamLifecycleEffectsPendingError",
)<{
	message: string;
	transition: "stream.online" | "stream.offline";
}>() {
	constructor(transition: "stream.online" | "stream.offline") {
		super({
			message: `Stream Lifecycle effects pending for ${transition}`,
			transition,
		});
	}
}

const RecordViewerCountBodySchema = z.object({
	count: z.number(),
});

class _StreamLifecycleDO extends Agent<Env, StreamLifecycleAgentState> {
	private db: ReturnType<typeof drizzle<typeof schema>>;
	private nextViewerSnapshotAtMs = 0;
	private readonly clock: Clock = new SystemClock();
	private readonly domainEvents: DomainEventPublisher;
	private readonly spotifyTokenLifecycle: ProviderTokenLifecycle;
	private readonly twitchTokenLifecycle: ProviderTokenLifecycle;
	private readonly twitchService: TwitchService;
	private readonly broadcasterDisplayName: string;

	initialState: StreamLifecycleAgentState = initialOfflineState();

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });
		const configuration = parseWorkerConfiguration(env);
		if (configuration.status === "error") {
			throw new Error("Stream Lifecycle Durable Object configuration is invalid");
		}
		this.broadcasterDisplayName = configuration.value.twitch.broadcaster.displayName;
		const tracer = new LoggingTracer(logger);
		this.domainEvents = new DurableObjectDomainEventPublisher(env.EVENT_BUS_DO, tracer);
		this.spotifyTokenLifecycle = new DurableObjectSpotifyAccessTokens(env.SPOTIFY_TOKEN_DO, tracer);
		const twitchAccessTokens = new DurableObjectTwitchAccessTokens(env.TWITCH_TOKEN_DO, tracer);
		this.twitchTokenLifecycle = twitchAccessTokens;
		this.twitchService = new TwitchService({
			configuration: configuration.value.twitch,
			accessTokens: twitchAccessTokens,
		});
	}

	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);

			const normalized = parsePersistedStreamLifecycleState(this.state, this.clock);
			if (normalized.status === "error") {
				logger.error("Stream Lifecycle persisted state is corrupt", {
					event: "stream_lifecycle.persisted_state_corrupt",
					error_tag: normalized.error._tag,
					parse_error: normalized.error.parseError,
				});
				throw normalized.error;
			}
			this.setState(normalized.value);
			await this.resumeTransitionEffects();

			if (normalized.value._tag === "LiveStream" && normalized.value.transitionIntent === null) {
				await this.ensureViewerPollingSchedule();
			}
		});
	}

	/** Accept an online transition using source time and resume every durable side-effect intent. */
	@rpc
	async onStreamOnline(
		eventTimestamp?: string,
	): Promise<Result<void, InvalidIsoTimestampError | StreamLifecycleEffectsPendingError>> {
		const parsedTimestamp =
			eventTimestamp === undefined
				? Result.ok(this.clock.nowIsoTimestamp())
				: this.clock.parseIsoTimestamp(eventTimestamp);
		if (parsedTimestamp.status === "error") return parsedTimestamp;
		const pendingTransition = this.state.transitionIntent;
		if (pendingTransition !== null && !(await this.resumeTransitionEffects())) {
			return Result.err(
				new StreamLifecycleEffectsPendingError(
					pendingTransition._tag === "StreamOnlineIntent" ? "stream.online" : "stream.offline",
				),
			);
		}
		const transitionAt = parsedTimestamp.value;
		const latestTransitionAt = this.getLatestTransitionAt(this.state);

		if (latestTransitionAt && this.clock.isBefore(transitionAt, latestTransitionAt)) {
			logger.warn("Ignoring stale stream.online event", {
				eventTimestamp: transitionAt,
				latestTransitionAt,
				stateTag: this.state._tag,
			});
			return Result.ok();
		}

		if (this.state._tag === "OfflineStream") {
			const streamSessionId = crypto.randomUUID();
			this.setState(goOnline(this.state, transitionAt, streamSessionId, crypto.randomUUID()));
			logger.info("Stream online transition durably accepted", {
				timestamp: transitionAt,
				streamSessionId,
			});
		}

		const completed = await this.resumeTransitionEffects();
		return completed
			? Result.ok()
			: Result.err(new StreamLifecycleEffectsPendingError("stream.online"));
	}

	/** Accept an offline transition using explicit ordering evidence and resume durable effects. */
	@rpc
	async onStreamOffline(
		eventTimestamp?: string,
	): Promise<Result<void, InvalidIsoTimestampError | StreamLifecycleEffectsPendingError>> {
		const parsedTimestamp =
			eventTimestamp === undefined
				? Result.ok(this.clock.nowIsoTimestamp())
				: this.clock.parseIsoTimestamp(eventTimestamp);
		if (parsedTimestamp.status === "error") return parsedTimestamp;
		const pendingTransition = this.state.transitionIntent;
		if (pendingTransition !== null && !(await this.resumeTransitionEffects())) {
			return Result.err(
				new StreamLifecycleEffectsPendingError(
					pendingTransition._tag === "StreamOnlineIntent" ? "stream.online" : "stream.offline",
				),
			);
		}
		const transitionAt = parsedTimestamp.value;
		const latestTransitionAt = this.getLatestTransitionAt(this.state);

		if (latestTransitionAt && this.clock.isBefore(transitionAt, latestTransitionAt)) {
			logger.warn("Ignoring stale stream.offline event", {
				eventTimestamp: transitionAt,
				latestTransitionAt,
				stateTag: this.state._tag,
			});
			return Result.ok();
		}

		if (this.state._tag === "LiveStream") {
			const liveState = this.state;
			this.setState(goOffline(liveState, transitionAt, crypto.randomUUID()));
			logger.info("Stream offline transition durably accepted", {
				timestamp: transitionAt,
				streamSessionId: liveState.streamSessionId,
			});
		}

		const completed = await this.resumeTransitionEffects();
		return completed
			? Result.ok()
			: Result.err(new StreamLifecycleEffectsPendingError("stream.offline"));
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
		if (this.state._tag !== "LiveStream" || this.state.viewerPollScheduleId !== null) {
			return;
		}

		const schedule = await this.scheduleEvery(VIEWER_POLL_INTERVAL_SECONDS, "pollViewerCountTick");

		if (this.state.viewerPollScheduleId === schedule.id) {
			return;
		}

		this.setState({ ...this.state, viewerPollScheduleId: schedule.id });
	}

	private async cancelViewerPollingSchedule(scheduleId: string | null): Promise<void> {
		if (scheduleId !== null) await this.cancelSchedule(scheduleId);
	}

	/**
	 * Poll viewer count from Twitch using TwitchService.
	 */
	private async pollViewerCount(): Promise<number | null> {
		const result = await this.twitchService.getStreamInfo(this.broadcasterDisplayName);

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

	/** Get the latest authoritative transition timestamp in persisted state. */
	private getLatestTransitionAt(state: StreamLifecycleAgentState): IsoTimestamp | null {
		if (state._tag === "LiveStream") return state.startedAt;
		if (state.lastStartedAt && state.endedAt) {
			return this.clock.isBefore(state.lastStartedAt, state.endedAt)
				? state.endedAt
				: state.lastStartedAt;
		}
		return state.lastStartedAt ?? state.endedAt ?? null;
	}

	private async resumeTransitionEffects(): Promise<boolean> {
		const intent = this.state.transitionIntent;
		if (intent === null) return true;

		await this.resumeTokenEffect(intent, "spotifyTokenNotified");
		await this.resumeTokenEffect(intent, "twitchTokenNotified");
		await this.resumeLifecycleEventEffect(intent);
		await this.resumeViewerPollingEffect(intent);

		const current = this.state.transitionIntent;
		if (current === null) return true;
		const completed =
			current.spotifyTokenNotified &&
			current.twitchTokenNotified &&
			current.lifecycleEventPublished &&
			current.viewerPollingUpdated;
		if (completed) this.setState({ ...this.state, transitionIntent: null });
		return completed;
	}

	private async resumeTokenEffect(
		intent: StreamLifecycleTransitionIntent,
		effect: "spotifyTokenNotified" | "twitchTokenNotified",
	): Promise<void> {
		if (this.state.transitionIntent?.[effect] !== false) return;
		const tokenLifecycle =
			effect === "spotifyTokenNotified" ? this.spotifyTokenLifecycle : this.twitchTokenLifecycle;
		const result =
			intent._tag === "StreamOnlineIntent"
				? await tokenLifecycle.onStreamOnline()
				: await tokenLifecycle.onStreamOffline();
		if (result.status === "error") {
			logger.error("Stream Lifecycle token side effect remains pending", {
				event: "stream_lifecycle.transition_effect_failed",
				effect,
				transition: intent._tag,
				error_message: result.error.message,
			});
			return;
		}
		this.markTransitionEffectComplete(intent.eventId, effect);
	}

	private async resumeLifecycleEventEffect(intent: StreamLifecycleTransitionIntent): Promise<void> {
		if (this.state.transitionIntent?.lifecycleEventPublished !== false) return;
		const event =
			intent._tag === "StreamOnlineIntent"
				? createStreamOnlineEvent({
						id: intent.eventId,
						streamId: intent.streamSessionId,
						startedAt: intent.transitionAt,
					})
				: createStreamOfflineEvent({
						id: intent.eventId,
						streamId: intent.streamSessionId,
						endedAt: intent.transitionAt,
					});
		const result = await this.domainEvents.publish(event);
		if (result.status === "error") {
			logger.error("Stream Lifecycle event publication remains pending", {
				event: "stream_lifecycle.transition_effect_failed",
				effect: "lifecycleEventPublished",
				transition: intent._tag,
				event_id: intent.eventId,
				error_message: result.error.message,
			});
			return;
		}
		this.markTransitionEffectComplete(intent.eventId, "lifecycleEventPublished");
	}

	private async resumeViewerPollingEffect(intent: StreamLifecycleTransitionIntent): Promise<void> {
		if (this.state.transitionIntent?.viewerPollingUpdated !== false) return;
		try {
			if (intent._tag === "StreamOnlineIntent") await this.ensureViewerPollingSchedule();
			else await this.cancelViewerPollingSchedule(intent.viewerPollScheduleId);
			this.markTransitionEffectComplete(intent.eventId, "viewerPollingUpdated");
		} catch (cause) {
			logger.error("Stream Lifecycle viewer polling effect remains pending", {
				event: "stream_lifecycle.transition_effect_failed",
				effect: "viewerPollingUpdated",
				transition: intent._tag,
				error_message: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}

	private markTransitionEffectComplete(
		eventId: string,
		effect:
			| "spotifyTokenNotified"
			| "twitchTokenNotified"
			| "lifecycleEventPublished"
			| "viewerPollingUpdated",
	): void {
		const current = this.state.transitionIntent;
		if (current === null || current.eventId !== eventId) return;
		this.setState({
			...this.state,
			transitionIntent: { ...current, [effect]: true },
		});
	}
}

export { _StreamLifecycleDO as StreamLifecycleDO };
