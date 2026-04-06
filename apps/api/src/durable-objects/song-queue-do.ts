/**
 * SongQueueDO - Manages song request queue with Spotify sync
 *
 * Agent state owns only operational coordination for freshness and scheduling.
 * SQLite remains the durable source of truth for queue snapshots, pending
 * requests, and request history.
 */

import { Agent, type AgentContext } from "agents";
import { Result } from "better-result";
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
	notInArray,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/song-queue-do/migrations";
import { rpc, withRpcSerialization } from "../lib/durable-objects";
import { SongQueueDbError, SongRequestNotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";
import { SpotifyService, type SpotifyTrack, type TrackInfo } from "../services/spotify-service";
import * as schema from "./schemas/song-queue-do.schema";
import {
	type InsertPendingRequest,
	type PendingRequest,
	type RequestHistory,
	type TrackSource,
	pendingRequests,
	requestHistory,
	spotifyQueueSnapshot,
} from "./schemas/song-queue-do.schema";

import type { Env } from "../index";

const MAX_STALENESS_MS = 15_000;
const REFRESH_AFTER_MUTATION_DELAY_SECONDS = 1;
const CLEANUP_INTERVAL_SECONDS = 5 * 60;
const MAX_REFRESH_BACKOFF_SECONDS = 5 * 60;

/**
 * Track info with requester attribution
 */
export interface QueuedTrack extends TrackInfo {
	requesterUserId: string;
	requesterDisplayName: string;
	requestedAt: string;
}

/**
 * Currently playing track (position 0)
 */
export interface CurrentlyPlayingResult {
	track: QueuedTrack | null;
	position: number; // Always 0
}

/**
 * Queue items (position > 0)
 */
export interface QueueResult {
	tracks: QueuedTrack[];
	totalCount: number;
}

/**
 * Request history with pagination
 */
export interface RequestHistoryResult {
	requests: RequestHistory[];
	totalCount: number;
}

/**
 * Top track aggregation
 */
export interface TopTrack {
	trackId: string;
	trackName: string;
	artists: string;
	requestCount: number;
}

/**
 * Top requester aggregation
 */
export interface TopRequester {
	userId: string;
	displayName: string;
	requestCount: number;
}

interface SongQueueAgentState {
	lastSyncAt: string | null;
	refreshScheduleId: string | null;
	refreshDueAt: string | null;
	cleanupScheduleId: string | null;
	cleanupDueAt: string | null;
	consecutiveSyncFailures: number;
}

const ArtistNamesSchema = z.array(z.string());

function parseArtistsJson(artistsJson: string): string[] {
	return ArtistNamesSchema.parse(JSON.parse(artistsJson));
}

function toQueuedTrack(snapshot: schema.SpotifyQueueSnapshotItem, artists: string[]): QueuedTrack {
	return {
		id: snapshot.trackId,
		name: snapshot.trackName,
		artists,
		album: snapshot.album,
		albumCoverUrl: snapshot.albumCoverUrl,
		requesterUserId: snapshot.requesterUserId ?? "unknown",
		requesterDisplayName: snapshot.requesterDisplayName ?? "Unknown",
		requestedAt: snapshot.requestedAt ?? snapshot.syncedAt,
	};
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

/**
 * SongQueueDO - Agent-native coordinator for song request queue management
 */
class _SongQueueDO extends Agent<Env, SongQueueAgentState> {
	private db: ReturnType<typeof drizzle<typeof schema>>;
	private syncLock: Promise<Result<void, SongQueueDbError>> | null = null;

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

	/**
	 * Persist a song request (idempotent via event_id)
	 * Invalidates cache and schedules a near-term refresh.
	 */
	@rpc
	async persistRequest(request: InsertPendingRequest): Promise<Result<void, SongQueueDbError>> {
		const result = await Result.tryPromise({
			try: () => this.db.insert(pendingRequests).values(request).onConflictDoNothing(),
			catch: (cause) =>
				new SongQueueDbError({ operation: `persistRequest(${request.eventId})`, cause }),
		});

		if (result.status === "error") {
			return Result.err(result.error);
		}

		logger.info("Persisted song request", {
			eventId: request.eventId,
			trackId: request.trackId,
			trackName: request.trackName,
		});

		this.updateState({ lastSyncAt: null });
		await this.scheduleRefreshIn(REFRESH_AFTER_MUTATION_DELAY_SECONDS).catch((error: unknown) => {
			logger.error("Failed to schedule song queue refresh after persistRequest", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		await this.ensureCleanupSchedule().catch((error: unknown) => {
			logger.error("Failed to schedule song queue cleanup after persistRequest", {
				error: error instanceof Error ? error.message : String(error),
			});
		});

		return Result.ok();
	}

	/**
	 * Delete a request (for rollback)
	 */
	@rpc
	async deleteRequest(eventId: string): Promise<Result<void, SongQueueDbError>> {
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
	async deleteHistory(eventId: string): Promise<Result<void, SongQueueDbError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db.delete(requestHistory).where(eq(requestHistory.eventId, eventId));
				logger.info("Deleted history entry", { eventId });
			},
			catch: (cause) => new SongQueueDbError({ operation: `deleteHistory(${eventId})`, cause }),
		});
	}

	/**
	 * Write request to history (after fulfilled)
	 * Note: DO output gates guarantee atomicity for all writes in a single RPC call
	 */
	@rpc
	async writeHistory(
		eventId: string,
		fulfilledAt: string,
	): Promise<Result<void, SongQueueDbError | SongRequestNotFoundError>> {
		return Result.gen(async function* (this: _SongQueueDO) {
			const request = yield* Result.await(
				Result.tryPromise({
					try: () =>
						this.db.query.pendingRequests.findFirst({
							where: eq(pendingRequests.eventId, eventId),
						}),
					catch: (cause) =>
						new SongQueueDbError({ operation: `writeHistory.findRequest(${eventId})`, cause }),
				}),
			);

			if (!request) {
				return Result.err(new SongRequestNotFoundError({ eventId }));
			}

			yield* Result.await(
				Result.tryPromise({
					try: async () => {
						await this.db.insert(requestHistory).values({
							eventId: request.eventId,
							trackId: request.trackId,
							trackName: request.trackName,
							artists: request.artists,
							album: request.album,
							albumCoverUrl: request.albumCoverUrl,
							requesterUserId: request.requesterUserId,
							requesterDisplayName: request.requesterDisplayName,
							requestedAt: request.requestedAt,
							fulfilledAt,
						});
						await this.db.delete(pendingRequests).where(eq(pendingRequests.eventId, eventId));
						await this.restoreOrRecomputeSchedules();
					},
					catch: (cause) =>
						new SongQueueDbError({ operation: `writeHistory.persist(${eventId})`, cause }),
				}),
			);

			logger.info("Wrote request to history", { eventId, fulfilledAt });
			return Result.ok();
		}, this);
	}

	/**
	 * Get currently playing track (position 0)
	 * Uses denormalized attribution from snapshot (no join needed)
	 */
	@rpc
	async getCurrentlyPlaying(): Promise<Result<CurrentlyPlayingResult, SongQueueDbError>> {
		await this.ensureFresh();

		return Result.tryPromise({
			try: async () => {
				const snapshot = await this.db.query.spotifyQueueSnapshot.findFirst({
					where: eq(spotifyQueueSnapshot.position, 0),
				});

				if (!snapshot) {
					return { track: null, position: 0 };
				}

				return {
					track: toQueuedTrack(snapshot, parseArtistsJson(snapshot.artists)),
					position: 0,
				};
			},
			catch: (cause) =>
				new SongQueueDbError({ operation: "getCurrentlyPlaying.findSnapshot", cause }),
		});
	}

	/**
	 * Get queue items (position > 0)
	 * Uses denormalized attribution from snapshot
	 * Priority: user-requested (FIFO by requestedAt) → autoplay (Spotify order)
	 */
	@rpc
	async getSongQueue(limit = 50): Promise<Result<QueueResult, SongQueueDbError>> {
		await this.ensureFresh();

		return Result.tryPromise({
			try: async () => {
				const snapshots = await this.db
					.select()
					.from(spotifyQueueSnapshot)
					.where(gt(spotifyQueueSnapshot.position, 0))
					.orderBy(desc(spotifyQueueSnapshot.source), asc(spotifyQueueSnapshot.position));

				const userTracks: QueuedTrack[] = [];
				const autoplayTracks: QueuedTrack[] = [];

				for (const snapshot of snapshots) {
					const track = toQueuedTrack(snapshot, parseArtistsJson(snapshot.artists));
					if (snapshot.source === "user") {
						userTracks.push(track);
						continue;
					}

					autoplayTracks.push(track);
				}

				userTracks.sort((left, right) => {
					return new Date(left.requestedAt).getTime() - new Date(right.requestedAt).getTime();
				});

				return {
					tracks: [...userTracks, ...autoplayTracks].slice(0, limit),
					totalCount: snapshots.length,
				};
			},
			catch: (cause) => new SongQueueDbError({ operation: "getSongQueue", cause }),
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
	): Promise<Result<RequestHistoryResult, SongQueueDbError>> {
		const conditions = [];
		if (since) {
			conditions.push(gte(requestHistory.fulfilledAt, since));
		}
		if (until) {
			conditions.push(lte(requestHistory.fulfilledAt, until));
		}
		const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

		return Result.gen(async function* (this: _SongQueueDO) {
			const requests = yield* Result.await(
				Result.tryPromise({
					try: () =>
						this.db
							.select()
							.from(requestHistory)
							.where(whereClause)
							.orderBy(desc(requestHistory.fulfilledAt))
							.limit(limit)
							.offset(offset),
					catch: (cause) => new SongQueueDbError({ operation: "getRequestHistory.find", cause }),
				}),
			);

			const countRows = yield* Result.await(
				Result.tryPromise({
					try: () => this.db.select({ count: count() }).from(requestHistory).where(whereClause),
					catch: (cause) => new SongQueueDbError({ operation: "getRequestHistory.count", cause }),
				}),
			);

			const totalCount = countRows[0]?.count ?? 0;
			return Result.ok({ requests, totalCount });
		}, this);
	}

	/**
	 * Get count of fulfilled requests since a given timestamp
	 */
	@rpc
	async getSessionRequestCount(since: string): Promise<Result<number, SongQueueDbError>> {
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
	async getUserRequestCount(userId: string): Promise<Result<number, SongQueueDbError>> {
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
	): Promise<Result<number, SongQueueDbError>> {
		return Result.tryPromise({
			try: async () => {
				const countRows = await this.db
					.select({ count: count() })
					.from(requestHistory)
					.where(eq(requestHistory.requesterDisplayName, displayName));

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
	async getTopTracks(limit = 10): Promise<Result<TopTrack[], SongQueueDbError>> {
		const result = await Result.tryPromise({
			try: () =>
				this.db
					.select({
						trackId: requestHistory.trackId,
						trackName: requestHistory.trackName,
						artists: requestHistory.artists,
						requestCount: count(),
					})
					.from(requestHistory)
					.groupBy(requestHistory.trackId, requestHistory.trackName, requestHistory.artists)
					.orderBy(desc(count()))
					.limit(limit),
			catch: (cause) => new SongQueueDbError({ operation: "getTopTracks", cause }),
		});

		if (result.status === "error") {
			logger.error("Failed to get top tracks", { error: result.error.message });
		}
		return result;
	}

	/**
	 * Get top tracks by specific user
	 */
	@rpc
	async getTopTracksByUser(
		userId: string,
		limit = 10,
	): Promise<Result<TopTrack[], SongQueueDbError>> {
		const result = await Result.tryPromise({
			try: () =>
				this.db
					.select({
						trackId: requestHistory.trackId,
						trackName: requestHistory.trackName,
						artists: requestHistory.artists,
						requestCount: count(),
					})
					.from(requestHistory)
					.where(eq(requestHistory.requesterUserId, userId))
					.groupBy(requestHistory.trackId, requestHistory.trackName, requestHistory.artists)
					.orderBy(desc(count()))
					.limit(limit),
			catch: (cause) => new SongQueueDbError({ operation: `getTopTracksByUser(${userId})`, cause }),
		});

		if (result.status === "error") {
			logger.error("Failed to get top tracks by user", { error: result.error.message, userId });
		}
		return result;
	}

	/**
	 * Get top requesters by request count
	 */
	@rpc
	async getTopRequesters(limit = 10): Promise<Result<TopRequester[], SongQueueDbError>> {
		const result = await Result.tryPromise({
			try: () =>
				this.db
					.select({
						userId: requestHistory.requesterUserId,
						displayName: requestHistory.requesterDisplayName,
						requestCount: count(),
					})
					.from(requestHistory)
					.groupBy(requestHistory.requesterUserId, requestHistory.requesterDisplayName)
					.orderBy(desc(count()))
					.limit(limit),
			catch: (cause) => new SongQueueDbError({ operation: "getTopRequesters", cause }),
		});

		if (result.status === "error") {
			logger.error("Failed to get top requesters", { error: result.error.message });
		}
		return result;
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
	): Promise<Result<boolean, SongQueueDbError>> {
		const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

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
				error: result.error.message,
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

		await this.restoreOrRecomputeSchedules();
	}

	/**
	 * Ensure snapshot is fresh with stale fallback on sync failure.
	 */
	private async ensureFresh(): Promise<Result<void, never>> {
		const lastSyncAt = this.state.lastSyncAt;
		if (lastSyncAt !== null && Date.now() - new Date(lastSyncAt).getTime() < MAX_STALENESS_MS) {
			return Result.ok();
		}

		if (this.syncLock) {
			await this.syncLock;
			return Result.ok();
		}

		this.syncLock = this.runSyncCycle();

		const result = await this.syncLock;
		this.syncLock = null;

		if (result.status === "error") {
			logger.error("Sync failed, using stale data", { error: result.error.message });
		}

		return Result.ok();
	}

	private async runSyncCycle(): Promise<Result<void, SongQueueDbError>> {
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

		await this.restoreOrRecomputeSchedules();
		return result;
	}

	/**
	 * Sync queue snapshot from Spotify API.
	 * Queue API success is required before mutating the durable snapshot so stale
	 * fallback semantics are preserved when Spotify is unavailable.
	 */
	private async syncFromSpotify(syncedAt: string): Promise<Result<void, SongQueueDbError>> {
		const spotifyService = new SpotifyService(this.env);

		const previousPos0Result = await Result.tryPromise({
			try: () =>
				this.db.query.spotifyQueueSnapshot.findFirst({
					where: eq(spotifyQueueSnapshot.position, 0),
				}),
			catch: (cause) => new SongQueueDbError({ operation: "syncFromSpotify.getPrevious", cause }),
		});

		const previousSnapshot =
			previousPos0Result.status === "ok" ? previousPos0Result.value : undefined;

		const allPendingResult = await Result.tryPromise({
			try: () => this.db.select().from(pendingRequests).orderBy(asc(pendingRequests.requestedAt)),
			catch: (cause) => new SongQueueDbError({ operation: "syncFromSpotify.getAllPending", cause }),
		});

		if (allPendingResult.status === "error") {
			return allPendingResult;
		}

		const pendingByTrackId = new Map<string, PendingRequest[]>();
		for (const request of allPendingResult.value) {
			const pool = pendingByTrackId.get(request.trackId);
			if (pool) {
				pool.push(request);
			} else {
				pendingByTrackId.set(request.trackId, [request]);
			}
		}

		const [currentlyPlayingResult, queueResult] = await Promise.all([
			spotifyService.getCurrentlyPlaying(),
			spotifyService.getQueue(),
		]);

		if (queueResult.status === "error") {
			return Result.err(
				new SongQueueDbError({
					operation: "syncFromSpotify.fetchQueue",
					cause: new Error(queueResult.error.message),
				}),
			);
		}

		type AttributedItem = {
			position: number;
			trackId: string;
			trackName: string;
			artists: string;
			album: string;
			albumCoverUrl: string | null;
			source: TrackSource;
			eventId: string | null;
			requesterUserId: string | null;
			requesterDisplayName: string | null;
			requestedAt: string | null;
		};

		const attributedItems: AttributedItem[] = [];
		const matchedEventIds: string[] = [];

		const popPending = (trackId: string): PendingRequest | undefined => {
			const pool = pendingByTrackId.get(trackId);
			if (pool && pool.length > 0) {
				return pool.shift();
			}
			return undefined;
		};

		const queueCurrentTrack = queueResult.value.currently_playing
			? toTrackInfo(queueResult.value.currently_playing)
			: null;
		const currentTrack =
			currentlyPlayingResult.status === "ok" ? currentlyPlayingResult.value : queueCurrentTrack;

		if (currentTrack) {
			const pending = popPending(currentTrack.id);

			attributedItems.push({
				position: 0,
				trackId: currentTrack.id,
				trackName: currentTrack.name,
				artists: JSON.stringify(currentTrack.artists),
				album: currentTrack.album,
				albumCoverUrl: currentTrack.albumCoverUrl,
				source: pending ? "user" : "autoplay",
				eventId: pending?.eventId ?? null,
				requesterUserId: pending?.requesterUserId ?? null,
				requesterDisplayName: pending?.requesterDisplayName ?? null,
				requestedAt: pending?.requestedAt ?? null,
			});

			if (pending) {
				matchedEventIds.push(pending.eventId);
			}
		}

		for (let index = 0; index < queueResult.value.queue.length; index++) {
			const rawTrack = queueResult.value.queue[index];
			if (!rawTrack) {
				continue;
			}

			const track = toTrackInfo(rawTrack);
			const pending = popPending(track.id);

			attributedItems.push({
				position: index + 1,
				trackId: track.id,
				trackName: track.name,
				artists: JSON.stringify(track.artists),
				album: track.album,
				albumCoverUrl: track.albumCoverUrl,
				source: pending ? "user" : "autoplay",
				eventId: pending?.eventId ?? null,
				requesterUserId: pending?.requesterUserId ?? null,
				requesterDisplayName: pending?.requesterDisplayName ?? null,
				requestedAt: pending?.requestedAt ?? null,
			});

			if (pending) {
				matchedEventIds.push(pending.eventId);
			}
		}

		const newPos0EventId = attributedItems.find((item) => item.position === 0)?.eventId;
		const reconcilePlayedResult = await this.reconcilePlayed(previousSnapshot, newPos0EventId);
		if (reconcilePlayedResult.status === "error") {
			logger.error("Failed to reconcile played track", {
				error: reconcilePlayedResult.error.message,
			});
		}

		return Result.gen(async function* (this: _SongQueueDO) {
			yield* Result.await(
				Result.tryPromise({
					try: () => this.db.delete(spotifyQueueSnapshot),
					catch: (cause) => new SongQueueDbError({ operation: "syncFromSpotify.clear", cause }),
				}),
			);

			for (const item of attributedItems) {
				yield* Result.await(
					Result.tryPromise({
						try: () =>
							this.db.insert(spotifyQueueSnapshot).values({
								...item,
								syncedAt,
							}),
						catch: (cause) =>
							new SongQueueDbError({
								operation: `syncFromSpotify.insert[${item.position}]`,
								cause,
							}),
					}),
				);
			}

			if (matchedEventIds.length > 0) {
				yield* Result.await(
					Result.tryPromise({
						try: async () => {
							await this.db
								.update(pendingRequests)
								.set({ lastSeenInSpotifyAt: syncedAt })
								.where(inArray(pendingRequests.eventId, matchedEventIds));

							await this.db
								.update(pendingRequests)
								.set({ firstSeenInSpotifyAt: syncedAt })
								.where(
									and(
										inArray(pendingRequests.eventId, matchedEventIds),
										isNull(pendingRequests.firstSeenInSpotifyAt),
									),
								);
						},
						catch: (cause) =>
							new SongQueueDbError({ operation: "syncFromSpotify.updateSeen", cause }),
					}),
				);
			}

			logger.debug("Synced Spotify queue snapshot", {
				queueSize: attributedItems.length,
				userRequests: matchedEventIds.length,
			});

			const [reconcileDroppedResult, cleanupResult] = await Promise.all([
				this.reconcileDropped(matchedEventIds),
				this.cleanupStalePending(),
			]);
			if (reconcileDroppedResult.status === "error") {
				logger.error("Failed to reconcile dropped tracks", {
					error: reconcileDroppedResult.error.message,
				});
			}

			if (cleanupResult.status === "error") {
				logger.error("Failed to cleanup stale pending", {
					error: cleanupResult.error.message,
				});
			}

			return Result.ok();
		}, this);
	}

	/**
	 * Reconcile played track - move from pending to history when position 0 changes
	 */
	private async reconcilePlayed(
		previousSnapshot: schema.SpotifyQueueSnapshotItem | undefined,
		newEventId: string | null | undefined,
	): Promise<Result<void, SongQueueDbError>> {
		if (!previousSnapshot) {
			return Result.ok();
		}

		if (!previousSnapshot.eventId) {
			return Result.ok();
		}

		if (previousSnapshot.eventId === newEventId) {
			return Result.ok();
		}

		const eventId = previousSnapshot.eventId;

		return Result.gen(async function* (this: _SongQueueDO) {
			const pending = yield* Result.await(
				Result.tryPromise({
					try: () =>
						this.db.query.pendingRequests.findFirst({
							where: eq(pendingRequests.eventId, eventId),
						}),
					catch: (cause) =>
						new SongQueueDbError({ operation: "reconcilePlayed.findPending", cause }),
				}),
			);

			if (!pending) {
				return Result.ok();
			}

			const fulfilledAt = new Date().toISOString();
			yield* Result.await(
				Result.tryPromise({
					try: async () => {
						await this.db.insert(requestHistory).values({
							eventId: pending.eventId,
							trackId: pending.trackId,
							trackName: pending.trackName,
							artists: pending.artists,
							album: pending.album,
							albumCoverUrl: pending.albumCoverUrl,
							requesterUserId: pending.requesterUserId,
							requesterDisplayName: pending.requesterDisplayName,
							requestedAt: pending.requestedAt,
							fulfilledAt,
						});
						await this.db.delete(pendingRequests).where(eq(pendingRequests.eventId, eventId));
					},
					catch: (cause) =>
						new SongQueueDbError({ operation: "reconcilePlayed.moveToHistory", cause }),
				}),
			);

			logger.info("Reconciled played track", {
				eventId: pending.eventId,
				trackId: pending.trackId,
				requester: pending.requesterDisplayName,
			});

			return Result.ok();
		}, this);
	}

	/**
	 * Reconcile dropped tracks - delete pending requests no longer in queue.
	 */
	private async reconcileDropped(
		matchedEventIds: string[],
	): Promise<Result<void, SongQueueDbError>> {
		return Result.gen(async function* (this: _SongQueueDO) {
			const orphaned = yield* Result.await(
				Result.tryPromise({
					try: async () => {
						const conditions = [isNotNull(pendingRequests.firstSeenInSpotifyAt)];

						if (matchedEventIds.length > 0) {
							conditions.push(notInArray(pendingRequests.eventId, matchedEventIds));
						}

						return this.db
							.select({ eventId: pendingRequests.eventId, trackId: pendingRequests.trackId })
							.from(pendingRequests)
							.where(and(...conditions));
					},
					catch: (cause) =>
						new SongQueueDbError({ operation: "reconcileDropped.findOrphaned", cause }),
				}),
			);

			if (orphaned.length === 0) {
				return Result.ok();
			}

			const orphanedEventIds = orphaned.map((orphan) => orphan.eventId);
			yield* Result.await(
				Result.tryPromise({
					try: () =>
						this.db
							.delete(pendingRequests)
							.where(inArray(pendingRequests.eventId, orphanedEventIds)),
					catch: (cause) => new SongQueueDbError({ operation: "reconcileDropped.delete", cause }),
				}),
			);

			logger.info("Reconciled dropped tracks", {
				count: orphaned.length,
				trackIds: orphaned.map((orphan) => orphan.trackId),
			});

			return Result.ok();
		}, this);
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
		if (this.state.refreshScheduleId !== null) {
			await this.cancelSchedule(this.state.refreshScheduleId);
		}

		if (this.state.refreshScheduleId !== null || this.state.refreshDueAt !== null) {
			this.updateState({
				refreshScheduleId: null,
				refreshDueAt: null,
			});
		}
	}

	private async clearCleanupSchedule(): Promise<void> {
		if (this.state.cleanupScheduleId !== null) {
			await this.cancelSchedule(this.state.cleanupScheduleId);
		}

		if (this.state.cleanupScheduleId !== null || this.state.cleanupDueAt !== null) {
			this.updateState({
				cleanupScheduleId: null,
				cleanupDueAt: null,
			});
		}
	}
}

export const SongQueueDO = withRpcSerialization(_SongQueueDO);
