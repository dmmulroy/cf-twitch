import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { DurableObjectSpotifyAccessTokens } from "../../adapters/cloudflare/durable-object-access-tokens";
import { DurableObjectSongQueue } from "../../adapters/cloudflare/durable-object-song-queue";
import { LoggingTracer } from "../../capabilities/tracer";
import { logger } from "../../lib/logger";
import {
	VALID_TOKEN_RESPONSE,
	mockSpotifyCurrentlyPlaying,
	mockSpotifyQueue,
} from "../fixtures/spotify";
import { fetchMock } from "../helpers/fetch-mock";

describe("DurableObjectSongQueue currently playing", () => {
	it("returns currently playing through the parsed adapter", async () => {
		const tracer = new LoggingTracer(logger);
		const spotifyTokens = new DurableObjectSpotifyAccessTokens(env.SPOTIFY_TOKEN_DO, tracer);
		const setTokensResult = await spotifyTokens.setTokens(VALID_TOKEN_RESPONSE);
		expect(setTokensResult.status).toBe("ok");

		mockSpotifyCurrentlyPlaying(fetchMock);
		mockSpotifyQueue(fetchMock);

		const songQueue = new DurableObjectSongQueue(env.SONG_QUEUE_DO, tracer);
		const nowPlayingResult = await songQueue.getNowPlaying();

		expect(nowPlayingResult.status).toBe("ok");
		if (nowPlayingResult.status === "ok") {
			expect(nowPlayingResult.value.track?.id).toBe("4iV5W9uYEdYUVa79Axb7Rh");
			expect(nowPlayingResult.value.position).toBe(0);
		}
	});
});
