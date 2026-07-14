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

import { SongQueueDO } from "../../durable-objects/song-queue-do";
import { getStub } from "../../lib/durable-objects";
import { getSongQueue } from "../../lib/song-queue-client";
import {
	VALID_TOKEN_RESPONSE,
	mockSpotifyCurrentlyPlaying,
	mockSpotifyQueue,
} from "../fixtures/spotify";
import { fetchMock } from "../helpers/fetch-mock";

describe("getSongQueue", () => {
	it("connects to SongQueueDO and initializes Agent names before scheduling refresh work", async () => {
		const spotifyTokenStub = getStub("SPOTIFY_TOKEN_DO");
		const setTokensResult = await spotifyTokenStub.setTokens(VALID_TOKEN_RESPONSE);
		expect(setTokensResult.status).toBe("ok");

		mockSpotifyCurrentlyPlaying(fetchMock);
		mockSpotifyQueue(fetchMock);

		using songQueue = await getSongQueue();
		const queueResult = await songQueue.getSongQueue(10);

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
