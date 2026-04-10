import type { Logger } from "./logger";
import type { Context } from "hono";

export interface RequestContextVariables {
	logger: Logger;
	requestId: string;
	traceId: string;
}

export type AppRouteEnv<Bindings extends object> = {
	Bindings: Bindings;
	Variables: RequestContextVariables;
};

export function getRequestLogger<Bindings extends object>(
	c: Context<AppRouteEnv<Bindings>>,
): Logger {
	return c.var.logger;
}
