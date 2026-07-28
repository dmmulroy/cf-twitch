import { Result } from "better-result";
import { describe, expect, it } from "vite-plus/test";

import { SongQueueParseError, SongQueueUnavailableError } from "../../capabilities/song-queue";
import { Logger } from "../../lib/logger";
import { createNowPlayingRoutes } from "./create-now-playing-routes";

import type { SongQueueReader } from "../../capabilities/song-queue";

describe("Now Playing HTTP routes", () => {
	it("projects the current Spotify Track from the injected Song Queue reader", async () => {
		const songQueue: SongQueueReader = {
			getNowPlaying: () => Promise.resolve(Result.ok({ track: null, position: 0 })),
			getSpotifyQueue: () => Promise.resolve(Result.ok({ tracks: [], totalCount: 0 })),
		};
		const routes = createNowPlayingRoutes({ songQueue, logger: new Logger() });

		const response = await routes.request("/now-playing");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ track: null, position: 0 });
	});

	it("hides Song Queue failures behind the existing Now Playing HTTP contract", async () => {
		const songQueue: SongQueueReader = {
			getNowPlaying: () =>
				Promise.resolve(
					Result.err(
						new SongQueueParseError({
							boundary: "rpc-result",
							operation: "getCurrentlyPlaying",
							parseError: "malformed test payload",
						}),
					),
				),
			getSpotifyQueue: () => Promise.resolve(Result.ok({ tracks: [], totalCount: 0 })),
		};
		const routes = createNowPlayingRoutes({ songQueue, logger: new Logger() });

		const response = await routes.request("/now-playing");

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Failed to fetch now playing" });
	});

	it("preserves temporary unavailability as a retryable HTTP response", async () => {
		const songQueue: SongQueueReader = {
			getNowPlaying: () =>
				Promise.resolve(
					Result.err(
						new SongQueueUnavailableError({
							operation: "getNowPlaying",
							failure: "connect-rpc",
						}),
					),
				),
			getSpotifyQueue: () => Promise.resolve(Result.ok({ tracks: [], totalCount: 0 })),
		};
		const routes = createNowPlayingRoutes({ songQueue, logger: new Logger() });

		const response = await routes.request("/now-playing");

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "Service temporarily unavailable" });
	});
});
