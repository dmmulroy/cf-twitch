/**
 * SongQueueDO integration tests
 *
 * Tests the public Agent contract for queue persistence, history, stats, sync,
 * scheduling, and reconciliation behavior.
 */

import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import {
	pendingRequests,
	spotifyQueueSnapshot,
	type InsertPendingRequest,
	type InsertSpotifyQueueSnapshotItem,
} from "../../durable-objects/schemas/song-queue-do.schema";
import * as songQueueSchema from "../../durable-objects/schemas/song-queue-do.schema";
import { SongQueueDO } from "../../durable-objects/song-queue-do";
import { SpotifyTokenDO } from "../../durable-objects/spotify-token-do";
import { createPendingRequest, TEST_PENDING_REQUEST } from "../fixtures/song-request";
import {
	QUEUE_RESPONSE,
	VALID_TOKEN_RESPONSE,
	mockSpotifyCurrentlyPlaying,
	mockSpotifyQueue,
} from "../fixtures/spotify";

async function seedSnapshot(
	instance: SongQueueDO,
	rows: InsertSpotifyQueueSnapshotItem[],
): Promise<void> {
	const db = drizzle(instance.ctx.storage, { schema: songQueueSchema });
	await db.delete(spotifyQueueSnapshot);
	if (rows.length > 0) {
		await db.insert(spotifyQueueSnapshot).values(rows);
	}
}

async function seedPending(instance: SongQueueDO, rows: InsertPendingRequest[]): Promise<void> {
	const db = drizzle(instance.ctx.storage, { schema: songQueueSchema });
	for (const row of rows) {
		await db.insert(pendingRequests).values(row).onConflictDoNothing();
	}
}

