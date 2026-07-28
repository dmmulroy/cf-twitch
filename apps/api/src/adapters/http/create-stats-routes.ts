/** Public analytics routes with canonical, runtime-validated edge caching. */

import { Hono } from "hono";
import { z } from "zod";

import {
	RaffleStatisticsReadError,
	RaffleViewerNotFoundError,
} from "../../capabilities/raffle-statistics";
import { SongQueueUnavailableError } from "../../capabilities/song-queue";
import { RaffleLeaderboardEntrySchema } from "../../domain/keyboard-raffle";
import { TopRequestedTrackSchema, TopSongRequesterSchema } from "../../domain/song-request";
import { readHttpQueryParameters } from "../../lib/http-query-parameters";
import {
	EdgeCacheLoadError,
	EdgeCacheValueError,
} from "../cloudflare/cloudflare-edge-response-cache";

import type { RaffleStatistics } from "../../capabilities/raffle-statistics";
import type { SongRequestStatistics } from "../../capabilities/song-queue";
import type { Logger } from "../../lib/logging";
import type { CloudflareEdgeResponseCache } from "../cloudflare/cloudflare-edge-response-cache";
import type { Context } from "hono";

const LimitSchema = z.coerce.number().int().min(1).max(100).default(10);
const LimitQuerySchema = z.object({ limit: LimitSchema }).strict();
const LeaderboardQuerySchema = z
	.object({ sortBy: z.enum(["rolls", "wins", "closest"]).default("closest"), limit: LimitSchema })
	.strict();
const ViewerIdSchema = z
	.string()
	.regex(/^\d{1,20}$/u, "Viewer ID must be 1 to 20 digits")
	.brand<"ViewerId">();

const ArtistNamesSchema = z.preprocess((input) => {
	if (typeof input !== "string") return input;
	try {
		return JSON.parse(input);
	} catch {
		return input;
	}
}, z.array(z.string()));
const TopTracksResponseSchema = z.array(
	TopRequestedTrackSchema.extend({ artists: ArtistNamesSchema }).strict(),
);
const TopRequestersResponseSchema = z.array(
	TopSongRequesterSchema.extend({ userId: z.string().regex(/^\d{1,20}$/u) }).strict(),
);
const RaffleLeaderboardResponseSchema = z.array(
	RaffleLeaderboardEntrySchema.extend({ userId: z.string().regex(/^\d{1,20}$/u) }).strict(),
);
const RaffleViewerStatsResponseSchema = RaffleLeaderboardEntrySchema.extend({
	userId: z.string().regex(/^\d{1,20}$/u),
}).strict();

/** Exact dependencies required by public statistics routes. */
export type StatsRouteDependencies = Readonly<{
	songRequests: SongRequestStatistics;
	raffles: RaffleStatistics;
	edgeResponseCache: CloudflareEdgeResponseCache;
	logger: Logger;
}>;

