import { Hono } from "hono";

import { SongQueueUnavailableError } from "../../capabilities/song-queue";

import type { SongQueueReader } from "../../capabilities/song-queue";
import type { Logger } from "../../lib/logger";

/** Exact dependencies required by the Now Playing HTTP route. */
export type NowPlayingRouteDependencies = Readonly<{
	songQueue: SongQueueReader;
	logger: Logger;
}>;

/** Creates the Now Playing HTTP route without Worker bindings or Durable Object lookup. */
export function createNowPlayingRoutes(dependencies: NowPlayingRouteDependencies): Hono {
	const routes = new Hono();

	routes.get("/now-playing", async (context) => {
		dependencies.logger.info("Loading now playing", {
			event: "api.now_playing.started",
		});
		const result = await dependencies.songQueue.getNowPlaying();
		if (result.status === "error") {
			dependencies.logger.error("Failed to get now playing", {
				event: "api.now_playing.failed",
				error_tag: result.error._tag,
			});
			return SongQueueUnavailableError.is(result.error)
				? context.json({ error: "Service temporarily unavailable" }, 503)
				: context.json({ error: "Failed to fetch now playing" }, 500);
		}

		dependencies.logger.info("Loaded now playing", {
			event: "api.now_playing.succeeded",
			has_track: result.value.track !== null,
			track_id: result.value.track?.id ?? undefined,
		});
		return context.json(result.value);
	});

	return routes;
}