describe("SongQueueDO", () => {
	let stub: DurableObjectStub<SongQueueDO>;
	let tokenStub: DurableObjectStub<SpotifyTokenDO>;

	beforeEach(async () => {
		const songQueueId = env.SONG_QUEUE_DO.idFromName("song-queue");
		stub = env.SONG_QUEUE_DO.get(songQueueId);
		await stub.setName("song-queue");
		await stub.getRequestHistory(1, 0);

		const tokenId = env.SPOTIFY_TOKEN_DO.idFromName("spotify-token");
		tokenStub = env.SPOTIFY_TOKEN_DO.get(tokenId);
		await tokenStub.setName("spotify-token");
		await tokenStub.getValidToken().catch(() => undefined);
	});

	describe("persistRequest", () => {
		it("persists a new request", async () => {
			const result = await stub.persistRequest(TEST_PENDING_REQUEST);

			expect(result.status).toBe("ok");
		});

		it("is idempotent for the same eventId", async () => {
			await stub.persistRequest(TEST_PENDING_REQUEST);
			const result = await stub.persistRequest(TEST_PENDING_REQUEST);

			expect(result.status).toBe("ok");
		});

		it("allows multiple requests with different eventIds", async () => {
			const result1 = await stub.persistRequest(createPendingRequest({ eventId: "event-1" }));
			const result2 = await stub.persistRequest(createPendingRequest({ eventId: "event-2" }));

			expect(result1.status).toBe("ok");
			expect(result2.status).toBe("ok");
		});

		it("schedules refresh and cleanup work after a new request", async () => {
			await stub.persistRequest(TEST_PENDING_REQUEST);

			const schedules = await runInDurableObject(stub, (instance: SongQueueDO) => {
				return instance.getSchedules();
			});

			expect(schedules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "delayed",
						callback: "refreshQueueTick",
						delayInSeconds: 1,
					}),
					expect.objectContaining({
						type: "delayed",
						callback: "cleanupStalePendingTick",
					}),
				]),
			);
		});
	});

	describe("deleteRequest", () => {
		it("deletes an existing request", async () => {
			await stub.persistRequest(TEST_PENDING_REQUEST);
			const result = await stub.deleteRequest(TEST_PENDING_REQUEST.eventId);

			expect(result.status).toBe("ok");
		});

		it("succeeds even if the request does not exist", async () => {
			const result = await stub.deleteRequest("nonexistent-event-id");

			expect(result.status).toBe("ok");
		});
	});

	describe("writeHistory", () => {
		it("moves a request from pending to history", async () => {
			await stub.persistRequest(TEST_PENDING_REQUEST);
			const result = await stub.writeHistory(
				TEST_PENDING_REQUEST.eventId,
				"2026-01-22T12:30:00.000Z",
			);

			expect(result.status).toBe("ok");
		});

		it("returns SongRequestNotFoundError for a missing request", async () => {
			const result = await runInDurableObject(stub, (instance: SongQueueDO) => {
				return instance.writeHistory("nonexistent-event-id", "2026-01-22T12:30:00.000Z");
			});

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("SongRequestNotFoundError");
			}
		});

		it("removes the request from pending after writing to history", async () => {
			await stub.persistRequest(TEST_PENDING_REQUEST);
			await stub.writeHistory(TEST_PENDING_REQUEST.eventId, "2026-01-22T12:30:00.000Z");

			const result = await runInDurableObject(stub, (instance: SongQueueDO) => {
				return instance.writeHistory(TEST_PENDING_REQUEST.eventId, "2026-01-22T12:35:00.000Z");
			});

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("SongRequestNotFoundError");
			}
		});
	});

	describe("getRequestHistory", () => {
		it("returns empty history initially", async () => {
			const result = await stub.getRequestHistory(50, 0);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.requests).toHaveLength(0);
				expect(result.value.totalCount).toBe(0);
			}
		});

		it("returns history after requests are fulfilled", async () => {
			await stub.persistRequest(TEST_PENDING_REQUEST);
			await stub.writeHistory(TEST_PENDING_REQUEST.eventId, "2026-01-22T12:30:00.000Z");

			const result = await stub.getRequestHistory(50, 0);
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.requests).toHaveLength(1);
				expect(result.value.totalCount).toBe(1);
				expect(result.value.requests[0]?.eventId).toBe(TEST_PENDING_REQUEST.eventId);
			}
		});

		it("filters by since and until", async () => {
			await stub.persistRequest(createPendingRequest({ eventId: "old-request" }));
			await stub.writeHistory("old-request", "2026-01-20T12:00:00.000Z");

			await stub.persistRequest(createPendingRequest({ eventId: "new-request" }));
			await stub.writeHistory("new-request", "2026-01-22T12:00:00.000Z");

			const result = await stub.getRequestHistory(
				50,
				0,
				"2026-01-21T00:00:00.000Z",
				"2026-01-23T00:00:00.000Z",
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.requests).toHaveLength(1);
				expect(result.value.requests[0]?.eventId).toBe("new-request");
			}
		});

		it("respects limit and offset", async () => {
			for (let index = 0; index < 5; index++) {
				await stub.persistRequest(createPendingRequest({ eventId: `request-${index}` }));
				await stub.writeHistory(`request-${index}`, `2026-01-22T12:0${index}:00.000Z`);
			}

			const result = await stub.getRequestHistory(2, 0);
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.requests).toHaveLength(2);
				expect(result.value.totalCount).toBe(5);
			}

			const offsetResult = await stub.getRequestHistory(2, 2);
			expect(offsetResult.status).toBe("ok");
			if (offsetResult.status === "ok") {
				expect(offsetResult.value.requests).toHaveLength(2);
			}
		});
	});

	describe("checkDuplicateRequest", () => {
		it("returns false when no duplicates exist", async () => {
			const result = await stub.checkDuplicateRequest("user-123", "track-abc", 30);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe(false);
			}
		});

		it("returns true when a duplicate exists in pending requests", async () => {
			const recentRequest = createPendingRequest({
				eventId: "recent-duplicate-test",
				requestedAt: new Date().toISOString(),
			});
			await stub.persistRequest(recentRequest);

			const result = await stub.checkDuplicateRequest(
				recentRequest.requesterUserId,
				recentRequest.trackId,
				30,
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe(true);
			}
		});

		it("returns true when a duplicate exists in recent history", async () => {
			await stub.persistRequest(TEST_PENDING_REQUEST);
			await stub.writeHistory(TEST_PENDING_REQUEST.eventId, new Date().toISOString());

			const result = await stub.checkDuplicateRequest(
				TEST_PENDING_REQUEST.requesterUserId,
				TEST_PENDING_REQUEST.trackId,
				30,
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe(true);
			}
		});

		it("returns false for a different user", async () => {
			await stub.persistRequest(TEST_PENDING_REQUEST);

			const result = await stub.checkDuplicateRequest(
				"different-user",
				TEST_PENDING_REQUEST.trackId,
				30,
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe(false);
			}
		});

		it("returns false for a different track", async () => {
			await stub.persistRequest(TEST_PENDING_REQUEST);

			const result = await stub.checkDuplicateRequest(
				TEST_PENDING_REQUEST.requesterUserId,
				"different-track-id",
				30,
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe(false);
			}
		});
	});

	describe("top statistics", () => {
		it("returns top tracks ordered by request count", async () => {
			for (let index = 0; index < 3; index++) {
				await stub.persistRequest(
					createPendingRequest({
						eventId: `popular-track-${index}`,
						trackId: "popular-track-id",
						trackName: "Popular Track",
					}),
				);
				await stub.writeHistory(`popular-track-${index}`, `2026-01-22T12:0${index}:00.000Z`);
			}

			await stub.persistRequest(
				createPendingRequest({
					eventId: "other-track-1",
					trackId: "other-track-id",
					trackName: "Other Track",
				}),
			);
			await stub.writeHistory("other-track-1", "2026-01-22T12:05:00.000Z");

			const result = await stub.getTopTracks(10);
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toHaveLength(2);
				expect(result.value[0]?.trackId).toBe("popular-track-id");
				expect(result.value[0]?.requestCount).toBe(3);
			}
		});

		it("returns top requesters ordered by request count", async () => {
			for (let index = 0; index < 3; index++) {
				await stub.persistRequest(
					createPendingRequest({
						eventId: `power-user-${index}`,
						trackId: `track-${index}`,
						requesterUserId: "power-user",
						requesterDisplayName: "PowerUser",
					}),
				);
				await stub.writeHistory(`power-user-${index}`, `2026-01-22T12:0${index}:00.000Z`);
			}

			await stub.persistRequest(
				createPendingRequest({
					eventId: "casual-user-1",
					requesterUserId: "casual-user",
					requesterDisplayName: "CasualUser",
				}),
			);
			await stub.writeHistory("casual-user-1", "2026-01-22T12:05:00.000Z");

			const result = await stub.getTopRequesters(10);
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toHaveLength(2);
				expect(result.value[0]?.userId).toBe("power-user");
				expect(result.value[0]?.requestCount).toBe(3);
			}
		});

		it("returns top tracks for a specific user", async () => {
			for (let index = 0; index < 2; index++) {
				await stub.persistRequest(
					createPendingRequest({
						eventId: `target-user-${index}`,
						trackId: "favorite-track",
						requesterUserId: "target-user",
					}),
				);
				await stub.writeHistory(`target-user-${index}`, `2026-01-22T12:0${index}:00.000Z`);
			}

			await stub.persistRequest(
				createPendingRequest({
					eventId: "other-user-1",
					trackId: "favorite-track",
					requesterUserId: "other-user",
				}),
			);
			await stub.writeHistory("other-user-1", "2026-01-22T12:05:00.000Z");

			const result = await stub.getTopTracksByUser("target-user", 10);
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toHaveLength(1);
				expect(result.value[0]?.requestCount).toBe(2);
			}
		});
	});

	describe("startup hydration and background coordination", () => {
		it("hydrates lastSyncAt from snapshot rows on startup", async () => {
			const syncedAt = new Date().toISOString();

			const result = await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await seedSnapshot(instance, [
					{
						position: 0,
						trackId: "seed-track",
						trackName: "Seed Track",
						artists: JSON.stringify(["Seed Artist"]),
						album: "Seed Album",
						albumCoverUrl: null,
						syncedAt,
						source: "autoplay",
						eventId: null,
						requesterUserId: null,
						requesterDisplayName: null,
						requestedAt: null,
					},
				]);

				instance.setState({
					lastSyncAt: null,
					refreshScheduleId: null,
					refreshDueAt: null,
					cleanupScheduleId: null,
					cleanupDueAt: null,
					consecutiveSyncFailures: 0,
				});

				await instance.onStart();

				return {
					state: instance.state,
					schedules: instance.getSchedules(),
				};
			});

			expect(result.state.lastSyncAt).toBe(syncedAt);
			expect(result.schedules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						callback: "refreshQueueTick",
					}),
				]),
			);
		});

		it("cleans up stale pending requests via the scheduled callback", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await seedPending(instance, [
					createPendingRequest({
						eventId: "stale-pending-request",
						requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
					}),
				]);
				await instance.cleanupStalePendingTick();
			});

			const pendingCount = await runInDurableObject(stub, async (instance: SongQueueDO) => {
				const db = drizzle(instance.ctx.storage, { schema: songQueueSchema });
				const rows = await db.select({ count: pendingRequests.eventId }).from(pendingRequests);
				return rows.length;
			});

			expect(pendingCount).toBe(0);
		});
	});

	describe("Spotify sync behavior", () => {
		it("returns null when nothing is currently playing", async () => {
			await tokenStub.setTokens(VALID_TOKEN_RESPONSE);
			mockSpotifyCurrentlyPlaying(fetchMock, false);
			mockSpotifyQueue(fetchMock);

			const result = await stub.getCurrentlyPlaying();

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.track).toBeNull();
				expect(result.value.position).toBe(0);
			}
		});

		it("returns queue items after a successful sync", async () => {
			await tokenStub.setTokens(VALID_TOKEN_RESPONSE);
			mockSpotifyCurrentlyPlaying(fetchMock);
			mockSpotifyQueue(fetchMock);

			const result = await stub.getSongQueue(10);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.tracks).toHaveLength(1);
				expect(result.value.tracks[0]?.id).toBe(QUEUE_RESPONSE.queue[0]?.id);
			}
		});

		it("falls back to stale snapshot data when Spotify sync fails", async () => {
			const staleSyncedAt = new Date(Date.now() - 60_000).toISOString();

			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await seedSnapshot(instance, [
					{
						position: 0,
						trackId: "stale-current-track",
						trackName: "Stale Current Track",
						artists: JSON.stringify(["Stale Artist"]),
						album: "Stale Album",
						albumCoverUrl: null,
						syncedAt: staleSyncedAt,
						source: "autoplay",
						eventId: null,
						requesterUserId: null,
						requesterDisplayName: null,
						requestedAt: null,
					},
					{
						position: 1,
						trackId: "stale-queue-track",
						trackName: "Stale Queue Track",
						artists: JSON.stringify(["Stale Artist"]),
						album: "Stale Album",
						albumCoverUrl: null,
						syncedAt: staleSyncedAt,
						source: "autoplay",
						eventId: null,
						requesterUserId: null,
						requesterDisplayName: null,
						requestedAt: null,
					},
				]);
				instance.setState({
					...instance.state,
					lastSyncAt: staleSyncedAt,
				});
			});

			const currentResult = await stub.getCurrentlyPlaying();
			const queueResult = await stub.getSongQueue(10);

			expect(currentResult.status).toBe("ok");
			expect(queueResult.status).toBe("ok");
			if (currentResult.status === "ok") {
				expect(currentResult.value.track?.id).toBe("stale-current-track");
			}
			if (queueResult.status === "ok") {
				expect(queueResult.value.tracks[0]?.id).toBe("stale-queue-track");
			}
		});

		it("invalidates freshness after persistRequest so the next read resyncs", async () => {
			await tokenStub.setTokens(VALID_TOKEN_RESPONSE);

			const freshSyncedAt = new Date().toISOString();
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await seedSnapshot(instance, [
					{
						position: 1,
						trackId: "old-queue-track",
						trackName: "Old Queue Track",
						artists: JSON.stringify(["Old Artist"]),
						album: "Old Album",
						albumCoverUrl: null,
						syncedAt: freshSyncedAt,
						source: "autoplay",
						eventId: null,
						requesterUserId: null,
						requesterDisplayName: null,
						requestedAt: null,
					},
				]);
				instance.setState({
					...instance.state,
					lastSyncAt: freshSyncedAt,
				});
			});

			await stub.persistRequest(createPendingRequest({ eventId: "invalidate-sync-event" }));
			mockSpotifyCurrentlyPlaying(fetchMock);
			mockSpotifyQueue(fetchMock);

			const result = await stub.getSongQueue(10);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.tracks[0]?.id).toBe(QUEUE_RESPONSE.queue[0]?.id);
				expect(result.value.tracks[0]?.id).not.toBe("old-queue-track");
			}
		});
	});

	describe("reconciliation behavior", () => {
		it("moves the previous position 0 user request into history when it finishes playing", async () => {
			await tokenStub.setTokens(VALID_TOKEN_RESPONSE);

			const playedRequest = createPendingRequest({
				eventId: "played-request-event",
				trackId: "played-track-id",
				trackName: "Played Track",
				requestedAt: new Date().toISOString(),
			});
			const previousSyncedAt = new Date(Date.now() - 60_000).toISOString();

			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await seedPending(instance, [playedRequest]);
				await seedSnapshot(instance, [
					{
						position: 0,
						trackId: playedRequest.trackId,
						trackName: playedRequest.trackName,
						artists: playedRequest.artists,
						album: playedRequest.album,
						albumCoverUrl: playedRequest.albumCoverUrl,
						syncedAt: previousSyncedAt,
						source: "user",
						eventId: playedRequest.eventId,
						requesterUserId: playedRequest.requesterUserId,
						requesterDisplayName: playedRequest.requesterDisplayName,
						requestedAt: playedRequest.requestedAt,
					},
				]);
				instance.setState({
					...instance.state,
					lastSyncAt: previousSyncedAt,
				});
			});

			mockSpotifyCurrentlyPlaying(fetchMock);
			mockSpotifyQueue(fetchMock);
			await stub.getCurrentlyPlaying();

			const historyResult = await stub.getRequestHistory(10, 0);
			expect(historyResult.status).toBe("ok");
			if (historyResult.status === "ok") {
				expect(historyResult.value.requests.map((request) => request.eventId)).toContain(
					playedRequest.eventId,
				);
			}
		});

		it("drops previously seen unmatched pending requests that disappear from Spotify", async () => {
			await tokenStub.setTokens(VALID_TOKEN_RESPONSE);

			const disappearingRequest = createPendingRequest({
				eventId: "disappearing-request",
				trackId: "unmatched-track-id",
				requestedAt: new Date().toISOString(),
				firstSeenInSpotifyAt: new Date(Date.now() - 30_000).toISOString(),
				lastSeenInSpotifyAt: new Date(Date.now() - 30_000).toISOString(),
			});

			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await seedPending(instance, [disappearingRequest]);
			});

			mockSpotifyCurrentlyPlaying(fetchMock);
			mockSpotifyQueue(fetchMock);
			await stub.getSongQueue(10);

			const duplicateResult = await stub.checkDuplicateRequest(
				disappearingRequest.requesterUserId,
				disappearingRequest.trackId,
				30,
			);
			expect(duplicateResult.status).toBe("ok");
			if (duplicateResult.status === "ok") {
				expect(duplicateResult.value).toBe(false);
			}
		});

		it("keeps never-seen pending requests even when they do not appear in the latest sync", async () => {
			await tokenStub.setTokens(VALID_TOKEN_RESPONSE);

			const neverSeenRequest = createPendingRequest({
				eventId: "never-seen-request",
				trackId: "never-seen-track-id",
				requestedAt: new Date().toISOString(),
				firstSeenInSpotifyAt: null,
				lastSeenInSpotifyAt: null,
			});

			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await seedPending(instance, [neverSeenRequest]);
			});

			mockSpotifyCurrentlyPlaying(fetchMock);
			mockSpotifyQueue(fetchMock);
			await stub.getSongQueue(10);

			const duplicateResult = await stub.checkDuplicateRequest(
				neverSeenRequest.requesterUserId,
				neverSeenRequest.trackId,
				30,
			);
			expect(duplicateResult.status).toBe("ok");
			if (duplicateResult.status === "ok") {
				expect(duplicateResult.value).toBe(true);
			}
		});
	});
});