function makeStatsCacheKey(canonicalPath: string, parameters: Record<string, string>): string {
	const url = new URL(canonicalPath, "https://stats.internal");
	for (const [key, value] of Object.entries(parameters).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

/** Creates statistics routes without Hono context bindings or ambient Cache API access. */
export function createStatsRoutes(dependencies: StatsRouteDependencies): Hono {
	const stats = new Hono();

	stats.get("/top-tracks", async (context) => {
		const query = LimitQuerySchema.safeParse(readHttpQueryParameters(context.req.url));
		if (!query.success)
			return context.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
		const { limit } = query.data;
		const result = await dependencies.edgeResponseCache.readThrough({
			key: makeStatsCacheKey("/api/stats/top-tracks", { limit: String(limit) }),
			maxAgeSeconds: 60,
			schema: TopTracksResponseSchema,
			load: () => dependencies.songRequests.getTopTracks(limit),
		});
		if (result.status === "error")
			return projectStatsFailure(context, result.error, dependencies.logger, "top_tracks");
		return context.json(result.value, 200, { "Cache-Control": "public, max-age=60" });
	});

	stats.get("/top-tracks/:user", async (context) => {
		const query = LimitQuerySchema.safeParse(readHttpQueryParameters(context.req.url));
		const viewerId = ViewerIdSchema.safeParse(context.req.param("user"));
		if (!query.success || !viewerId.success)
			return context.json({ error: "Invalid request parameters" }, 400);
		const { limit } = query.data;
		const result = await dependencies.edgeResponseCache.readThrough({
			key: makeStatsCacheKey(`/api/stats/top-tracks/${viewerId.data}`, {
				limit: String(limit),
			}),
			maxAgeSeconds: 60,
			schema: TopTracksResponseSchema,
			load: () => dependencies.songRequests.getViewerTopTracks(viewerId.data, limit),
		});
		if (result.status === "error")
			return projectStatsFailure(context, result.error, dependencies.logger, "viewer_top_tracks");
		return context.json(result.value, 200, { "Cache-Control": "public, max-age=60" });
	});

	stats.get("/top-requesters", async (context) => {
		const query = LimitQuerySchema.safeParse(readHttpQueryParameters(context.req.url));
		if (!query.success)
			return context.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
		const { limit } = query.data;
		const result = await dependencies.edgeResponseCache.readThrough({
			key: makeStatsCacheKey("/api/stats/top-requesters", { limit: String(limit) }),
			maxAgeSeconds: 60,
			schema: TopRequestersResponseSchema,
			load: () => dependencies.songRequests.getTopRequesters(limit),
		});
		if (result.status === "error")
			return projectStatsFailure(context, result.error, dependencies.logger, "top_requesters");
		return context.json(result.value, 200, { "Cache-Control": "public, max-age=60" });
	});

	stats.get("/raffle/leaderboard", async (context) => {
		const query = LeaderboardQuerySchema.safeParse(readHttpQueryParameters(context.req.url));
		if (!query.success)
			return context.json({ error: "Invalid query parameters", details: query.error.issues }, 400);
		const result = await dependencies.edgeResponseCache.readThrough({
			key: makeStatsCacheKey("/api/stats/raffle/leaderboard", {
				limit: String(query.data.limit),
				sortBy: query.data.sortBy,
			}),
			maxAgeSeconds: 60,
			schema: RaffleLeaderboardResponseSchema,
			load: () => dependencies.raffles.getLeaderboard(query.data),
		});
		if (result.status === "error")
			return projectStatsFailure(context, result.error, dependencies.logger, "raffle_leaderboard");
		return context.json(result.value, 200, { "Cache-Control": "public, max-age=60" });
	});

	stats.get("/raffle/user/:user", async (context) => {
		const viewerId = ViewerIdSchema.safeParse(context.req.param("user"));
		const query = z.object({}).strict().safeParse(readHttpQueryParameters(context.req.url));
		if (!viewerId.success || !query.success)
			return context.json({ error: "Invalid request parameters" }, 400);
		const result = await dependencies.edgeResponseCache.readThrough({
			key: makeStatsCacheKey(`/api/stats/raffle/user/${viewerId.data}`, {}),
			maxAgeSeconds: 60,
			schema: RaffleViewerStatsResponseSchema,
			load: () => dependencies.raffles.getViewerStats(viewerId.data),
		});
		if (result.status === "error") {
			if (RaffleViewerNotFoundError.is(result.error))
				return context.json({ error: "User not found" }, 404);
			return projectStatsFailure(context, result.error, dependencies.logger, "raffle_viewer");
		}
		return context.json(result.value, 200, { "Cache-Control": "public, max-age=60" });
	});

	return stats;
}

function projectStatsFailure(
	context: Context,
	error: unknown,
	logger: Logger,
	operation: string,
): Response {
	if (EdgeCacheValueError.is(error)) {
		logger.error("Stats response contract validation failed", {
			event: "stats.response_validation_failed",
			operation,
		});
		return context.json({ error: "Invalid service response" }, 502);
	}
	if (
		EdgeCacheLoadError.is(error) ||
		SongQueueUnavailableError.is(error) ||
		(RaffleStatisticsReadError.is(error) && error.failure === "transport")
	) {
		return context.json({ error: "Service temporarily unavailable" }, 503);
	}
	logger.error("Statistics read failed", {
		event: "stats.read_failed",
		operation,
		error,
	});
	return context.json({ error: "Failed to fetch statistics" }, 500);
}
