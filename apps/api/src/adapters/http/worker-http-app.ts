import { Hono } from "hono";

import { normalizeError, startTimer, withLogContext } from "../../lib/logger";
import { createApiRoutes } from "./create-api-routes";
import { createNowPlayingRoutes } from "./create-now-playing-routes";
import { createStatsRoutes } from "./create-stats-routes";

import type { AchievementReader, StreamLifecycle } from "../../capabilities/http-state-readers";
import type { RaffleStatistics } from "../../capabilities/raffle-statistics";
import type { SongQueue } from "../../capabilities/song-queue";
import type { Logger } from "../../lib/logger";
import type { RedactedValue } from "../../lib/redacted";
import type { AppRouteEnv, RequestId, TraceId } from "../../lib/request-context";
import type { TwitchService } from "../../services/twitch-service";
import type { CloudflareEdgeResponseCache } from "../cloudflare/cloudflare-edge-response-cache";

/** Correlation established once for a Worker HTTP invocation. */
export type HttpInvocationCorrelation = Readonly<{
	requestId: RequestId;
	traceId: TraceId;
}>;

/** Dependencies required to assemble one invocation-scoped HTTP application. */
export type WorkerHttpAppDependencies = Readonly<{
	correlation: HttpInvocationCorrelation;
	logger: Logger;
	songQueue: SongQueue;
	raffles: RaffleStatistics;
	edgeResponseCache: CloudflareEdgeResponseCache;
	administratorSecret: RedactedValue<string>;
	streamLifecycle: StreamLifecycle;
	achievements: AchievementReader;
	twitchStreams: Pick<TwitchService, "getStreamInfo">;
	broadcasterDisplayName: string;
	oauthRoutes: Hono<AppRouteEnv<object>>;
	eventSubRoutes: Hono<AppRouteEnv<object>>;
	eventSubWebhookRoutes: Hono<AppRouteEnv<object>>;
	overlayRoutes: Hono<AppRouteEnv<object>>;
	adminRoutes: Hono<AppRouteEnv<object>>;
}>;

/** Assembles HTTP middleware and route groups for one Worker invocation. */
export function createWorkerHttpApp<Bindings extends object>(
	dependencies: WorkerHttpAppDependencies,
): Hono<AppRouteEnv<Bindings>> {
	const app = new Hono<AppRouteEnv<Bindings>>();

	app.use("*", async (context, next) => {
		const queryKeys = [...new URL(context.req.url).searchParams.keys()].sort();
		const requestTimer = startTimer();
		const requestLogger = dependencies.logger.child({
			component: "route",
			method: context.req.method,
			path: context.req.path,
			route: context.req.path,
		});

		context.set("logger", requestLogger);
		context.set("requestId", dependencies.correlation.requestId);
		context.set("traceId", dependencies.correlation.traceId);
		requestLogger.info("HTTP request received", {
			event: "http.request.received",
			query_keys: queryKeys,
			cf_ray: context.req.header("cf-ray"),
		});

		try {
			await withLogContext(
				{
					request_id: dependencies.correlation.requestId,
					trace_id: dependencies.correlation.traceId,
					method: context.req.method,
					path: context.req.path,
					route: context.req.path,
				},
				() => next(),
			);
			requestLogger.info("HTTP request completed", {
				event: "http.request.completed",
				status_code: context.res.status,
				duration_ms: requestTimer(),
			});
		} catch (error) {
			requestLogger.error("HTTP request failed", {
				event: "http.request.failed",
				status_code: 500,
				duration_ms: requestTimer(),
				...normalizeError(error),
			});
			context.res = context.json({ error: "Internal server error" }, 500);
		} finally {
			context.res = new Response(context.res.body, context.res);
			context.res.headers.set("x-request-id", dependencies.correlation.requestId);
			context.res.headers.set("x-trace-id", dependencies.correlation.traceId);
		}

		return context.res;
	});

	app.route("/oauth", dependencies.oauthRoutes);
	app.route("/eventsub", dependencies.eventSubRoutes);
	app.route("/webhooks", dependencies.eventSubWebhookRoutes);
	app.route(
		"/api",
		createNowPlayingRoutes({
			songQueue: dependencies.songQueue,
			logger: dependencies.logger.child({ component: "route", route: "/api/now-playing" }),
		}),
	);
	app.route(
		"/api",
		createApiRoutes({
			administratorSecret: dependencies.administratorSecret,
			songQueue: dependencies.songQueue,
			streamLifecycle: dependencies.streamLifecycle,
			raffles: dependencies.raffles,
			achievements: dependencies.achievements,
			twitchStreams: dependencies.twitchStreams,
			broadcasterDisplayName: dependencies.broadcasterDisplayName,
		}),
	);
	app.route(
		"/api/stats",
		createStatsRoutes({
			songRequests: dependencies.songQueue,
			raffles: dependencies.raffles,
			edgeResponseCache: dependencies.edgeResponseCache,
			logger: dependencies.logger,
		}),
	);
	app.route("/api/admin", dependencies.adminRoutes);
	app.route("/overlay", dependencies.overlayRoutes);
	app.get("/health", (context) => context.json({ status: "ok" }));

	return app;
}
