import { z } from "zod";

import type { Logger } from "./logger";
import type { Context } from "hono";

/** Server-owned identifier for one inbound HTTP request. */
export type RequestId = string & z.BRAND<"RequestId">;
/** Server-owned identifier correlating work started by one HTTP request. */
export type TraceId = string & z.BRAND<"TraceId">;

/** Creates a collision-resistant, server-owned HTTP request identifier. */
export function createRequestId(): RequestId {
	return z.uuid().brand<"RequestId">().parse(crypto.randomUUID());
}

/** Creates a collision-resistant trace identifier for one invocation. */
export function createTraceId(): TraceId {
	return z.uuid().brand<"TraceId">().parse(crypto.randomUUID());
}

/** Request-scoped logging and correlation stored in Hono variables. */
export interface RequestContextVariables {
	logger: Logger;
	requestId: RequestId;
	traceId: TraceId;
}

/** Hono environment combining runtime bindings with request-scoped variables. */
export type AppRouteEnv<Bindings extends object> = {
	Bindings: Bindings;
	Variables: RequestContextVariables;
};

/** Reads the request-scoped structured logger from a Hono context. */
export function getRequestLogger<Bindings extends object>(
	c: Context<AppRouteEnv<Bindings>>,
): Logger {
	return c.var.logger;
}
