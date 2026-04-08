/**
 * SongRequestSagaDO integration tests
 *
 * Tests the public Agent contract for song request saga startup, retry
 * scheduling, scheduled resume, and failure/completion status transitions.
 */

import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import { EventBusDO } from "../../durable-objects/event-bus-do";
import * as sagaSchema from "../../durable-objects/schemas/saga.schema";
import { SongQueueDO } from "../../durable-objects/song-queue-do";
import { SongRequestSagaDO } from "../../durable-objects/song-request-saga-do";
import { SpotifyTokenDO } from "../../durable-objects/spotify-token-do";
import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import { createSongRequestParams } from "../fixtures/song-request";
import {
	VALID_TOKEN_RESPONSE as VALID_SPOTIFY_TOKEN_RESPONSE,
	mockSpotifyGetTrack,
	mockSpotifyQueue,
} from "../fixtures/spotify";
import {
	VALID_TOKEN_RESPONSE as VALID_TWITCH_TOKEN_RESPONSE,
	mockTwitchChatMessage,
	mockTwitchRedemptionUpdate,
} from "../fixtures/twitch";
import {
	ensureAchievementsSingletonStub,
	waitForAchievementQueuesToDrain,
} from "../helpers/durable-objects";

async function createSongRequestSagaStub(
	name: string,
): Promise<DurableObjectStub<SongRequestSagaDO>> {
	const id = env.SONG_REQUEST_SAGA_DO.idFromName(name);
	const stub = env.SONG_REQUEST_SAGA_DO.get(id);
	await stub.setName(name);
	await stub.getStatus();
	return stub;
}

async function ensureSpotifyTokenStub(): Promise<DurableObjectStub<SpotifyTokenDO>> {
	const id = env.SPOTIFY_TOKEN_DO.idFromName("spotify-token");
	const stub = env.SPOTIFY_TOKEN_DO.get(id);
	await stub.setName("spotify-token");
	await stub.setTokens(VALID_SPOTIFY_TOKEN_RESPONSE);
	return stub;
}

async function ensureTwitchTokenStub(): Promise<DurableObjectStub<TwitchTokenDO>> {
	const id = env.TWITCH_TOKEN_DO.idFromName("twitch-token");
	const stub = env.TWITCH_TOKEN_DO.get(id);
	await stub.setName("twitch-token");
	await stub.setTokens(VALID_TWITCH_TOKEN_RESPONSE);
	return stub;
}

async function ensureSongQueueStub(): Promise<DurableObjectStub<SongQueueDO>> {
	const id = env.SONG_QUEUE_DO.idFromName("song-queue");
	const stub = env.SONG_QUEUE_DO.get(id);
	await stub.setName("song-queue");
	await stub.getRequestHistory(1, 0);
	return stub;
}

async function ensureEventBusStub(): Promise<DurableObjectStub<EventBusDO>> {
	const id = env.EVENT_BUS_DO.idFromName("event-bus");
	const stub = env.EVENT_BUS_DO.get(id);
	await stub.setName("event-bus");
	await stub.getPendingCount();
	return stub;
}

async function cancelSongRequestSagaSchedules(
	stub: DurableObjectStub<SongRequestSagaDO>,
): Promise<void> {
	await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
		for (const schedule of instance.getSchedules()) {
			await instance.cancelSchedule(schedule.id);
		}
	});
}

async function cancelSongQueueSchedules(stub: DurableObjectStub<SongQueueDO>): Promise<void> {
	await runInDurableObject(stub, async (instance: SongQueueDO) => {
		for (const schedule of instance.getSchedules()) {
			await instance.cancelSchedule(schedule.id);
		}
	});
}

