/**
 * Regression tests for getStub() Agent naming.
 *
 * Production traffic was hitting Agent-backed DO RPC methods before the Agent
 * runtime had persisted a name, causing errors like:
 * "Attempting to read .name on _SongQueueDO before it was set".
 */

import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { SongQueueDO } from "../../durable-objects/song-queue-do";
import { getStub } from "../../lib/durable-objects";
import {
	VALID_TOKEN_RESPONSE,
	mockSpotifyCurrentlyPlaying,
	mockSpotifyQueue,
} from "../fixtures/spotify";

describe("getStub", () => {
	it("auto-initializes Agent names before SongQueueDO schedules refresh work", async () => {
		const spotifyTokenStub = getStub("SPOTIFY_TOKEN_DO");
		const setTokensResult = await spotifyTokenStub.setTokens(VALID_TOKEN_RESPONSE);
		expect(setTokensResult.status).toBe("ok");

		mockSpotifyCurrentlyPlaying(fetchMock);
		mockSpotifyQueue(fetchMock);

		const songQueueStub = getStub("SONG_QUEUE_DO");
		const queueResult = await songQueueStub.getSongQueue(10);

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
