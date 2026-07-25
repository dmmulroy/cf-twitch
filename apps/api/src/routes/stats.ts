/**
 * Public analytics routes with canonical, runtime-validated edge caching.
 */

import { Hono } from "hono";
import { z } from "zod";

import { UserStatsNotFoundError } from "../durable-objects/keyboard-raffle-do";
import { withEdgeCache } from "../lib/cache";
import { getStub } from "../lib/durable-objects";
import { DurableObjectError } from "../lib/errors";
import { readHttpQueryParameters } from "../lib/http-query-parameters";
import { type AppRouteEnv, getRequestLogger } from "../lib/request-context";
import { getSongQueue } from "../lib/song-queue-client";

import type { Logger } from "../lib/logger";
import type { Env } from "../index";

const stats = new Hono<AppRouteEnv<Env>>();
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
	z
		.object({
			trackId: z.string().min(1),
			trackName: z.string().min(1),
			artists: ArtistNamesSchema,
			requestCount: z.number().int().nonnegative(),
		})
		.strict(),
);
const TopRequestersResponseSchema = z.array(
	z
		.object({
			userId: ViewerIdSchema,
			displayName: z.string().min(1),
			requestCount: z.number().int().nonnegative(),
		})
		.strict(),
);
const RaffleLeaderboardEntrySchema = z
	.object({
		userId: ViewerIdSchema,
		displayName: z.string().min(1),
		totalRolls: z.number().int().nonnegative(),
		totalWins: z.number().int().nonnegative(),
		closestDistance: z.number().int().nonnegative().nullable(),
		closestRoll: z.number().int().positive().nullable(),
		closestWinningNumber: z.number().int().positive().nullable(),
		lastRolledAt: z.iso.datetime(),
	})
	.strict();
const RaffleLeaderboardResponseSchema = z.array(RaffleLeaderboardEntrySchema);

function makeStatsCacheKey(canonicalPath: string, parameters: Record<string, string>): string {
	const url = new URL(canonicalPath, "https://stats.internal");
	for (const [key, value] of Object.entries(parameters).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

function isDurableObjectError(error: unknown): error is DurableObjectError {
	return (
		DurableObjectError.is(error) ||
		(typeof error === "object" && error !== null && "_tag" in error && error._tag === "DurableObjectError")
	);
}

function isUserStatsNotFound(error: unknown): boolean {
	return (
		UserStatsNotFoundError.is(error) ||
		(typeof error === "object" &&
			error !== null &&
			"_tag" in error &&
			error._tag === "UserStatsNotFoundError")
	);
}

function statsCacheFailureOptions<T>(
	cacheKey: string,
	valueSchema: z.ZodType<T>,
	routeLogger: Logger,
) {
	return {
		cacheKey,
		valueSchema,
		onInvalidValue: (issues: readonly z.core.$ZodIssue[]) => {
			routeLogger.error("Stats response contract validation failed", {
				event: "stats.response_validation_failed",
				issue_count: issues.length,
			});
			return Response.json({ error: "Invalid service response" }, { status: 502 });
		},
		onFetcherFailure: (cause: unknown) => {
			routeLogger.error("Stats dependency unavailable", {
				event: "stats.dependency_unavailable",
				error_tag: cause instanceof Error ? cause.name : "UnknownFailure",
			});
			return Response.json({ error: "Service temporarily unavailable" }, { status: 503 });
		},
	};
}

stats.get("/top-tracks", async (c) => {
	const routeLogger = getRequestLogger(c).child({ route: "/api/stats/top-tracks", component: "route" });
	const query = LimitQuerySchema.safeParse(readHttpQueryParameters(c.req.url));
	if (!query.success) return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);

	const { limit } = query.data;
	return withEdgeCache(
		c,
		async () => {
			using songQueue = await getSongQueue();
			return songQueue.getTopTracks(limit);
		},
		(error) => {
			if (isDurableObjectError(error)) return c.json({ error: "Service temporarily unavailable" }, 503);
			routeLogger.error("Failed to get top tracks", { event: "stats.top_tracks.failed", limit });
			return c.json({ error: "Failed to fetch top tracks" }, 500);
		},
		statsCacheFailureOptions(
			makeStatsCacheKey("/api/stats/top-tracks", { limit: String(limit) }),
			TopTracksResponseSchema,
			routeLogger,
		),
	);
});

stats.get("/top-tracks/:user", async (c) => {
	const routeLogger = getRequestLogger(c).child({ route: "/api/stats/top-tracks/:user", component: "route" });
	const query = LimitQuerySchema.safeParse(readHttpQueryParameters(c.req.url));
	const viewerId = ViewerIdSchema.safeParse(c.req.param("user"));
	if (!query.success || !viewerId.success) {
		return c.json({ error: "Invalid request parameters" }, 400);
	}

	const { limit } = query.data;
	return withEdgeCache(
		c,
		async () => {
			using songQueue = await getSongQueue();
			return songQueue.getTopTracksByUser(viewerId.data, limit);
		},
		(error) => {
			if (isDurableObjectError(error)) return c.json({ error: "Service temporarily unavailable" }, 503);
			return c.json({ error: "Failed to fetch top tracks" }, 500);
		},
		statsCacheFailureOptions(
			makeStatsCacheKey(`/api/stats/top-tracks/${viewerId.data}`, { limit: String(limit) }),
			TopTracksResponseSchema,
			routeLogger,
		),
	);
});

stats.get("/top-requesters", async (c) => {
	const routeLogger = getRequestLogger(c).child({ route: "/api/stats/top-requesters", component: "route" });
	const query = LimitQuerySchema.safeParse(readHttpQueryParameters(c.req.url));
	if (!query.success) return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);

	const { limit } = query.data;
	return withEdgeCache(
		c,
		async () => {
			using songQueue = await getSongQueue();
			return songQueue.getTopRequesters(limit);
		},
		(error) => {
			if (isDurableObjectError(error)) return c.json({ error: "Service temporarily unavailable" }, 503);
			return c.json({ error: "Failed to fetch top requesters" }, 500);
		},
		statsCacheFailureOptions(
			makeStatsCacheKey("/api/stats/top-requesters", { limit: String(limit) }),
			TopRequestersResponseSchema,
			routeLogger,
		),
	);
});

