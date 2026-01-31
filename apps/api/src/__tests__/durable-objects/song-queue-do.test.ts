/**
 * SongQueueDO unit tests
 *
 * Tests song request persistence, history, and queue operations.
 * Note: getCurrentlyPlaying and getQueue methods trigger ensureFresh which
 * requires Spotify API mocking. Basic DB operations are tested without mocks.
 */

import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { SongQueueDO } from "../../durable-objects/song-queue-do";
import { SpotifyTokenDO } from "../../durable-objects/spotify-token-do";
import { createPendingRequest, TEST_PENDING_REQUEST } from "../fixtures/song-request";
import {
	mockSpotifyCurrentlyPlaying,
	mockSpotifyQueue,
	mockSpotifyTokenRefresh,
	VALID_TOKEN_RESPONSE,
} from "../fixtures/spotify";

describe("SongQueueDO", () => {
	let stub: DurableObjectStub<SongQueueDO>;

	beforeEach(() => {
		const id = env.SONG_QUEUE_DO.idFromName("song-queue");
		stub = env.SONG_QUEUE_DO.get(id);
	});

	describe("persistRequest", () => {
		it("should persist a new request", async () => {
			const result = await runInDurableObject(stub, (instance: SongQueueDO) =>
				instance.persistRequest(TEST_PENDING_REQUEST),
			);

			expect(result.status).toBe("ok");
		});

		it("should be idempotent (same eventId)", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await instance.persistRequest(TEST_PENDING_REQUEST);
				const result = await instance.persistRequest(TEST_PENDING_REQUEST);
				expect(result.status).toBe("ok");
			});
		});

		it("should allow multiple requests with different eventIds", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				const result1 = await instance.persistRequest(createPendingRequest({ eventId: "event-1" }));
				const result2 = await instance.persistRequest(createPendingRequest({ eventId: "event-2" }));

				expect(result1.status).toBe("ok");
				expect(result2.status).toBe("ok");
			});
		});
	});

	describe("deleteRequest", () => {
		it("should delete existing request", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await instance.persistRequest(TEST_PENDING_REQUEST);
				const result = await instance.deleteRequest(TEST_PENDING_REQUEST.eventId);
				expect(result.status).toBe("ok");
			});
		});

		it("should succeed even if request does not exist (idempotent)", async () => {
			const result = await runInDurableObject(stub, (instance: SongQueueDO) =>
				instance.deleteRequest("nonexistent-event-id"),
			);

			expect(result.status).toBe("ok");
		});
	});

	describe("writeHistory", () => {
		it("should move request from pending to history", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await instance.persistRequest(TEST_PENDING_REQUEST);
				const result = await instance.writeHistory(
					TEST_PENDING_REQUEST.eventId,
					"2026-01-22T12:30:00.000Z",
				);
				expect(result.status).toBe("ok");
			});
		});

		it("should return SongRequestNotFoundError for missing request", async () => {
			const result = await runInDurableObject(stub, (instance: SongQueueDO) =>
				instance.writeHistory("nonexistent-event-id", "2026-01-22T12:30:00.000Z"),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("SongRequestNotFoundError");
			}
		});

		it("should remove request from pending after writing to history", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await instance.persistRequest(TEST_PENDING_REQUEST);
				await instance.writeHistory(TEST_PENDING_REQUEST.eventId, "2026-01-22T12:30:00.000Z");

				// Try to write history again - should fail since request is gone
				const result = await instance.writeHistory(
					TEST_PENDING_REQUEST.eventId,
					"2026-01-22T12:35:00.000Z",
				);
				expect(result.status).toBe("error");
				if (result.status === "error") {
					expect(result.error._tag).toBe("SongRequestNotFoundError");
				}
			});
		});
	});

	describe("getRequestHistory", () => {
		it("should return empty history initially", async () => {
			const result = await runInDurableObject(stub, (instance: SongQueueDO) =>
				instance.getRequestHistory(50, 0),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.requests).toHaveLength(0);
				expect(result.value.totalCount).toBe(0);
			}
		});

		it("should return history after requests are fulfilled", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await instance.persistRequest(TEST_PENDING_REQUEST);
				await instance.writeHistory(TEST_PENDING_REQUEST.eventId, "2026-01-22T12:30:00.000Z");

				const result = await instance.getRequestHistory(50, 0);
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value.requests).toHaveLength(1);
					expect(result.value.totalCount).toBe(1);
					expect(result.value.requests[0]?.eventId).toBe(TEST_PENDING_REQUEST.eventId);
				}
			});
		});

		it("should filter by since/until", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				// Create requests at different times
				await instance.persistRequest(createPendingRequest({ eventId: "old-request" }));
				await instance.writeHistory("old-request", "2026-01-20T12:00:00.000Z");

				await instance.persistRequest(createPendingRequest({ eventId: "new-request" }));
				await instance.writeHistory("new-request", "2026-01-22T12:00:00.000Z");

				// Filter to only include newer request
				const result = await instance.getRequestHistory(
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
		});

		it("should respect limit and offset", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				// Create multiple requests
				for (let i = 0; i < 5; i++) {
					await instance.persistRequest(createPendingRequest({ eventId: `request-${i}` }));
					await instance.writeHistory(`request-${i}`, `2026-01-22T12:0${i}:00.000Z`);
				}

				// Get with limit
				const result = await instance.getRequestHistory(2, 0);
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value.requests).toHaveLength(2);
					expect(result.value.totalCount).toBe(5);
				}

				// Get with offset
				const offsetResult = await instance.getRequestHistory(2, 2);
				expect(offsetResult.status).toBe("ok");
				if (offsetResult.status === "ok") {
					expect(offsetResult.value.requests).toHaveLength(2);
				}
			});
		});
	});

	describe("checkDuplicateRequest", () => {
		it("should return false when no duplicates exist", async () => {
			const result = await runInDurableObject(stub, (instance: SongQueueDO) =>
				instance.checkDuplicateRequest("user-123", "track-abc", 30),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe(false);
			}
		});

		it("should return true when duplicate in pending requests", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				// Use a fresh timestamp within the 30-minute window
				const recentRequest = createPendingRequest({
					eventId: "recent-duplicate-test",
					requestedAt: new Date().toISOString(),
				});
				await instance.persistRequest(recentRequest);

				const result = await instance.checkDuplicateRequest(
					recentRequest.requesterUserId,
					recentRequest.trackId,
					30,
				);

				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value).toBe(true);
				}
			});
		});

		it("should return true when duplicate in recent history", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await instance.persistRequest(TEST_PENDING_REQUEST);
				await instance.writeHistory(TEST_PENDING_REQUEST.eventId, new Date().toISOString());

				const result = await instance.checkDuplicateRequest(
					TEST_PENDING_REQUEST.requesterUserId,
					TEST_PENDING_REQUEST.trackId,
					30,
				);

				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value).toBe(true);
				}
			});
		});

		it("should return false for different user", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await instance.persistRequest(TEST_PENDING_REQUEST);

				const result = await instance.checkDuplicateRequest(
					"different-user",
					TEST_PENDING_REQUEST.trackId,
					30,
				);

				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value).toBe(false);
				}
			});
		});

		it("should return false for different track", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				await instance.persistRequest(TEST_PENDING_REQUEST);

				const result = await instance.checkDuplicateRequest(
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
	});

	describe("getTopTracks", () => {
		it("should return empty array when no history", async () => {
			const result = await runInDurableObject(stub, (instance: SongQueueDO) =>
				instance.getTopTracks(10),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toHaveLength(0);
			}
		});

		it("should return tracks ordered by request count", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				// Create multiple requests for same track
				for (let i = 0; i < 3; i++) {
					await instance.persistRequest(
						createPendingRequest({
							eventId: `popular-track-${i}`,
							trackId: "popular-track-id",
							trackName: "Popular Track",
						}),
					);
					await instance.writeHistory(`popular-track-${i}`, `2026-01-22T12:0${i}:00.000Z`);
				}

				// Create one request for another track
				await instance.persistRequest(
					createPendingRequest({
						eventId: "other-track-1",
						trackId: "other-track-id",
						trackName: "Other Track",
					}),
				);
				await instance.writeHistory("other-track-1", "2026-01-22T12:05:00.000Z");

				const result = await instance.getTopTracks(10);
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value).toHaveLength(2);
					expect(result.value[0]?.trackId).toBe("popular-track-id");
					expect(result.value[0]?.requestCount).toBe(3);
				}
			});
		});
	});

	describe("getTopRequesters", () => {
		it("should return empty array when no history", async () => {
			const result = await runInDurableObject(stub, (instance: SongQueueDO) =>
				instance.getTopRequesters(10),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toHaveLength(0);
			}
		});

		it("should return requesters ordered by request count", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				// Create multiple requests from same user
				for (let i = 0; i < 3; i++) {
					await instance.persistRequest(
						createPendingRequest({
							eventId: `power-user-${i}`,
							trackId: `track-${i}`,
							requesterUserId: "power-user",
							requesterDisplayName: "PowerUser",
						}),
					);
					await instance.writeHistory(`power-user-${i}`, `2026-01-22T12:0${i}:00.000Z`);
				}

				// Create one request from another user
				await instance.persistRequest(
					createPendingRequest({
						eventId: "casual-user-1",
						requesterUserId: "casual-user",
						requesterDisplayName: "CasualUser",
					}),
				);
				await instance.writeHistory("casual-user-1", "2026-01-22T12:05:00.000Z");

				const result = await instance.getTopRequesters(10);
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value).toHaveLength(2);
					expect(result.value[0]?.userId).toBe("power-user");
					expect(result.value[0]?.requestCount).toBe(3);
				}
			});
		});
	});

	describe("getTopTracksByUser", () => {
		it("should return tracks requested by specific user", async () => {
			await runInDurableObject(stub, async (instance: SongQueueDO) => {
				// Create requests from target user
				for (let i = 0; i < 2; i++) {
					await instance.persistRequest(
						createPendingRequest({
							eventId: `target-user-${i}`,
							trackId: "favorite-track",
							requesterUserId: "target-user",
						}),
					);
					await instance.writeHistory(`target-user-${i}`, `2026-01-22T12:0${i}:00.000Z`);
				}

				// Create request from different user
				await instance.persistRequest(
					createPendingRequest({
						eventId: "other-user-1",
						trackId: "favorite-track",
						requesterUserId: "other-user",
					}),
				);
				await instance.writeHistory("other-user-1", "2026-01-22T12:05:00.000Z");

				const result = await instance.getTopTracksByUser("target-user", 10);
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value).toHaveLength(1);
					expect(result.value[0]?.requestCount).toBe(2);
				}
			});
		});
	});

	describe("ping", () => {
		it("should return ok: true", async () => {
			const result = await runInDurableObject(stub, (instance: SongQueueDO) => instance.ping());

			expect(result).toEqual({ ok: true });
		});
	});

	// NOTE: Spotify sync tests are skipped because SpotifyService uses getStub()
	// internally to fetch tokens, which doesn't work in vitest pool workers context.
	// The DB operations (persistRequest, writeHistory, etc.) are tested above.
	describe.skip("getCurrentlyPlaying with Spotify sync", () => {
		beforeEach(async () => {
			// Set up SpotifyTokenDO with valid token
			const tokenStub = env.SPOTIFY_TOKEN_DO.get(env.SPOTIFY_TOKEN_DO.idFromName("spotify-token"));
			await runInDurableObject(tokenStub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
			});
		});

		it("should return null track when nothing playing", async () => {
			// Mock Spotify API returns 204 (nothing playing)
			mockSpotifyCurrentlyPlaying(fetchMock, false);
			mockSpotifyQueue(fetchMock);
			mockSpotifyTokenRefresh(fetchMock);

			const result = await runInDurableObject(stub, (instance: SongQueueDO) =>
				instance.getCurrentlyPlaying(),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.track).toBeNull();
				expect(result.value.position).toBe(0);
			}
		});
	});

	describe.skip("getQueue with Spotify sync", () => {
		beforeEach(async () => {
			// Set up SpotifyTokenDO with valid token
			const tokenStub = env.SPOTIFY_TOKEN_DO.get(env.SPOTIFY_TOKEN_DO.idFromName("spotify-token"));
			await runInDurableObject(tokenStub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
			});
		});

		it("should return queue items after sync", async () => {
			mockSpotifyCurrentlyPlaying(fetchMock);
			mockSpotifyQueue(fetchMock);
			mockSpotifyTokenRefresh(fetchMock);

			const result = await runInDurableObject(stub, (instance: SongQueueDO) =>
				instance.getQueue(10),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.tracks).toBeDefined();
			}
		});
	});
});
