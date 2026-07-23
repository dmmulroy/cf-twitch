/**
 * SongRequestSagaDO integration tests
 *
 * Tests the public Agent contract for song request saga startup, retry
 * scheduling, scheduled resume, and failure/completion status transitions.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vite-plus/test";

import { EventBusDO } from "../../durable-objects/event-bus-do";
import * as sagaSchema from "../../durable-objects/schemas/saga.schema";
import * as songQueueSchema from "../../durable-objects/schemas/song-queue-do.schema";
import { SongQueueDO } from "../../durable-objects/song-queue-do";
import { SongRequestSagaDO } from "../../durable-objects/song-request-saga-do";
import { SpotifyTokenDO } from "../../durable-objects/spotify-token-do";
import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import { TEST_PENDING_REQUEST, createSongRequestParams } from "../fixtures/song-request";
import {
	VALID_TOKEN_RESPONSE as VALID_SPOTIFY_TOKEN_RESPONSE,
	mockSpotifyAddToQueue,
	mockSpotifyCurrentlyPlaying,
	mockSpotifyGetTrack,
	mockSpotifyQueue,
	mockSpotifyTokenRefreshError,
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
import { fetchMock } from "../helpers/fetch-mock";

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

function mockTwitchRedemptionFailure(status: number): void {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({
				path: /\/helix\/channel_points\/custom_rewards\/redemptions/,
				method: "PATCH",
			})
			.reply(status, "Redemption update failed");
	}
}

describe("SongRequestSagaDO", () => {
	it("rejects invalid parameters before persistence or business effects", async () => {
		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);

		const result = await stub.start({ user_input: 42 });

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaInputParseError",
				codecName: "song-request-params",
			});
		}
		expect(await stub.getStatus()).toEqual({ status: "ok", value: null });
	});

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

		const startResult = await stub.start({ ...params, _tag: "SongRequestRedemption" });
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

		const duplicateResult = await stub.start({
			...params,
			user_name: "DifferentViewer",
			user_input: "spotify:track:DifferentValidTrackId",
		});
		expect(duplicateResult.status).toBe("ok");

		const persistedParams = await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return (await db.query.sagaRuns.findFirst())?.paramsJson;
		});
		expect(persistedParams).toBe(JSON.stringify(params));
	});

	it("stops before business orchestration when persisted parameters are malformed", async () => {
		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);
		const params = createSongRequestParams({ id: `redemption-${crypto.randomUUID()}` });
		await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const now = new Date().toISOString();
			await db.insert(sagaSchema.sagaRuns).values({
				id: instance.ctx.id.toString(),
				status: "RUNNING",
				paramsJson: JSON.stringify({ ...params, user_input: 42 }),
				createdAt: now,
				updatedAt: now,
			});
		});

		const result = await stub.start(params);

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaPersistedDataError",
				field: "params",
				codecName: "song-request-params",
			});
		}
		const steps = await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return db.query.sagaSteps.findMany();
		});
		expect(steps).toEqual([]);
	});

	it("rejects a malformed cached Spotify Track without repeating the lookup", async () => {
		await ensureTwitchTokenStub();
		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);
		const params = createSongRequestParams({ id: `redemption-${crypto.randomUUID()}` });
		const trackId = "4iV5W9uYEdYUVa79Axb7Rh";
		await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const now = new Date().toISOString();
			await db.insert(sagaSchema.sagaRuns).values({
				id: sagaId,
				status: "RUNNING",
				paramsJson: JSON.stringify(params),
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(sagaSchema.sagaSteps).values([
				{
					sagaId,
					stepName: "parse-spotify-url",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify(trackId),
				},
				{
					sagaId,
					stepName: "get-track-info",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify({ id: trackId }),
				},
			]);
		});
		mockTwitchRedemptionUpdate(fetchMock);
		mockTwitchChatMessage(fetchMock);

		const result = await stub.start(params);

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaPersistedDataError",
				field: "step-result",
				stepName: "get-track-info",
				codecName: "song-request-spotify-track",
			});
		}
		const steps = await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return db.query.sagaSteps.findMany();
		});
		expect(steps).toHaveLength(2);
		expect(steps).toEqual(
			expect.arrayContaining([expect.objectContaining({ stepName: "get-track-info", attempt: 1 })]),
		);
	});

	it("never passes a malformed cached undo payload to compensation", async () => {
		await ensureTwitchTokenStub();
		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);
		const params = createSongRequestParams({ id: `redemption-${crypto.randomUUID()}` });
		const trackId = "4iV5W9uYEdYUVa79Axb7Rh";
		await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const sagaId = instance.ctx.id.toString();
			const now = new Date().toISOString();
			await db.insert(sagaSchema.sagaRuns).values({
				id: sagaId,
				status: "RUNNING",
				paramsJson: JSON.stringify(params),
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(sagaSchema.sagaSteps).values([
				{
					sagaId,
					stepName: "parse-spotify-url",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify(trackId),
				},
				{
					sagaId,
					stepName: "get-track-info",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify({
						id: trackId,
						name: "Test Track",
						artists: ["Test Artist"],
						album: "Test Album",
						albumCoverUrl: null,
					}),
				},
				{
					sagaId,
					stepName: "persist-request",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify(sagaId),
					undoJson: JSON.stringify({ eventId: 42 }),
				},
			]);
		});
		mockTwitchRedemptionUpdate(fetchMock);
		mockTwitchChatMessage(fetchMock);

		const result = await stub.start(params);

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaPersistedDataError",
				field: "step-undo",
				stepName: "persist-request",
				codecName: "song-request-persist-request-undo",
			});
		}
		const persistStep = await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return db.query.sagaSteps.findFirst({
				where: (step, operators) => operators.eq(step.stepName, "persist-request"),
			});
		});
		expect(persistStep).toMatchObject({ state: "SUCCEEDED" });
	});

	it("replays valid cached values and preserves post-fulfillment effects on corruption", async () => {
		await ensureTwitchTokenStub();
		const songQueueStub = await ensureSongQueueStub();
		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);
		const sagaId = stub.id.toString();
		const params = createSongRequestParams({ id: `redemption-${crypto.randomUUID()}` });
		const trackId = "4iV5W9uYEdYUVa79Axb7Rh";
		const persistedTrack = {
			id: trackId,
			name: "Test Track",
			artists: ["Test Artist"],
			album: "Test Album",
			albumCoverUrl: null,
		};
		const persisted = await songQueueStub.persistRequest({
			...TEST_PENDING_REQUEST,
			eventId: sagaId,
			requesterUserId: params.user_id,
			requesterDisplayName: params.user_name,
		});
		expect(persisted.status).toBe("ok");

		await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			const now = new Date().toISOString();
			await db.insert(sagaSchema.sagaRuns).values({
				id: sagaId,
				status: "RUNNING",
				paramsJson: JSON.stringify(params),
				fulfilledAt: now,
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(sagaSchema.sagaSteps).values([
				{
					sagaId,
					stepName: "parse-spotify-url",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify(trackId),
				},
				{
					sagaId,
					stepName: "get-track-info",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify(persistedTrack),
				},
				{
					sagaId,
					stepName: "persist-request",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify(sagaId),
					undoJson: JSON.stringify({ eventId: sagaId }),
				},
				{
					sagaId,
					stepName: "add-to-spotify-queue",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify(trackId),
					undoJson: JSON.stringify({ trackId }),
				},
				{
					sagaId,
					stepName: "fulfill-redemption",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: "null",
				},
				{
					sagaId,
					stepName: "send-chat-confirmation",
					state: "SUCCEEDED",
					attempt: 1,
					resultJson: JSON.stringify("not-the-no-result-dto"),
				},
			]);
		});

		fetchMock
			.get("https://api.twitch.tv")
			.intercept({
				path: /\/helix\/channel_points\/custom_rewards\/redemptions/,
				method: "PATCH",
			})
			.reply(200, JSON.stringify({ data: [{}] }));
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: "/helix/chat/messages", method: "POST" })
			.reply(200, JSON.stringify({ data: [{}] }));

		const result = await stub.start(params);

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaPersistedDataError",
				field: "step-result",
				stepName: "send-chat-confirmation",
				codecName: "no-result",
			});
		}
		const pendingRequest = await runInDurableObject(
			songQueueStub,
			async (instance: SongQueueDO) => {
				const db = drizzle(instance.ctx.storage, { schema: songQueueSchema });
				return db.query.pendingRequests.findFirst({
					where: (request, operators) => operators.eq(request.eventId, sagaId),
				});
			},
		);
		expect(pendingRequest).toMatchObject({ eventId: sagaId });

		const stepStates = await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return db.query.sagaSteps.findMany();
		});
		expect(stepStates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stepName: "persist-request", state: "SUCCEEDED" }),
				expect.objectContaining({ stepName: "add-to-spotify-queue", state: "SUCCEEDED" }),
			]),
		);

		let unconsumedEffects = "";
		try {
			fetchMock.assertNoPendingInterceptors();
		} catch (error) {
			unconsumedEffects = error instanceof Error ? error.message : String(error);
		}
		expect(unconsumedEffects).toContain("PATCH https://api.twitch.tv");
		expect(unconsumedEffects).toContain("POST https://api.twitch.tv/helix/chat/messages");
		fetchMock.reset();
		await cancelSongQueueSchedules(songQueueStub);
	});

	it("restores a pending retry schedule from durable saga rows during startup", async () => {
		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);
		const now = new Date().toISOString();
		const dueAt = new Date(Date.now() + 60_000).toISOString();
		const params = createSongRequestParams({
			id: `redemption-${crypto.randomUUID()}`,
		});

		const restoration = await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
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
			return { schedules: instance.getSchedules(), state: instance.state };
		});

		expect(restoration.schedules).toHaveLength(1);
		expect(restoration.schedules[0]).toMatchObject({
			type: "scheduled",
			callback: "retrySagaTick",
			payload: dueAt,
			time: Math.floor(new Date(dueAt).getTime() / 1000),
		});
		expect(restoration.state).toMatchObject({
			retryScheduleId: restoration.schedules[0]?.id,
			retryDueAt: dueAt,
		});
	});

	it("compensates the Pending Request and refunds a permanent pre-fulfillment failure", async () => {
		await ensureSpotifyTokenStub();
		await ensureTwitchTokenStub();
		const songQueueStub = await ensureSongQueueStub();
		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);
		const params = createSongRequestParams({ id: `redemption-${crypto.randomUUID()}` });
		const trackId = "4iV5W9uYEdYUVa79Axb7Rh";

		mockSpotifyGetTrack(fetchMock, trackId);
		fetchMock
			.get("https://api.spotify.com")
			.intercept({ path: "/v1/me/player/queue" })
			.reply(200, JSON.stringify({ currently_playing: null, queue: [] }), {
				headers: { "content-type": "application/json" },
			});
		mockSpotifyAddToQueue(fetchMock);
		mockTwitchRedemptionFailure(400);
		mockSpotifyCurrentlyPlaying(fetchMock, false);
		mockTwitchRedemptionUpdate(fetchMock);
		mockTwitchChatMessage(fetchMock);

		const result = await stub.start(params);

		expect(result.status).toBe("error");
		const status = await stub.getStatus();
		expect(status).toMatchObject({ status: "ok", value: { status: "FAILED" } });
		const pendingRequest = await runInDurableObject(
			songQueueStub,
			async (instance: SongQueueDO) => {
				const db = drizzle(instance.ctx.storage, { schema: songQueueSchema });
				return db.query.pendingRequests.findFirst({
					where: (request, operators) => operators.eq(request.eventId, stub.id.toString()),
				});
			},
		);
		expect(pendingRequest).toBeUndefined();

		const compensatedSteps = await runInDurableObject(stub, async (instance: SongRequestSagaDO) => {
			const db = drizzle(instance.ctx.storage, { schema: sagaSchema });
			return db.query.sagaSteps.findMany();
		});
		expect(compensatedSteps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stepName: "persist-request", state: "COMPENSATED" }),
				expect.objectContaining({ stepName: "add-to-spotify-queue", state: "COMPENSATED" }),
			]),
		);
		await cancelSongQueueSchedules(songQueueStub);
	}, 20_000);

	it("refunds without blaming the viewer when Spotify authorization was revoked", async () => {
		const spotifyTokenStub = await ensureSpotifyTokenStub();
		await ensureTwitchTokenStub();
		await runInDurableObject(spotifyTokenStub, async (instance: SpotifyTokenDO) => {
			await instance.setTokens({
				...VALID_SPOTIFY_TOKEN_RESPONSE,
				expires_in: -3600,
			});
			instance.setState({ ...instance.state, isStreamLive: true });
		});

		const stub = await createSongRequestSagaStub(`song-request-saga-${crypto.randomUUID()}`);
		const params = createSongRequestParams({
			id: `redemption-${crypto.randomUUID()}`,
			user_input: "https://open.spotify.com/track/6gPd6brcBXlbGdy1obe234?si=302a66660b5d4070",
		});

		mockSpotifyTokenRefreshError(
			fetchMock,
			400,
			JSON.stringify({
				error: "invalid_grant",
				error_description: "Refresh token revoked",
			}),
		);
		mockTwitchRedemptionUpdate(fetchMock);
		mockTwitchChatMessage(fetchMock);

		const startResult = await stub.start(params);

		expect(startResult.status).toBe("error");
		const chatRequest = fetchMock
			.getRequests()
			.find((request) => new URL(request.url).pathname === "/helix/chat/messages");
		expect(chatRequest?.body).not.toBeNull();
		if (chatRequest?.body !== null && chatRequest?.body !== undefined) {
			expect(JSON.parse(chatRequest.body)).toMatchObject({
				message: `@${params.user_name} Spotify song requests are unavailable right now and your points have been refunded.`,
			});
		}
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
		const chatRequest = fetchMock
			.getRequests()
			.find((request) => new URL(request.url).pathname === "/helix/chat/messages");
		expect(chatRequest?.body).not.toBeNull();
		if (chatRequest?.body !== null && chatRequest?.body !== undefined) {
			expect(JSON.parse(chatRequest.body)).toMatchObject({
				message: `@${params.user_name} your song request was invalid and your points have been refunded. Did you use a valid Spotify track link?`,
			});
		}
	});
});