stats.get("/raffle/leaderboard", async (c) => {
	const routeLogger = getRequestLogger(c).child({ route: "/api/stats/raffle/leaderboard", component: "route" });
	const query = LeaderboardQuerySchema.safeParse(readHttpQueryParameters(c.req.url));
	if (!query.success) return c.json({ error: "Invalid query parameters", details: query.error.issues }, 400);

	return withEdgeCache(
		c,
		() => getStub("KEYBOARD_RAFFLE_DO").getLeaderboard(query.data),
		(error) => {
			if (isDurableObjectError(error)) return c.json({ error: "Service temporarily unavailable" }, 503);
			return c.json({ error: "Failed to fetch leaderboard" }, 500);
		},
		statsCacheFailureOptions(
			makeStatsCacheKey("/api/stats/raffle/leaderboard", {
				limit: String(query.data.limit),
				sortBy: query.data.sortBy,
			}),
			RaffleLeaderboardResponseSchema,
			routeLogger,
		),
	);
});

stats.get("/raffle/user/:user", async (c) => {
	const routeLogger = getRequestLogger(c).child({ route: "/api/stats/raffle/user/:user", component: "route" });
	const viewerId = ViewerIdSchema.safeParse(c.req.param("user"));
	const query = z.object({}).strict().safeParse(readHttpQueryParameters(c.req.url));
	if (!viewerId.success || !query.success) return c.json({ error: "Invalid request parameters" }, 400);

	return withEdgeCache(
		c,
		() => getStub("KEYBOARD_RAFFLE_DO").getUserStats(viewerId.data),
		(error) => {
			if (isUserStatsNotFound(error)) return c.json({ error: "User not found" }, 404);
			if (isDurableObjectError(error)) return c.json({ error: "Service temporarily unavailable" }, 503);
			return c.json({ error: "Failed to fetch user stats" }, 500);
		},
		statsCacheFailureOptions(
			makeStatsCacheKey(`/api/stats/raffle/user/${viewerId.data}`, {}),
			RaffleLeaderboardEntrySchema,
			routeLogger,
		),
	);
});

export default stats;