describe("SongRequestSagaDO", () => {
	it("returns null status before a saga starts", async () => {
		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);

		const result = await stub.getStatus();

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toBeNull();
		}
	});

	it("schedules a retry for retryable Spotify failures and resumes via the scheduled callback", async () => {
		await ensureSpotifyTokenStub();
		await ensureTwitchTokenStub();

		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);
		const params = createSongRequestParams({
			id: `redemption-${crypto.randomUUID()}`,
			user_input: "https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh",
		});
		const trackId = "4iV5W9uYEdYUVa79Axb7Rh";

		fetchMock
			.get("https://api.spotify.com")
			.intercept({ path: `/v1/tracks/${trackId}` })
			.reply(503, "Service unavailable");

		const startResult = await stub.start(params);
		expect(startResult.status).toBe("error");
		if (startResult.status === "error") {
			expect(startResult.error).toMatchObject({
				message: expect.stringContaining("scheduled for retry"),
			});
		}

		const schedulesAfterRetry = await runInDurableObject(stub, (instance: SongRequestSagaDO) =>
			instance.getSchedules(),
		);
		expect(schedulesAfterRetry).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "scheduled",
					callback: "retrySagaTick",
				}),
			]),
		);

		const songQueueStub = await ensureSongQueueStub();
		const achievementsStub = await ensureAchievementsSingletonStub();
		await ensureEventBusStub();
		mockSpotifyGetTrack(fetchMock, trackId);
		mockSpotifyQueue(fetchMock);
		mockTwitchRedemptionUpdate(fetchMock);
		mockTwitchChatMessage(fetchMock);
		mockTwitchChatMessage(fetchMock);

		await stub.retrySagaTick();
		await waitForAchievementQueuesToDrain(achievementsStub, params.user_name);
		await cancelSongRequestSagaSchedules(stub);
		await cancelSongQueueSchedules(songQueueStub);

		const statusResult = await stub.getStatus();
		expect(statusResult.status).toBe("ok");
		if (statusResult.status === "ok") {
			expect(statusResult.value).toMatchObject({
				status: "COMPLETED",
			});
		}
	});

	it("restores a pending retry schedule from durable saga rows during startup", async () => {
		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);
		const now = new Date().toISOString();
		const dueAt = new Date(Date.now() + 60_000).toISOString();
		const params = createSongRequestParams({
			id: `redemption-${crypto.randomUUID()}`,
		});

		const schedules = await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			await db.insert(sagaSchema.sagaRuns).values({
				id: instance.ctx.id.toString(),
				status: "RUNNING",
				paramsJson: JSON.stringify(params),
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(sagaSchema.sagaSteps).values({
				sagaId: instance.ctx.id.toString(),
				stepName: "get-track-info",
				state: "PENDING",
				attempt: 1,
				nextRetryAt: dueAt,
				lastError: "Spotify API error (503) during getTrack",
			});

			instance.setState({
				retryScheduleId: "stale-retry-id",
				retryDueAt: "2099-01-01T00:00:00.000Z",
			});
			await instance.onStart();
			return instance.getSchedules();
		});

		expect(schedules).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "scheduled",
					callback: "retrySagaTick",
				}),
			]),
		);
	});

	it("fails invalid Spotify URLs and records FAILED saga status", async () => {
		await ensureTwitchTokenStub();

		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);
		const params = createSongRequestParams({
			id: `redemption-${crypto.randomUUID()}`,
			user_input: "definitely not a spotify url",
		});

		mockTwitchRedemptionUpdate(fetchMock);
		mockTwitchChatMessage(fetchMock);

		const startResult = await stub.start(params);
		expect(startResult.status).toBe("error");
		if (startResult.status === "error") {
			expect(startResult.error).toMatchObject({
				message: expect.stringContaining("parse-spotify-url"),
			});
		}

		const statusResult = await stub.getStatus();
		expect(statusResult.status).toBe("ok");
		if (statusResult.status === "ok") {
			expect(statusResult.value).toMatchObject({
				status: "FAILED",
			});
			expect(statusResult.value?.error).toContain("Invalid Spotify URL");
		}
	});
});
