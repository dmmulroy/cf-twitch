import { describe, expect, it } from "vite-plus/test";

import { getStub } from "../../lib/durable-objects";
import { getSongQueue } from "../../lib/song-queue-client";
import {
	VALID_TOKEN_RESPONSE,
	mockSpotifyCurrentlyPlaying,
	mockSpotifyQueue,
} from "../fixtures/spotify";
import { fetchMock } from "../helpers/fetch-mock";

describe("getSongQueue currently playing", () => {
	it("returns currently playing through the SongQueue client facade", async () => {
		const spotifyTokenStub = getStub("SPOTIFY_TOKEN_DO");
		const setTokensResult = await spotifyTokenStub.setTokens(VALID_TOKEN_RESPONSE);
		expect(setTokensResult.status).toBe("ok");

		mockSpotifyCurrentlyPlaying(fetchMock);
		mockSpotifyQueue(fetchMock);

		using songQueue = await getSongQueue();
		const nowPlayingResult = await songQueue.getCurrentlyPlaying();

		expect(nowPlayingResult.status).toBe("ok");
		if (nowPlayingResult.status === "ok") {
			expect(nowPlayingResult.value.track?.id).toBe("4iV5W9uYEdYUVa79Axb7Rh");
			expect(nowPlayingResult.value.position).toBe(0);
		}
	});
});
