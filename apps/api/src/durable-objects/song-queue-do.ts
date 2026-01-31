/**
 * SongQueueDO - Manages song request queue with Spotify sync
 *
 * Maintains pending requests and syncs with Spotify queue state.
 * Implements ensureFresh pattern with backoff and stale fallback.
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
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

import migrations from "../../drizzle/song-queue-do/migrations";
import { SongQueueDbError, SongRequestNotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";
import { SpotifyService, type TrackInfo } from "../services/spotify-service";
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

/**
 * SongQueueDO - Durable Object for song request queue management
 */
export class SongQueueDO extends DurableObject<Env> {
	private db: ReturnType<typeof drizzle<typeof schema>>;
	private lastSyncAt: number | null = null;
	private syncLock: Promise<Result<void, SongQueueDbError>> | null = null;
	/** Per-user streak tracking for session achievements - reset on stream online */
	private sessionStreaks: Map<string, number> = new Map();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });

		void this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	/**
	 * Persist a song request (idempotent via event_id)
	 * Invalidates cache so next read triggers fresh sync
	 */
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

		// Invalidate cache - next read triggers sync via ensureFresh
		this.lastSyncAt = null;

		return Result.ok();
	}

	/**
	 * Delete a request (for rollback)
	 */
	async deleteRequest(eventId: string): Promise<Result<void, SongQueueDbError>> {
		return Result.tryPromise({
			try: async () => {
				await this.db.delete(pendingRequests).where(eq(pendingRequests.eventId, eventId));
				logger.info("Deleted song request", { eventId });
			},
			catch: (cause) => new SongQueueDbError({ operation: `deleteRequest(${eventId})`, cause }),
		});
	}

	/**
	 * Delete a history entry (for rollback)
	 */
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
	async writeHistory(
		eventId: string,
		fulfilledAt: string,
	): Promise<Result<void, SongQueueDbError | SongRequestNotFoundError>> {
		return Result.gen(async function* (this: SongQueueDO) {
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

			// Insert into history + delete from pending (atomic via DO output gates)
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
	async getCurrentlyPlaying(): Promise<Result<CurrentlyPlayingResult, SongQueueDbError>> {
		// Ensure fresh snapshot (always returns ok w/ stale fallback)
		await this.ensureFresh();

		return Result.tryPromise({
			try: async () => {
				const snapshot = await this.db.query.spotifyQueueSnapshot.findFirst({
					where: eq(spotifyQueueSnapshot.position, 0),
				});

				if (!snapshot) {
					return { track: null, position: 0 };
				}

				// Use denormalized attribution from snapshot
				const track: QueuedTrack = {
					id: snapshot.trackId,
					name: snapshot.trackName,
					artists: JSON.parse(snapshot.artists) as string[],
					album: snapshot.album,
					albumCoverUrl: snapshot.albumCoverUrl,
					requesterUserId: snapshot.requesterUserId ?? "unknown",
					requesterDisplayName: snapshot.requesterDisplayName ?? "Unknown",
					requestedAt: snapshot.requestedAt ?? snapshot.syncedAt,
				};

				return { track, position: 0 };
			},
			catch: (cause) =>
				new SongQueueDbError({ operation: "getCurrentlyPlaying.findSnapshot", cause }),
		});
	}

	/**
	 * Get queue items (position > 0)
	 * Uses denormalized attribution from snapshot
	 * Priority: user-requested (FIFO by requestedAt) → autoplay (Spotify order)
	 *
	 * ORDER BY source DESC puts 'user' before 'autoplay' (lexicographic)
	 * For user requests: secondary sort by requestedAt ASC (FIFO)
	 * For autoplay: secondary sort by position ASC (Spotify order)
	 */
	async getQueue(limit = 50): Promise<Result<QueueResult, SongQueueDbError>> {
		// Ensure fresh snapshot (always returns ok w/ stale fallback)
		await this.ensureFresh();

		return Result.tryPromise({
			try: async () => {
				const snapshots = await this.db
					.select()
					.from(spotifyQueueSnapshot)
					.where(gt(spotifyQueueSnapshot.position, 0))
					// source DESC: 'user' > 'autoplay' lexicographically
					// Then by position for stable ordering within groups
					.orderBy(desc(spotifyQueueSnapshot.source), asc(spotifyQueueSnapshot.position));

				// Split into user and autoplay for proper secondary sorting
				const userSnapshots = snapshots.filter((s) => s.source === "user");
				const autoplaySnapshots = snapshots.filter((s) => s.source === "autoplay");

				// User requests: sort by requestedAt (FIFO)
				userSnapshots.sort((a, b) => {
					const aTime = a.requestedAt ? new Date(a.requestedAt).getTime() : 0;
					const bTime = b.requestedAt ? new Date(b.requestedAt).getTime() : 0;
					return aTime - bTime;
				});

				// Autoplay: already sorted by position (Spotify order)
				const orderedSnapshots = [...userSnapshots, ...autoplaySnapshots];

				const tracks: QueuedTrack[] = orderedSnapshots.slice(0, limit).map((snapshot) => ({
					id: snapshot.trackId,
					name: snapshot.trackName,
					artists: JSON.parse(snapshot.artists) as string[],
					album: snapshot.album,
					albumCoverUrl: snapshot.albumCoverUrl,
					requesterUserId: snapshot.requesterUserId ?? "unknown",
					requesterDisplayName: snapshot.requesterDisplayName ?? "Unknown",
					requestedAt: snapshot.requestedAt ?? snapshot.syncedAt,
				}));

				const countRows = await this.db
					.select({ count: count() })
					.from(spotifyQueueSnapshot)
					.where(gt(spotifyQueueSnapshot.position, 0));

				const totalCount = countRows[0]?.count ?? 0;
				return { tracks, totalCount };
			},
			catch: (cause) => new SongQueueDbError({ operation: "getQueue", cause }),
		});
	}

	/**
	 * Get request history with pagination and filters
	 */
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

		return Result.gen(async function* (this: SongQueueDO) {
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
	 *
	 * Used to check if this is the first request of a stream session.
	 */
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
	 * Get top tracks by request count
	 */
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
	async checkDuplicateRequest(
		userId: string,
		trackId: string,
		windowMinutes = 30,
	): Promise<Result<boolean, SongQueueDbError>> {
		const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

		return Result.gen(async function* (this: SongQueueDO) {
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
	 * Stream lifecycle: called when stream goes online
	 *
	 * Resets session-scoped state like streaks.
	 */
	async onStreamOnline(): Promise<void> {
		logger.info("SongQueueDO: Stream online, resetting session streaks");
		this.sessionStreaks.clear();
	}

	/**
	 * Stream lifecycle: called when stream goes offline
	 */
	async onStreamOffline(): Promise<void> {
		logger.info("SongQueueDO: Stream offline");
	}

	/**
	 * Increment a user's successful request streak
	 *
	 * Returns the new streak count.
	 */
	incrementStreak(userId: string): number {
		const current = this.sessionStreaks.get(userId) ?? 0;
		const newStreak = current + 1;
		this.sessionStreaks.set(userId, newStreak);
		logger.debug("Incremented user streak", { userId, newStreak });
		return newStreak;
	}

	/**
	 * Reset a user's request streak (on failure)
	 */
	resetStreak(userId: string): void {
		this.sessionStreaks.set(userId, 0);
		logger.debug("Reset user streak", { userId });
	}

	/**
	 * Get a user's current streak
	 */
	getStreak(userId: string): number {
		return this.sessionStreaks.get(userId) ?? 0;
	}

	/**
	 * Health check
	 */
	async ping(): Promise<{ ok: boolean }> {
		return { ok: true };
	}

	/**
	 * Ensure snapshot is fresh (max 30s staleness)
	 * Uses stale fallback on sync failure
	 */
	private async ensureFresh(): Promise<Result<void, never>> {
		const now = Date.now();
		const maxStalenessMs = 15_000; // 15 seconds

		// Check if we have recent sync
		if (this.lastSyncAt && now - this.lastSyncAt < maxStalenessMs) {
			return Result.ok();
		}

		// Coalesce concurrent sync requests
		if (this.syncLock) {
			await this.syncLock;
			return Result.ok();
		}

		// Start new sync
		this.syncLock = this.syncFromSpotify();

		const result = await this.syncLock;
		this.syncLock = null;

		if (result.status === "ok") {
			this.lastSyncAt = now;
		} else {
			logger.error("Sync failed, using stale data", { error: result.error.message });
		}

		// Always return ok - stale fallback
		return Result.ok();
	}

	/**
	 * Sync queue snapshot from Spotify API
	 * Spotify errors are soft failures (logged, proceed with available data)
	 * DB errors are hard failures (propagated)
	 *
	 * Attribution algorithm:
	 * 1. Get all pending requests, build per-trackId pools (FIFO order)
	 * 2. Fetch Spotify queue
	 * 3. For each Spotify track: pop oldest pending match → attribute with source='user', eventId, requester
	 * 4. Unmatched tracks → source='autoplay'
	 * 5. Update seen timestamps on matched pending requests
	 * 6. Reconcile played track using eventId from previous snapshot
	 * 7. Reconcile dropped tracks (previously seen but no longer in queue)
	 */
	private async syncFromSpotify(): Promise<Result<void, SongQueueDbError>> {
		const spotifyService = new SpotifyService(this.env);

		// 1. Get previous position 0 (with eventId for reconciliation)
		const previousPos0Result = await Result.tryPromise({
			try: () =>
				this.db.query.spotifyQueueSnapshot.findFirst({
					where: eq(spotifyQueueSnapshot.position, 0),
				}),
			catch: (cause) => new SongQueueDbError({ operation: "syncFromSpotify.getPrevious", cause }),
		});

		const previousSnapshot =
			previousPos0Result.status === "ok" ? previousPos0Result.value : undefined;

		// 2. Get all pending requests, build per-trackId pools
		const allPendingResult = await Result.tryPromise({
			try: () => this.db.select().from(pendingRequests).orderBy(asc(pendingRequests.requestedAt)), // FIFO within each trackId
			catch: (cause) => new SongQueueDbError({ operation: "syncFromSpotify.getAllPending", cause }),
		});

		if (allPendingResult.status === "error") {
			return allPendingResult;
		}

		// Build per-trackId pools (arrays maintain FIFO order from query)
		const pendingByTrackId = new Map<string, PendingRequest[]>();
		for (const req of allPendingResult.value) {
			const pool = pendingByTrackId.get(req.trackId);
			if (pool) {
				pool.push(req);
			} else {
				pendingByTrackId.set(req.trackId, [req]);
			}
		}

		// 3. Fetch both concurrently - soft failures, proceed with whatever we get
		const [currentlyPlayingResult, queueResult] = await Promise.all([
			spotifyService.getCurrentlyPlaying(),
			spotifyService.getQueue(),
		]);

		const now = new Date().toISOString();

		// 4. Build attributed snapshot items
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

		// Helper to pop oldest pending request for a trackId
		const popPending = (trackId: string): PendingRequest | undefined => {
			const pool = pendingByTrackId.get(trackId);
			if (pool && pool.length > 0) {
				return pool.shift(); // FIFO: oldest first
			}
			return undefined;
		};

		// Currently playing (position 0)
		if (currentlyPlayingResult.status === "ok" && currentlyPlayingResult.value) {
			const track = currentlyPlayingResult.value;
			const pending = popPending(track.id);

			attributedItems.push({
				position: 0,
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

		// Queue items (position > 0)
		if (queueResult.status === "ok") {
			for (let i = 0; i < queueResult.value.queue.length; i++) {
				const rawTrack = queueResult.value.queue[i];
				if (!rawTrack) continue;

				const albumCover = rawTrack.album.images.sort((a, b) => a.height - b.height)[0];
				const pending = popPending(rawTrack.id);

				attributedItems.push({
					position: i + 1,
					trackId: rawTrack.id,
					trackName: rawTrack.name,
					artists: JSON.stringify(rawTrack.artists.map((a) => a.name)),
					album: rawTrack.album.name,
					albumCoverUrl: albumCover?.url ?? null,
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
		}

		// 5. Reconcile played track using eventId from previous snapshot
		const newPos0EventId = attributedItems.find((i) => i.position === 0)?.eventId;
		const reconcilePlayedResult = await this.reconcilePlayed(previousSnapshot, newPos0EventId);
		if (reconcilePlayedResult.status === "error") {
			logger.error("Failed to reconcile played track", {
				error: reconcilePlayedResult.error.message,
			});
		}

		return Result.gen(async function* (this: SongQueueDO) {
			// 6. Clear old snapshot and insert new
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
								syncedAt: now,
							}),
						catch: (cause) =>
							new SongQueueDbError({
								operation: `syncFromSpotify.insert[${item.position}]`,
								cause,
							}),
					}),
				);
			}

			// 7. Update seen timestamps on matched pending requests
			if (matchedEventIds.length > 0) {
				yield* Result.await(
					Result.tryPromise({
						try: async () => {
							// Update lastSeenInSpotifyAt for all matched
							await this.db
								.update(pendingRequests)
								.set({ lastSeenInSpotifyAt: now })
								.where(inArray(pendingRequests.eventId, matchedEventIds));

							// Update firstSeenInSpotifyAt only for those never seen before
							await this.db
								.update(pendingRequests)
								.set({ firstSeenInSpotifyAt: now })
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

			// 8. Reconcile dropped tracks (previously seen but no longer in queue)
			const reconcileDroppedResult = await this.reconcileDropped(matchedEventIds);
			if (reconcileDroppedResult.status === "error") {
				logger.error("Failed to reconcile dropped tracks", {
					error: reconcileDroppedResult.error.message,
				});
			}

			// 9. Cleanup stale pending (TTL: 1 hour)
			const cleanupResult = await this.cleanupStalePending();
			if (cleanupResult.status === "error") {
				logger.error("Failed to cleanup stale pending", { error: cleanupResult.error.message });
			}

			return Result.ok();
		}, this);
	}

	/**
	 * Reconcile played track - move from pending to history when position 0 changes
	 * Uses eventId from snapshot for precise attribution (no trackId ambiguity)
	 *
	 * @param previousSnapshot - Previous position 0 snapshot (with eventId attribution)
	 * @param newEventId - Event ID currently at position 0 (null if autoplay/different)
	 */
	private async reconcilePlayed(
		previousSnapshot: schema.SpotifyQueueSnapshotItem | undefined,
		newEventId: string | null | undefined,
	): Promise<Result<void, SongQueueDbError>> {
		// No previous snapshot = nothing to reconcile
		if (!previousSnapshot) {
			return Result.ok();
		}

		// Previous was autoplay = nothing to reconcile
		if (!previousSnapshot.eventId) {
			return Result.ok();
		}

		// Same request still playing = nothing to reconcile
		if (previousSnapshot.eventId === newEventId) {
			return Result.ok();
		}

		// Previous user request finished playing - move to history
		const eventId = previousSnapshot.eventId;

		return Result.gen(async function* (this: SongQueueDO) {
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
				// Already reconciled or deleted
				return Result.ok();
			}

			// Move to history
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
	 * Reconcile dropped tracks - delete pending requests no longer in queue
	 *
	 * ONLY deletes requests that:
	 * 1. Were previously seen in Spotify (firstSeenInSpotifyAt is not null)
	 * 2. Are NOT in the current matched event IDs
	 *
	 * This prevents deleting new requests that haven't appeared in Spotify yet
	 * (due to API lag, race conditions, etc.)
	 *
	 * @param matchedEventIds - Event IDs that matched in the current sync
	 */
	private async reconcileDropped(
		matchedEventIds: string[],
	): Promise<Result<void, SongQueueDbError>> {
		return Result.gen(async function* (this: SongQueueDO) {
			// Find previously-seen requests that are no longer matched
			// - Must have been seen (firstSeenInSpotifyAt is not null)
			// - Must not be in current matched set
			const orphaned = yield* Result.await(
				Result.tryPromise({
					try: async () => {
						// Build where clause: seen before AND not currently matched
						const conditions = [
							// Must have been seen in Spotify before
							isNotNull(pendingRequests.firstSeenInSpotifyAt),
						];

						// If we have matched IDs, exclude them
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

			// Delete orphaned requests silently (no history - they were skipped/removed)
			const orphanedEventIds = orphaned.map((o) => o.eventId);
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
				trackIds: orphaned.map((o) => o.trackId),
			});

			return Result.ok();
		}, this);
	}

	/**
	 * Cleanup stale pending requests (TTL: 1 hour)
	 * Requests that never appeared in Spotify queue at all
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
						eventIds: deleted.map((d) => d.eventId),
					});
				}
			},
			catch: (cause) => new SongQueueDbError({ operation: "cleanupStalePending", cause }),
		});
	}
}
