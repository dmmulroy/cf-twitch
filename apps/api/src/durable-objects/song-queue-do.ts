/**
 * SongQueueDO - Manages song request queue with Spotify sync
 *
 * Agent state owns only operational coordination for freshness and scheduling.
 * SQLite remains the durable source of truth for queue snapshots, pending
 * requests, and request history.
 */

import { Agent, type AgentContext } from "agents";
import { Result, TaggedError } from "better-result";
import { RpcTarget } from "cloudflare:workers";
import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	max,
	notInArray,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../../drizzle/song-queue-do/migrations";
import { rpc, withRpcSerialization } from "../lib/durable-objects";
import { SongQueueDbError, SongRequestNotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";
import { toRpcResult, type RpcResult } from "../lib/rpc-result";
import { SpotifyService, type SpotifyTrack, type TrackInfo } from "../services/spotify-service";
import * as schema from "./schemas/song-queue-do.schema";
import {
	ArtistNamesJsonSchema,
	PendingRequestInputSchema,
	PendingRequestRecordSchema,
	RequestHistoryQuerySchema,
	RequestHistoryRecordSchema,
	SongQueueDisplayTextSchema,
	SongQueueDomainIdSchema,
	SongQueueInstantSchema,
	SongQueueLimitSchema,
	SpotifyQueueSnapshotRecordSchema,
	type CurrentlyPlayingResult,
	type PendingRequest,
	type PendingRequestInput,
	type QueueResult,
	type QueuedTrack,
	type RequestHistoryItem,
	type RequestHistoryResult,
	type SpotifyQueueSnapshotRecord,
	type TopRequester,
	type TopTrack,
	type TrackSource,
	pendingRequests,
	requestHistory,
	spotifyQueueSnapshot,
} from "./schemas/song-queue-do.schema";

import type { Env } from "../index";

/** Stable Agent name used to acquire the singleton Song Queue Durable Object. */
export const SONG_QUEUE_DO_NAME = "song-queue";

const MAX_STALENESS_MS = 15_000;
const REFRESH_AFTER_MUTATION_DELAY_SECONDS = 1;
const CLEANUP_INTERVAL_SECONDS = 5 * 60;
const MAX_REFRESH_BACKOFF_SECONDS = 5 * 60;

/** Expected failure when Song Queue RPC input or persisted records cannot be parsed. */
export class SongQueueParseError extends TaggedError("SongQueueParseError")<{
	readonly boundary: "rpc-input" | "persistence";
	readonly operation: string;
	readonly parseError: string;
	readonly message: string;
}>() {
	constructor(args: {
		boundary: "rpc-input" | "persistence";
		operation: string;
		parseError: string;
	}) {
		super({ ...args, message: `Invalid Song Queue data during ${args.operation}` });
	}
}

/** Expected failure while coordinating durable Song Queue refresh and cleanup schedules. */
export class SongQueueCoordinationError extends TaggedError("SongQueueCoordinationError")<{
	readonly operation: string;
	readonly message: string;
	readonly cause?: unknown;
}>() {
	constructor(args: { operation: string; cause?: unknown }) {
		super({ ...args, message: `Song Queue coordination failed during ${args.operation}` });
	}
}

/** Complete expected-error contract for Song Queue operations. */
export type SongQueueError = SongQueueDbError | SongQueueParseError | SongQueueCoordinationError;

/** Public Spotify Track occurrence with explicit Viewer or autoplay source. */
export type { QueuedTrack } from "./schemas/song-queue-do.schema";
/** Parsed Now Playing response contract. */
export type { CurrentlyPlayingResult } from "./schemas/song-queue-do.schema";
/** Parsed Spotify Queue response contract. */
export type { QueueResult } from "./schemas/song-queue-do.schema";
/** Parsed Request History response contract. */
export type { RequestHistoryResult } from "./schemas/song-queue-do.schema";
/** Spotify Track aggregation grouped by stable Track ID. */
export type { TopTrack } from "./schemas/song-queue-do.schema";
/** Viewer aggregation grouped by stable Viewer ID. */
export type { TopRequester } from "./schemas/song-queue-do.schema";

/** Cohesive Song Queue application capability exposed over Durable Object RPC. */
export interface SongQueue {
	persistRequest(request: PendingRequestInput): Promise<Result<void, SongQueueError>>;
	deleteRequest(eventId: string): Promise<Result<void, SongQueueError>>;
	getSongQueue(limit: number): Promise<Result<QueueResult, SongQueueError>>;
	getCurrentlyPlaying(): Promise<Result<CurrentlyPlayingResult, SongQueueError>>;
	getRequestHistory(
		limit: number,
		offset: number,
		since?: string,
		until?: string,
	): Promise<Result<RequestHistoryResult, SongQueueError>>;
	getUserRequestCount(userId: string): Promise<Result<number, SongQueueError>>;
	getUserRequestCountByDisplayName(displayName: string): Promise<Result<number, SongQueueError>>;
	getTopTracks(limit: number): Promise<Result<TopTrack[], SongQueueError>>;
	getTopTracksByUser(userId: string, limit: number): Promise<Result<TopTrack[], SongQueueError>>;
	getTopRequesters(limit: number): Promise<Result<TopRequester[], SongQueueError>>;
}

interface SongQueueAgentState {
	lastSyncAt: string | null;
	refreshScheduleId: string | null;
	refreshDueAt: string | null;
	cleanupScheduleId: string | null;
	cleanupDueAt: string | null;
	consecutiveSyncFailures: number;
}

function parseRpcInput<T>(
	schemaParser: {
		safeParse(
			value: unknown,
		): { success: true; data: T } | { success: false; error: { message: string } };
	},
	value: unknown,
	operation: string,
): Result<T, SongQueueParseError> {
	const parsed = schemaParser.safeParse(value);
	return parsed.success
		? Result.ok(parsed.data)
		: Result.err(
				new SongQueueParseError({
					boundary: "rpc-input",
					operation,
					parseError: parsed.error.message,
				}),
			);
}

function parseArtistsJson(
	artistsJson: string,
	operation: string,
): Result<string[], SongQueueParseError> {
	const parsed = ArtistNamesJsonSchema.safeParse(artistsJson);
	return parsed.success
		? Result.ok(parsed.data)
		: Result.err(
				new SongQueueParseError({
					boundary: "persistence",
					operation,
					parseError: parsed.error.message,
				}),
			);
}

function toQueuedTrack(snapshot: SpotifyQueueSnapshotRecord, artists: string[]): QueuedTrack {
	const track = {
		id: snapshot.trackId,
		name: snapshot.trackName,
		artists,
		album: snapshot.album,
		albumCoverUrl: snapshot.albumCoverUrl,
	};
	if (snapshot.source === "user") {
		return {
			...track,
			source: "user",
			eventId: snapshot.eventId,
			requesterUserId: snapshot.requesterUserId,
			requesterDisplayName: snapshot.requesterDisplayName,
			requestedAt: snapshot.requestedAt,
		};
	}
	return { ...track, source: "autoplay" };
}

function parseSnapshotRecord(
	record: unknown,
	operation: string,
): Result<SpotifyQueueSnapshotRecord, SongQueueParseError> {
	const parsed = SpotifyQueueSnapshotRecordSchema.safeParse(record);
	if (!parsed.success)
		return Result.err(
			new SongQueueParseError({
				boundary: "persistence",
				operation,
				parseError: parsed.error.message,
			}),
		);
	return Result.ok(parsed.data);
}

function parseHistoryRecord(
	record: unknown,
	operation: string,
): Result<RequestHistoryItem, SongQueueParseError> {
	const parsed = RequestHistoryRecordSchema.safeParse(record);
	if (!parsed.success)
		return Result.err(
			new SongQueueParseError({
				boundary: "persistence",
				operation,
				parseError: parsed.error.message,
			}),
		);
	const artists = parseArtistsJson(parsed.data.artists, operation);
	if (artists.status === "error") return artists;
	return Result.ok({ ...parsed.data, artists: artists.value });
}

function toTrackInfo(track: SpotifyTrack): TrackInfo {
	const albumCover = [...track.album.images].sort((a, b) => a.height - b.height)[0];
	return {
		id: track.id,
		name: track.name,
		artists: track.artists.map((artist) => artist.name),
		album: track.album.name,
		albumCoverUrl: albumCover?.url ?? null,
	};
}

type AttributedSpotifyOccurrence = {
	readonly position: number;
	readonly trackId: string;
	readonly trackName: string;
	readonly artists: string;
	readonly album: string;
	readonly albumCoverUrl: string | null;
	readonly source: TrackSource;
	readonly eventId: string | null;
	readonly requesterUserId: string | null;
	readonly requesterDisplayName: string | null;
	readonly requestedAt: string | null;
};

function attributeSpotifyOccurrences(
	previousSnapshots: SpotifyQueueSnapshotRecord[],
	allPending: PendingRequest[],
	currentTrack: TrackInfo | null,
	upcomingTracks: TrackInfo[],
): AttributedSpotifyOccurrence[] {
	const previousCurrent = previousSnapshots.find((snapshot) => snapshot.position === 0);
	const previousUpcoming = previousSnapshots
		.filter((snapshot) => snapshot.position > 0)
		.sort((left, right) => left.position - right.position);
	const previousUserOccurrencesByTrack = new Map<string, SpotifyQueueSnapshotRecord[]>();
	for (const snapshot of previousUpcoming) {
		if (snapshot.source !== "user" || snapshot.eventId === null) continue;
		const occurrences = previousUserOccurrencesByTrack.get(snapshot.trackId) ?? [];
		occurrences.push(snapshot);
		previousUserOccurrencesByTrack.set(snapshot.trackId, occurrences);
	}

	let promotedEventId: string | undefined;
	let currentRequest: PendingRequest | undefined;
	if (currentTrack !== null) {
		const previousTrackOccurrences = previousUpcoming.filter(
			(snapshot) => snapshot.trackId === currentTrack.id,
		).length;
		const upcomingTrackOccurrences = upcomingTracks.filter(
			(track) => track.id === currentTrack.id,
		).length;
		const promotable = previousUserOccurrencesByTrack.get(currentTrack.id)?.[0];
		if (promotable?.eventId && upcomingTrackOccurrences < previousTrackOccurrences) {
			promotedEventId = promotable.eventId;
			currentRequest = allPending.find((request) => request.eventId === promotedEventId);
		} else if (
			previousCurrent?.source === "user" &&
			previousCurrent.trackId === currentTrack.id &&
			previousCurrent.eventId !== null
		) {
			currentRequest = allPending.find((request) => request.eventId === previousCurrent.eventId);
		}
	}

	const assignedEventIds = new Set<string>();
	if (currentRequest) assignedEventIds.add(currentRequest.eventId);
	const reusableByTrack = new Map<string, PendingRequest[]>();
	for (const [trackId, snapshots] of previousUserOccurrencesByTrack) {
		const requests = snapshots
			.filter((snapshot) => snapshot.eventId !== promotedEventId)
			.map((snapshot) => allPending.find((request) => request.eventId === snapshot.eventId))
			.filter((request): request is PendingRequest => request !== undefined);
		reusableByTrack.set(trackId, requests);
	}
	const unassignedByTrack = new Map<string, PendingRequest[]>();
	for (const request of allPending) {
		if (assignedEventIds.has(request.eventId)) continue;
		if (previousSnapshots.some((snapshot) => snapshot.eventId === request.eventId)) continue;
		const requests = unassignedByTrack.get(request.trackId) ?? [];
		requests.push(request);
		unassignedByTrack.set(request.trackId, requests);
	}

	const makeOccurrence = (
		track: TrackInfo,
		position: number,
		request: PendingRequest | undefined,
	): AttributedSpotifyOccurrence => ({
		position,
		trackId: track.id,
		trackName: track.name,
		artists: JSON.stringify(track.artists),
		album: track.album,
		albumCoverUrl: track.albumCoverUrl,
		source: request ? "user" : "autoplay",
		eventId: request?.eventId ?? null,
		requesterUserId: request?.requesterUserId ?? null,
		requesterDisplayName: request?.requesterDisplayName ?? null,
		requestedAt: request?.requestedAt ?? null,
	});
	const attributed: AttributedSpotifyOccurrence[] = [];
	if (currentTrack !== null) attributed.push(makeOccurrence(currentTrack, 0, currentRequest));
	for (const [index, track] of upcomingTracks.entries()) {
		const reusable = reusableByTrack.get(track.id)?.shift();
		const newlyAssigned = reusable ?? unassignedByTrack.get(track.id)?.shift();
		if (newlyAssigned) assignedEventIds.add(newlyAssigned.eventId);
		attributed.push(makeOccurrence(track, index + 1, newlyAssigned));
	}
	return attributed;
}

type RpcHandleFromResultMethods<T> = {
	[K in keyof T as K extends symbol ? never : K]: T[K] extends (
		...args: infer Args
	) => Promise<Result<infer Value, infer Error>>
		? (...args: Args) => Promise<RpcResult<Value, Error>>
		: never;
};

export type SongQueueRpcHandleStub = RpcHandleFromResultMethods<SongQueue> & {
	[Symbol.dispose]?: () => void;
};

class SongQueueClient extends RpcTarget implements SongQueueRpcHandleStub {
	constructor(private readonly queue: SongQueue) {
		super();
	}

	persistRequest(request: PendingRequestInput): Promise<RpcResult<void, SongQueueError>> {
		return this.queue.persistRequest(request).then(toRpcResult);
	}

	deleteRequest(eventId: string): Promise<RpcResult<void, SongQueueError>> {
		return this.queue.deleteRequest(eventId).then(toRpcResult);
	}

	getSongQueue(limit: number): Promise<RpcResult<QueueResult, SongQueueError>> {
		return this.queue.getSongQueue(limit).then(toRpcResult);
	}

	getCurrentlyPlaying(): Promise<RpcResult<CurrentlyPlayingResult, SongQueueError>> {
		return this.queue.getCurrentlyPlaying().then(toRpcResult);
	}

	getRequestHistory(
		limit: number,
		offset: number,
		since?: string,
		until?: string,
	): Promise<RpcResult<RequestHistoryResult, SongQueueError>> {
		return this.queue.getRequestHistory(limit, offset, since, until).then(toRpcResult);
	}

	getUserRequestCount(userId: string): Promise<RpcResult<number, SongQueueError>> {
		return this.queue.getUserRequestCount(userId).then(toRpcResult);
	}

	getUserRequestCountByDisplayName(
		displayName: string,
	): Promise<RpcResult<number, SongQueueError>> {
		return this.queue.getUserRequestCountByDisplayName(displayName).then(toRpcResult);
	}

	getTopTracks(limit: number): Promise<RpcResult<TopTrack[], SongQueueError>> {
		return this.queue.getTopTracks(limit).then(toRpcResult);
	}

	getTopTracksByUser(
		userId: string,
		limit: number,
	): Promise<RpcResult<TopTrack[], SongQueueError>> {
		return this.queue.getTopTracksByUser(userId, limit).then(toRpcResult);
	}

	getTopRequesters(limit: number): Promise<RpcResult<TopRequester[], SongQueueError>> {
		return this.queue.getTopRequesters(limit).then(toRpcResult);
	}
}

/**
 * SongQueueDO - Agent-native coordinator for song request queue management
 */
class _SongQueueDO extends Agent<Env, SongQueueAgentState> implements SongQueue {
	private db: ReturnType<typeof drizzle<typeof schema>>;
	private syncLock: Promise<Result<void, SongQueueError>> | null = null;

	initialState: SongQueueAgentState = {
		lastSyncAt: null,
		refreshScheduleId: null,
		refreshDueAt: null,
		cleanupScheduleId: null,
		cleanupDueAt: null,
		consecutiveSyncFailures: 0,
	};

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });
	}

	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
			await this.ctx.storage.deleteAlarm();
			this.hydrateLastSyncAtFromSnapshot();
			await this.restoreOrRecomputeSchedules();
		});
	}

	async connectRpc(): Promise<SongQueueRpcHandleStub> {
		await this.setName(SONG_QUEUE_DO_NAME);
		return new SongQueueClient(this);
	}

	/**
	 * Persist a song request (idempotent via event_id)
	 * Invalidates cache and schedules a near-term refresh.
	 */
	@rpc
	async persistRequest(request: PendingRequestInput): Promise<Result<void, SongQueueError>> {
		const parsed = PendingRequestInputSchema.safeParse(request);
		if (!parsed.success) {
			return Result.err(
				new SongQueueParseError({
					boundary: "rpc-input",
					operation: "persistRequest",
					parseError: parsed.error.message,
				}),
			);
		}

		const result = await Result.tryPromise({
			try: () => this.db.insert(pendingRequests).values(parsed.data).onConflictDoNothing(),
			catch: (cause) =>
				new SongQueueDbError({ operation: `persistRequest(${parsed.data.eventId})`, cause }),
		});

		if (result.status === "error") {
			return Result.err(result.error);
		}

		logger.info("Persisted song request", {
			eventId: parsed.data.eventId,
			trackId: parsed.data.trackId,
		});

		this.updateState({ lastSyncAt: null });
		const scheduleResult = await Result.tryPromise({
			try: async () => {
				await this.scheduleRefreshIn(REFRESH_AFTER_MUTATION_DELAY_SECONDS);
				await this.ensureCleanupSchedule();
			},
			catch: (cause) =>
				new SongQueueCoordinationError({ operation: "persistRequest.scheduleDurableWork", cause }),
		});
		return scheduleResult.status === "error" ? Result.err(scheduleResult.error) : Result.ok();
	}

	/**
	 * Delete a request (for rollback)
	 */
	@rpc
	async deleteRequest(eventId: string): Promise<Result<void, SongQueueError>> {
		const parsedEventId = parseRpcInput(SongQueueDomainIdSchema, eventId, "deleteRequest");
		if (parsedEventId.status === "error") return parsedEventId;
		return Result.tryPromise({
			try: async () => {
				await this.db.delete(pendingRequests).where(eq(pendingRequests.eventId, eventId));
				logger.info("Deleted song request", { eventId });
				await this.restoreOrRecomputeSchedules();
			},
			catch: (cause) => new SongQueueDbError({ operation: `deleteRequest(${eventId})`, cause }),
		});
	}

	/**
	 * Delete a history entry (for rollback)
	 */
	@rpc
	async deleteHistory(eventId: string): Promise<Result<void, SongQueueError>> {
		const parsedEventId = parseRpcInput(SongQueueDomainIdSchema, eventId, "deleteHistory");
		if (parsedEventId.status === "error") return parsedEventId;
		return Result.tryPromise({
			try: async () => {
				await this.db.delete(requestHistory).where(eq(requestHistory.eventId, eventId));
				logger.info("Deleted history entry", { eventId });
			},
			catch: (cause) => new SongQueueDbError({ operation: `deleteHistory(${eventId})`, cause }),
		});
	}

	/** Move a Pending Request to Request History atomically and idempotently. */
	@rpc
	async writeHistory(
		eventId: string,
		fulfilledAt: string,
	): Promise<Result<void, SongQueueError | SongRequestNotFoundError>> {
		const parsedEventId = parseRpcInput(SongQueueDomainIdSchema, eventId, "writeHistory");
		if (parsedEventId.status === "error") return parsedEventId;
		const parsedInstant = SongQueueInstantSchema.safeParse(fulfilledAt);
		if (!parsedInstant.success)
			return Result.err(
				new SongQueueParseError({
					boundary: "rpc-input",
					operation: "writeHistory",
					parseError: parsedInstant.error.message,
				}),
			);
		const result = await Result.tryPromise({
			try: async () =>
				this.db.transaction((tx) => {
					const existing = tx.query.requestHistory
						.findFirst({ where: eq(requestHistory.eventId, eventId) })
						.sync();
					if (existing) return;
					const request = tx.query.pendingRequests
						.findFirst({ where: eq(pendingRequests.eventId, eventId) })
						.sync();
					if (!request) throw new SongRequestNotFoundError({ eventId });
					tx.insert(requestHistory)
						.values({
							eventId: request.eventId,
							trackId: request.trackId,
							trackName: request.trackName,
							artists: request.artists,
							album: request.album,
							albumCoverUrl: request.albumCoverUrl,
							requesterUserId: request.requesterUserId,
							requesterDisplayName: request.requesterDisplayName,
							requestedAt: request.requestedAt,
							fulfilledAt: parsedInstant.data,
						})
						.onConflictDoNothing()
						.run();
					tx.delete(pendingRequests).where(eq(pendingRequests.eventId, eventId)).run();
				}),
			catch: (cause) =>
				cause instanceof SongRequestNotFoundError
					? cause
					: new SongQueueDbError({ operation: `writeHistory(${eventId})`, cause }),
		});
		if (result.status === "error") return result;
		const scheduleResult = await Result.tryPromise({
			try: () => this.restoreOrRecomputeSchedules(),
			catch: (cause) =>
				new SongQueueCoordinationError({ operation: "writeHistory.restoreSchedules", cause }),
		});
		return scheduleResult.status === "error" ? Result.err(scheduleResult.error) : Result.ok();
	}

	/**
	 * Get currently playing track (position 0)
	 * Uses denormalized attribution from snapshot (no join needed)
	 */
	@rpc
	async getCurrentlyPlaying(): Promise<Result<CurrentlyPlayingResult, SongQueueError>> {
		await this.ensureFresh();
		const readResult = await Result.tryPromise({
			try: () =>
				this.db.query.spotifyQueueSnapshot.findFirst({
					where: eq(spotifyQueueSnapshot.position, 0),
				}),
			catch: (cause) =>
				new SongQueueDbError({ operation: "getCurrentlyPlaying.findSnapshot", cause }),
		});
		if (readResult.status === "error") return readResult;
		if (!readResult.value) return Result.ok({ track: null, position: 0 });
		const snapshot = parseSnapshotRecord(readResult.value, "getCurrentlyPlaying.parseSnapshot");
		if (snapshot.status === "error") return snapshot;
		const artists = parseArtistsJson(snapshot.value.artists, "getCurrentlyPlaying.parseArtists");
		if (artists.status === "error") return artists;
		return Result.ok({ track: toQueuedTrack(snapshot.value, artists.value), position: 0 });
	}

	/**
	 * Get queue items (position > 0)
	 * Uses denormalized attribution from snapshot
	 * Priority: user-requested (FIFO by requestedAt) → autoplay (Spotify order)
	 */
	@rpc
	async getSongQueue(limit = 50): Promise<Result<QueueResult, SongQueueError>> {
		const parsedLimit = SongQueueLimitSchema.safeParse(limit);
		if (!parsedLimit.success)
			return Result.err(
				new SongQueueParseError({
					boundary: "rpc-input",
					operation: "getSongQueue",
					parseError: parsedLimit.error.message,
				}),
			);
		await this.ensureFresh();
		const readResult = await Result.tryPromise({
			try: () =>
				this.db
					.select()
					.from(spotifyQueueSnapshot)
					.where(gt(spotifyQueueSnapshot.position, 0))
					.orderBy(asc(spotifyQueueSnapshot.position)),
			catch: (cause) => new SongQueueDbError({ operation: "getSongQueue.findSnapshots", cause }),
		});
		if (readResult.status === "error") return readResult;
		const userTracks: Extract<QueuedTrack, { source: "user" }>[] = [];
		const autoplayTracks: Extract<QueuedTrack, { source: "autoplay" }>[] = [];
		for (const record of readResult.value) {
			const snapshot = parseSnapshotRecord(record, "getSongQueue.parseSnapshot");
			if (snapshot.status === "error") return snapshot;
			const artists = parseArtistsJson(snapshot.value.artists, "getSongQueue.parseArtists");
			if (artists.status === "error") return artists;
			const track = toQueuedTrack(snapshot.value, artists.value);
			if (track.source === "user") userTracks.push(track);
			else autoplayTracks.push(track);
		}
		userTracks.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
		return Result.ok({
			tracks: [...userTracks, ...autoplayTracks].slice(0, parsedLimit.data),
			totalCount: readResult.value.length,
		});
	}

	/**
	 * Get request history with pagination and filters
	 */
	@rpc
	async getRequestHistory(
		limit = 50,
		offset = 0,
		since?: string,
		until?: string,
	): Promise<Result<RequestHistoryResult, SongQueueError>> {
		const parsedQuery = RequestHistoryQuerySchema.safeParse({ limit, offset, since, until });
		if (!parsedQuery.success)
			return Result.err(
				new SongQueueParseError({
					boundary: "rpc-input",
					operation: "getRequestHistory",
					parseError: parsedQuery.error.message,
				}),
			);
		const conditions = [];
		if (parsedQuery.data.since !== undefined)
			conditions.push(gte(requestHistory.fulfilledAt, parsedQuery.data.since));
		if (parsedQuery.data.until !== undefined)
			conditions.push(lte(requestHistory.fulfilledAt, parsedQuery.data.until));
		const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
		const readResult = await Result.tryPromise({
			try: async () =>
				Promise.all([
					this.db
						.select()
						.from(requestHistory)
						.where(whereClause)
						.orderBy(desc(requestHistory.fulfilledAt))
						.limit(parsedQuery.data.limit)
						.offset(parsedQuery.data.offset),
					this.db.select({ count: count() }).from(requestHistory).where(whereClause),
				]),
			catch: (cause) => new SongQueueDbError({ operation: "getRequestHistory", cause }),
		});
		if (readResult.status === "error") return readResult;
		const requests: RequestHistoryItem[] = [];
		for (const record of readResult.value[0]) {
			const parsed = parseHistoryRecord(record, "getRequestHistory.parseRecord");
			if (parsed.status === "error") return parsed;
			requests.push(parsed.value);
		}
		return Result.ok({ requests, totalCount: readResult.value[1][0]?.count ?? 0 });
	}

	/**
	 * Get count of fulfilled requests since a given timestamp
	 */
	@rpc
	async getSessionRequestCount(since: string): Promise<Result<number, SongQueueError>> {
		const parsedSince = parseRpcInput(SongQueueInstantSchema, since, "getSessionRequestCount");
		if (parsedSince.status === "error") return parsedSince;
		return Result.tryPromise({
			try: async () => {
				const countRows = await this.db
					.select({ count: count() })
					.from(requestHistory)
					.where(gte(requestHistory.fulfilledAt, since));

				return countRows[0]?.count ?? 0;
			},
			catch: (cause) => new SongQueueDbError({ operation: "getSessionRequestCount", cause }),
		});
	}

	/**
	 * Get total count of fulfilled requests by a specific user
	 */
	@rpc
	async getUserRequestCount(userId: string): Promise<Result<number, SongQueueError>> {
		const parsedUserId = parseRpcInput(SongQueueDomainIdSchema, userId, "getUserRequestCount");
		if (parsedUserId.status === "error") return parsedUserId;
		return Result.tryPromise({
			try: async () => {
				const countRows = await this.db
					.select({ count: count() })
					.from(requestHistory)
					.where(eq(requestHistory.requesterUserId, userId));

				return countRows[0]?.count ?? 0;
			},
			catch: (cause) =>
				new SongQueueDbError({ operation: `getUserRequestCount(${userId})`, cause }),
		});
	}

	/**
	 * Get total count of fulfilled requests by a user's display name
	 */
	@rpc
	async getUserRequestCountByDisplayName(
		displayName: string,
	): Promise<Result<number, SongQueueError>> {
		const parsedDisplayName = parseRpcInput(
			SongQueueDisplayTextSchema,
			displayName,
			"getUserRequestCountByDisplayName",
		);
		if (parsedDisplayName.status === "error") return parsedDisplayName;
		return Result.tryPromise({
			try: async () => {
				const countRows = await this.db
					.select({ count: count() })
					.from(requestHistory)
					.where(eq(requestHistory.requesterDisplayName, parsedDisplayName.value));

				return countRows[0]?.count ?? 0;
			},
			catch: (cause) =>
				new SongQueueDbError({
					operation: `getUserRequestCountByDisplayName(${displayName})`,
					cause,
				}),
		});
	}

	/**
	 * Get top tracks by request count
	 */
	@rpc
	async getTopTracks(limit = 10): Promise<Result<TopTrack[], SongQueueError>> {
		return this.getTopTracksForViewer(undefined, limit);
	}

	/**
	 * Get top tracks by specific user
	 */
	@rpc
	async getTopTracksByUser(
		userId: string,
		limit = 10,
	): Promise<Result<TopTrack[], SongQueueError>> {
		const parsedUserId = parseRpcInput(SongQueueDomainIdSchema, userId, "getTopTracksByUser");
		if (parsedUserId.status === "error") return parsedUserId;
		return this.getTopTracksForViewer(parsedUserId.value, limit);
	}

	private async getTopTracksForViewer(
		userId: string | undefined,
		limit: number,
	): Promise<Result<TopTrack[], SongQueueError>> {
		const parsedLimit = SongQueueLimitSchema.safeParse(limit);
		if (!parsedLimit.success)
			return Result.err(
				new SongQueueParseError({
					boundary: "rpc-input",
					operation: "getTopTracks",
					parseError: parsedLimit.error.message,
				}),
			);
		const result = await Result.tryPromise({
			// SQLite's single MAX aggregate selects bare metadata columns from that latest row.
			try: () =>
				this.db
					.select({
						trackId: requestHistory.trackId,
						trackName: requestHistory.trackName,
						artists: requestHistory.artists,
						latestFulfilledAt: max(requestHistory.fulfilledAt),
						requestCount: count(),
					})
					.from(requestHistory)
					.where(userId === undefined ? undefined : eq(requestHistory.requesterUserId, userId))
					.groupBy(requestHistory.trackId)
					.orderBy(desc(count()), asc(requestHistory.trackId))
					.limit(parsedLimit.data),
			catch: (cause) =>
				new SongQueueDbError({
					operation: userId === undefined ? "getTopTracks" : "getTopTracksByUser",
					cause,
				}),
		});
		if (result.status === "error") return result;
		const tracks: TopTrack[] = [];
		for (const row of result.value) {
			const artists = parseArtistsJson(row.artists, "getTopTracks.parseArtists");
			if (artists.status === "error") return artists;
			tracks.push({
				trackId: row.trackId,
				trackName: row.trackName,
				artists: artists.value,
				requestCount: row.requestCount,
			});
		}
		return Result.ok(tracks);
	}

	/**
	 * Get top requesters by request count
	 */
	@rpc
	async getTopRequesters(limit = 10): Promise<Result<TopRequester[], SongQueueError>> {
		const parsedLimit = SongQueueLimitSchema.safeParse(limit);
		if (!parsedLimit.success)
			return Result.err(
				new SongQueueParseError({
					boundary: "rpc-input",
					operation: "getTopRequesters",
					parseError: parsedLimit.error.message,
				}),
			);
		const result = await Result.tryPromise({
			// SQLite's single MAX aggregate selects the display name from the latest Viewer row.
			try: () =>
				this.db
					.select({
						userId: requestHistory.requesterUserId,
						displayName: requestHistory.requesterDisplayName,
						latestFulfilledAt: max(requestHistory.fulfilledAt),
						requestCount: count(),
					})
					.from(requestHistory)
					.groupBy(requestHistory.requesterUserId)
					.orderBy(desc(count()), asc(requestHistory.requesterUserId))
					.limit(parsedLimit.data),
			catch: (cause) => new SongQueueDbError({ operation: "getTopRequesters", cause }),
		});
		if (result.status === "error") return result;
		return Result.ok(
			result.value.map((row) => ({
				userId: row.userId,
				displayName: row.displayName,
				requestCount: row.requestCount,
			})),
		);
	}

	/**
	 * Check if user has recent duplicate request (spam prevention)
	 * Returns true if duplicate found within time window
	 */
	@rpc
	async checkDuplicateRequest(
		userId: string,
		trackId: string,
		windowMinutes = 30,
	): Promise<Result<boolean, SongQueueError>> {
		const parsedUserId = parseRpcInput(
			SongQueueDomainIdSchema,
			userId,
			"checkDuplicateRequest.userId",
		);
		if (parsedUserId.status === "error") return parsedUserId;
		const parsedTrackId = parseRpcInput(
			SongQueueDomainIdSchema,
			trackId,
			"checkDuplicateRequest.trackId",
		);
		if (parsedTrackId.status === "error") return parsedTrackId;
		const parsedWindow = parseRpcInput(
			SongQueueLimitSchema,
			windowMinutes,
			"checkDuplicateRequest.windowMinutes",
		);
		if (parsedWindow.status === "error") return parsedWindow;
		const windowStart = new Date(Date.now() - parsedWindow.value * 60 * 1000).toISOString();

		return Result.gen(async function* (this: _SongQueueDO) {
			const pendingMatch = yield* Result.await(
				Result.tryPromise({
					try: () =>
						this.db.query.pendingRequests.findFirst({
							where: and(
								eq(pendingRequests.requesterUserId, userId),
								eq(pendingRequests.trackId, trackId),
								gte(pendingRequests.requestedAt, windowStart),
							),
						}),
					catch: (cause) =>
						new SongQueueDbError({ operation: "checkDuplicateRequest.pending", cause }),
				}),
			);

			if (pendingMatch) {
				return Result.ok(true);
			}

			const historyMatch = yield* Result.await(
				Result.tryPromise({
					try: () =>
						this.db.query.requestHistory.findFirst({
							where: and(
								eq(requestHistory.requesterUserId, userId),
								eq(requestHistory.trackId, trackId),
								gte(requestHistory.fulfilledAt, windowStart),
							),
						}),
					catch: (cause) =>
						new SongQueueDbError({ operation: "checkDuplicateRequest.history", cause }),
				}),
			);

			return Result.ok(!!historyMatch);
		}, this);
	}

	/**
	 * Scheduled refresh callback.
	 * Keeps the snapshot warm while the queue has active work.
	 */
	async refreshQueueTick(_scheduledFor?: string): Promise<void> {
		if (this.state.refreshScheduleId !== null || this.state.refreshDueAt !== null) {
			this.updateState({
				refreshScheduleId: null,
				refreshDueAt: null,
			});
		}

		const result = await this.runSyncCycle();
		if (result.status === "error") {
			logger.error("Scheduled song queue refresh failed", {
				error: result.error,
				cause: result.error.cause,
				consecutiveSyncFailures: this.state.consecutiveSyncFailures,
			});
		}
	}

	/**
	 * Scheduled cleanup callback.
	 * Deletes stale pending requests even if no reads occur.
	 */
	async cleanupStalePendingTick(_scheduledFor?: string): Promise<void> {
		if (this.state.cleanupScheduleId !== null || this.state.cleanupDueAt !== null) {
			this.updateState({
				cleanupScheduleId: null,
				cleanupDueAt: null,
			});
		}

		const result = await this.cleanupStalePending();
		if (result.status === "error") {
			logger.error("Scheduled song queue cleanup failed", {
				error: result.error.message,
			});
		}

		const scheduleResult = await Result.tryPromise({
			try: () => this.restoreOrRecomputeSchedules(),
			catch: (cause) =>
				new SongQueueCoordinationError({
					operation: "cleanupStalePendingTick.restoreSchedules",
					cause,
				}),
		});
		if (scheduleResult.status === "error")
			logger.error("Scheduled Song Queue cleanup schedule repair failed", {
				error: scheduleResult.error,
			});
	}

	/** Ensure snapshot is fresh while preserving stale fallback on typed sync failures. */
	private async ensureFresh(): Promise<Result<void, never>> {
		const lastSyncAt = this.state.lastSyncAt;
		if (lastSyncAt !== null && Date.now() - new Date(lastSyncAt).getTime() < MAX_STALENESS_MS) {
			return Result.ok();
		}

		if (this.syncLock) {
			await this.syncLock.catch((cause: unknown) =>
				logger.error("Song Queue sync lock rejected, using stale data", { cause }),
			);
			return Result.ok();
		}

		this.syncLock = this.runSyncCycle();
		try {
			const result = await this.syncLock;
			if (result.status === "error")
				logger.error("Sync failed, using stale data", {
					error: result.error,
					cause: "cause" in result.error ? result.error.cause : undefined,
				});
		} finally {
			this.syncLock = null;
		}
		return Result.ok();
	}

	private async runSyncCycle(): Promise<Result<void, SongQueueError>> {
		const syncedAt = new Date().toISOString();
		const result = await this.syncFromSpotify(syncedAt);

		if (result.status === "ok") {
			this.updateState({
				lastSyncAt: syncedAt,
				consecutiveSyncFailures: 0,
			});
		} else {
			this.updateState({
				consecutiveSyncFailures: this.state.consecutiveSyncFailures + 1,
			});
		}

		const scheduleResult = await Result.tryPromise({
			try: () => this.restoreOrRecomputeSchedules(),
			catch: (cause) =>
				new SongQueueCoordinationError({ operation: "runSyncCycle.restoreSchedules", cause }),
		});
		return scheduleResult.status === "error" ? Result.err(scheduleResult.error) : result;
	}

	/**
	 * Sync queue snapshot from Spotify API.
	 * Queue API success is required before mutating the durable snapshot so stale
	 * fallback semantics are preserved when Spotify is unavailable.
	 */
	private async syncFromSpotify(syncedAt: string): Promise<Result<void, SongQueueError>> {
		const spotifyService = new SpotifyService(this.env);
		const [currentlyPlayingResult, queueResult] = await Promise.all([
			spotifyService.getCurrentlyPlaying(),
			spotifyService.getQueue(),
		]);
		if (queueResult.status === "error") {
			return Result.err(
				new SongQueueDbError({ operation: "syncFromSpotify.fetchQueue", cause: queueResult.error }),
			);
		}
		const queueCurrentTrack = queueResult.value.currently_playing
			? toTrackInfo(queueResult.value.currently_playing)
			: null;
		const currentTrack =
			currentlyPlayingResult.status === "ok" ? currentlyPlayingResult.value : queueCurrentTrack;
		const upcomingTracks = queueResult.value.queue.map(toTrackInfo);

		return Result.tryPromise({
			try: async () => {
				this.db.transaction((tx) => {
					const previousRows = tx
						.select()
						.from(spotifyQueueSnapshot)
						.orderBy(asc(spotifyQueueSnapshot.position))
						.all();
					const previousSnapshots: SpotifyQueueSnapshotRecord[] = [];
					for (const row of previousRows) {
						const parsed = SpotifyQueueSnapshotRecordSchema.safeParse(row);
						if (!parsed.success)
							throw new SongQueueParseError({
								boundary: "persistence",
								operation: "syncFromSpotify.parseSnapshot",
								parseError: parsed.error.message,
							});
						previousSnapshots.push(parsed.data);
					}
					const pendingRows = tx
						.select()
						.from(pendingRequests)
						.orderBy(asc(pendingRequests.requestedAt))
						.all();
					const allPending: PendingRequest[] = [];
					for (const row of pendingRows) {
						const parsed = PendingRequestRecordSchema.safeParse(row);
						if (!parsed.success)
							throw new SongQueueParseError({
								boundary: "persistence",
								operation: "syncFromSpotify.parsePending",
								parseError: parsed.error.message,
							});
						allPending.push(parsed.data);
					}

					const attributedItems = attributeSpotifyOccurrences(
						previousSnapshots,
						allPending,
						currentTrack,
						upcomingTracks,
					);
					const previousCurrent = previousSnapshots.find((snapshot) => snapshot.position === 0);
					const newCurrentEventId = attributedItems.find((item) => item.position === 0)?.eventId;
					if (previousCurrent?.eventId && previousCurrent.eventId !== newCurrentEventId) {
						const played = allPending.find(
							(request) => request.eventId === previousCurrent.eventId,
						);
						if (played) {
							tx.insert(requestHistory)
								.values({
									eventId: played.eventId,
									trackId: played.trackId,
									trackName: played.trackName,
									artists: played.artists,
									album: played.album,
									albumCoverUrl: played.albumCoverUrl,
									requesterUserId: played.requesterUserId,
									requesterDisplayName: played.requesterDisplayName,
									requestedAt: played.requestedAt,
									fulfilledAt: syncedAt,
								})
								.onConflictDoNothing()
								.run();
							tx.delete(pendingRequests).where(eq(pendingRequests.eventId, played.eventId)).run();
						}
					}

					tx.delete(spotifyQueueSnapshot).run();
					if (attributedItems.length > 0) {
						tx.insert(spotifyQueueSnapshot)
							.values(attributedItems.map((item) => ({ ...item, syncedAt })))
							.run();
					}
					const matchedEventIds = attributedItems.flatMap((item) =>
						item.eventId === null ? [] : [item.eventId],
					);
					if (matchedEventIds.length > 0) {
						tx.update(pendingRequests)
							.set({ lastSeenInSpotifyAt: syncedAt })
							.where(inArray(pendingRequests.eventId, matchedEventIds))
							.run();
						tx.update(pendingRequests)
							.set({ firstSeenInSpotifyAt: syncedAt })
							.where(
								and(
									inArray(pendingRequests.eventId, matchedEventIds),
									isNull(pendingRequests.firstSeenInSpotifyAt),
								),
							)
							.run();
					}
					const droppedConditions = [isNotNull(pendingRequests.firstSeenInSpotifyAt)];
					if (matchedEventIds.length > 0)
						droppedConditions.push(notInArray(pendingRequests.eventId, matchedEventIds));
					tx.delete(pendingRequests)
						.where(and(...droppedConditions))
						.run();
					const oneHourAgo = new Date(new Date(syncedAt).getTime() - 60 * 60 * 1000).toISOString();
					tx.delete(pendingRequests).where(lt(pendingRequests.requestedAt, oneHourAgo)).run();
					logger.debug("Synced Spotify queue snapshot transaction", {
						queueSize: attributedItems.length,
						userRequests: matchedEventIds.length,
					});
				});
			},
			catch: (cause: unknown) =>
				cause instanceof SongQueueParseError
					? cause
					: new SongQueueDbError({ operation: "syncFromSpotify.transaction", cause }),
		});
	}

	/**
	 * Cleanup stale pending requests (TTL: 1 hour)
	 */
	private async cleanupStalePending(): Promise<Result<void, SongQueueDbError>> {
		const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

		return Result.tryPromise({
			try: async () => {
				const deleted = await this.db
					.delete(pendingRequests)
					.where(lt(pendingRequests.requestedAt, oneHourAgo))
					.returning({ eventId: pendingRequests.eventId });

				if (deleted.length > 0) {
					logger.info("Cleaned up stale pending requests", {
						count: deleted.length,
						eventIds: deleted.map((item) => item.eventId),
					});
				}
			},
			catch: (cause) => new SongQueueDbError({ operation: "cleanupStalePending", cause }),
		});
	}

	private hydrateLastSyncAtFromSnapshot(): void {
		if (this.state.lastSyncAt !== null) {
			return;
		}

		const snapshot = this.db.query.spotifyQueueSnapshot
			.findFirst({
				orderBy: asc(spotifyQueueSnapshot.position),
			})
			.sync();

		if (!snapshot) {
			return;
		}

		this.updateState({ lastSyncAt: snapshot.syncedAt });
	}

	private updateState(partial: Partial<SongQueueAgentState>): SongQueueAgentState {
		const nextState = { ...this.state, ...partial };
		this.setState(nextState);
		return nextState;
	}

	private async restoreOrRecomputeSchedules(): Promise<void> {
		await Promise.all([this.ensureRefreshSchedule(), this.ensureCleanupSchedule()]);
	}

	private async ensureRefreshSchedule(): Promise<void> {
		const hasActivity = await this.hasRefreshActivity();
		if (!hasActivity) {
			await this.clearRefreshSchedule();
			return;
		}

		if (
			this.state.refreshScheduleId !== null &&
			this.getSchedule(this.state.refreshScheduleId) !== undefined
		) {
			return;
		}

		await this.scheduleRefreshIn(this.getNextRefreshDelaySeconds());
	}

	private async ensureCleanupSchedule(): Promise<void> {
		const hasPending = await this.hasPendingRequests();
		if (!hasPending) {
			await this.clearCleanupSchedule();
			return;
		}

		if (
			this.state.cleanupScheduleId !== null &&
			this.getSchedule(this.state.cleanupScheduleId) !== undefined
		) {
			return;
		}

		await this.scheduleCleanupIn(CLEANUP_INTERVAL_SECONDS);
	}

	private getNextRefreshDelaySeconds(): number {
		if (this.state.consecutiveSyncFailures > 0) {
			const delaySeconds = Math.min(
				(MAX_STALENESS_MS / 1000) * Math.pow(2, this.state.consecutiveSyncFailures - 1),
				MAX_REFRESH_BACKOFF_SECONDS,
			);
			return Math.max(1, Math.ceil(delaySeconds));
		}

		if (this.state.lastSyncAt === null) {
			return REFRESH_AFTER_MUTATION_DELAY_SECONDS;
		}

		const lastSyncAgeMs = Date.now() - new Date(this.state.lastSyncAt).getTime();
		const remainingMs = Math.max(1000, MAX_STALENESS_MS - lastSyncAgeMs);
		return Math.max(1, Math.ceil(remainingMs / 1000));
	}

	private async hasRefreshActivity(): Promise<boolean> {
		const pendingCountRows = await this.db.select({ count: count() }).from(pendingRequests);
		if ((pendingCountRows[0]?.count ?? 0) > 0) {
			return true;
		}

		const snapshotCountRows = await this.db.select({ count: count() }).from(spotifyQueueSnapshot);
		return (snapshotCountRows[0]?.count ?? 0) > 0;
	}

	private async hasPendingRequests(): Promise<boolean> {
		const countRows = await this.db.select({ count: count() }).from(pendingRequests);
		return (countRows[0]?.count ?? 0) > 0;
	}

	private async scheduleRefreshIn(delaySeconds: number): Promise<void> {
		const normalizedDelaySeconds = Math.max(1, Math.ceil(delaySeconds));
		const dueAt = new Date(Date.now() + normalizedDelaySeconds * 1000).toISOString();

		await this.clearRefreshSchedule();
		const schedule = await this.schedule(normalizedDelaySeconds, "refreshQueueTick", dueAt, {
			idempotent: true,
			retry: { maxAttempts: 1 },
		});
		this.updateState({
			refreshScheduleId: schedule.id,
			refreshDueAt: dueAt,
		});
	}

	private async scheduleCleanupIn(delaySeconds: number): Promise<void> {
		const normalizedDelaySeconds = Math.max(1, Math.ceil(delaySeconds));
		const dueAt = new Date(Date.now() + normalizedDelaySeconds * 1000).toISOString();

		await this.clearCleanupSchedule();
		const schedule = await this.schedule(normalizedDelaySeconds, "cleanupStalePendingTick", dueAt, {
			idempotent: true,
			retry: { maxAttempts: 1 },
		});
		this.updateState({
			cleanupScheduleId: schedule.id,
			cleanupDueAt: dueAt,
		});
	}

	private async clearRefreshSchedule(): Promise<void> {
		const refreshSchedules = this.getSchedules().filter(
			(schedule) => schedule.callback === "refreshQueueTick",
		);
		await Promise.all(refreshSchedules.map((schedule) => this.cancelSchedule(schedule.id)));

		if (
			refreshSchedules.length > 0 ||
			this.state.refreshScheduleId !== null ||
			this.state.refreshDueAt !== null
		) {
			this.updateState({
				refreshScheduleId: null,
				refreshDueAt: null,
			});
		}
	}

	private async clearCleanupSchedule(): Promise<void> {
		const cleanupSchedules = this.getSchedules().filter(
			(schedule) => schedule.callback === "cleanupStalePendingTick",
		);
		await Promise.all(cleanupSchedules.map((schedule) => this.cancelSchedule(schedule.id)));

		if (
			cleanupSchedules.length > 0 ||
			this.state.cleanupScheduleId !== null ||
			this.state.cleanupDueAt !== null
		) {
			this.updateState({
				cleanupScheduleId: null,
				cleanupDueAt: null,
			});
		}
	}
}

export const SongQueueDO = withRpcSerialization(_SongQueueDO);
