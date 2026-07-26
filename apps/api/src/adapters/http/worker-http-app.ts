import { Hono } from "hono";

import { normalizeError, startTimer, withLogContext } from "../../lib/logger";
import admin from "../../routes/admin";
import api from "../../routes/api";
import eventsub from "../../routes/eventsub-setup";
import oauth from "../../routes/oauth";
import overlay from "../../routes/overlay";
import stats from "../../routes/stats";
import webhooks from "../../routes/webhooks";
import { createNowPlayingRoutes } from "./create-now-playing-routes";

import type { SongQueueReader } from "../../capabilities/song-queue-reader";
import type { Logger } from "../../lib/logger";
import type { AppRouteEnv, RequestId, TraceId } from "../../lib/request-context";

/** Correlation established once for a Worker HTTP invocation. */
export type HttpInvocationCorrelation = Readonly<{
	requestId: RequestId;
	traceId: TraceId;
}>;

/** Dependencies required to assemble one invocation-scoped HTTP application. */
export type WorkerHttpAppDependencies = Readonly<{
	correlation: HttpInvocationCorrelation;
	logger: Logger;
	songQueue: SongQueueReader;
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

	app.route("/oauth", oauth);
	app.route("/eventsub", eventsub);
	app.route("/webhooks", webhooks);
	app.route(
		"/api",
		createNowPlayingRoutes({
			songQueue: dependencies.songQueue,
			logger: dependencies.logger.child({ component: "route", route: "/api/now-playing" }),
		}),
	);
	app.route("/api", api);
	app.route("/api/stats", stats);
	app.route("/api/admin", admin);
	app.route("/overlay", overlay);
	app.get("/health", (context) => context.json({ status: "ok" }));

	return app;
}
