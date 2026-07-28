/**
 * Regression tests for SongQueue client Agent naming.
 *
 * Production traffic was hitting Agent-backed DO RPC methods before the Agent
 * runtime had persisted a name, causing errors like:
 * "Attempting to read .name on _SongQueueDO before it was set".
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { DurableObjectSpotifyAccessTokens } from "../../adapters/cloudflare/durable-object-access-tokens";
import { DurableObjectSongQueue } from "../../adapters/cloudflare/durable-object-song-queue";
import { LoggingTracer } from "../../capabilities/tracer";
import { SongQueueDO } from "../../durable-objects/song-queue-do";
import { logger } from "../../lib/logger";
import {
	VALID_TOKEN_RESPONSE,
	mockSpotifyCurrentlyPlaying,
	mockSpotifyQueue,
} from "../fixtures/spotify";
import { fetchMock } from "../helpers/fetch-mock";

describe("DurableObjectSongQueue", () => {
	it("initializes Agent names before scheduling refresh work", async () => {
		const tracer = new LoggingTracer(logger);
		const spotifyTokens = new DurableObjectSpotifyAccessTokens(env.SPOTIFY_TOKEN_DO, tracer);
		const setTokensResult = await spotifyTokens.setTokens(VALID_TOKEN_RESPONSE);
		expect(setTokensResult.status).toBe("ok");

		mockSpotifyCurrentlyPlaying(fetchMock);
		mockSpotifyQueue(fetchMock);

		const songQueue = new DurableObjectSongQueue(env.SONG_QUEUE_DO, tracer);
		const queueResult = await songQueue.getSpotifyQueue(10);

		expect(queueResult.status).toBe("ok");
		if (queueResult.status === "ok") {
			expect(queueResult.value.totalCount).toBe(1);
			expect(queueResult.value.tracks[0]?.id).toBe("4iV5W9uYEdYUVa79Axb7Rh");
		}

		const rawSongQueueStub = env.SONG_QUEUE_DO.get(env.SONG_QUEUE_DO.idFromName("song-queue"));
		const schedules = await runInDurableObject(rawSongQueueStub, (instance: SongQueueDO) => {
			return instance.getSchedules();
		});

		expect(schedules).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					callback: "refreshQueueTick",
					type: "delayed",
				}),
			]),
		);
	});
});
