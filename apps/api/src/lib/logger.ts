/**
 * Context-aware structured logger.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogComponent =
	| "route"
	| "durable_object"
	| "service"
	| "worker"
	| "tail"
	| "client"
	| "cache"
	| "analytics";

export interface LogContext {
	[key: string]: unknown;
}

export interface LogError {
	error_tag?: string;
	error_message?: string;
	error_stack?: string;
}

const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 1000;
const asyncLogContext = new AsyncLocalStorage<LogContext>();

const SENSITIVE_KEYS = new Set([
	"access_token",
	"refresh_token",
	"client_secret",
	"authorization",
	"code",
	"oauth_code",
	"user_input",
	"raw_body",
	"rawbody",
	"message_body",
	"chat_message",
	"twitch_eventsub_message_signature",
	"x_hub_signature",
	"x_hub_signature_256",
	"signature",
]);

function camelToSnake(key: string): string {
	return key
		.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replaceAll(/[-\s]+/g, "_")
		.toLowerCase();
}

function inferComponent(context: LogContext): LogComponent {
	const component = context.component;
	if (
		component === "route" ||
		component === "durable_object" ||
		component === "service" ||
		component === "worker" ||
		component === "tail" ||
		component === "client" ||
		component === "cache" ||
		component === "analytics"
	) {
		return component;
	}

	if (typeof context.cache_key === "string" || typeof context.ttl_seconds === "number") {
		return "cache";
	}

	if (typeof context.metric_name === "string") {
		return "analytics";
	}

	if (
		typeof context.provider === "string" ||
		typeof context.external_url === "string" ||
		typeof context.request_kind === "string"
	) {
		return "service";
	}

	if (
		typeof context.do_name === "string" ||
		typeof context.do_id === "string" ||
		typeof context.rpc_method === "string" ||
		typeof context.saga_id === "string" ||
		typeof context.stream_session_id === "string"
	) {
		return "durable_object";
	}

	if (
		typeof context.route === "string" ||
		typeof context.path === "string" ||
		typeof context.method === "string" ||
		typeof context.request_id === "string"
	) {
		return "route";
	}

	if (typeof context.script_name === "string") {
		return "tail";
	}

	return "worker";
}

function fallbackEvent(level: LogLevel, message: string): string {
	const slug = camelToSnake(message)
		.replaceAll(/[^a-z0-9_]+/g, "_")
		.replaceAll(/^_+|_+$/g, "")
		.replaceAll(/_+/g, "_");

	return slug.length > 0 ? `log.${slug}` : `log.${level}`;
}

function truncateString(value: string): string {
	if (value.length <= MAX_STRING_LENGTH) {
		return value;
	}

	return `${value.slice(0, MAX_STRING_LENGTH)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Error)
	);
}

export function normalizeError(error: unknown): LogError {
	if (error instanceof Error) {
		const tagged = error as Error & { _tag?: unknown };
		return {
			error_tag: typeof tagged._tag === "string" ? tagged._tag : error.name || "Error",
			error_message: error.message,
			error_stack: error.stack,
		};
	}

	if (typeof error === "object" && error !== null) {
		const tagged = error as { _tag?: unknown; message?: unknown; stack?: unknown; name?: unknown };
		return {
			error_tag:
				typeof tagged._tag === "string"
					? tagged._tag
					: typeof tagged.name === "string"
						? tagged.name
						: "UnknownError",
			error_message:
				typeof tagged.message === "string" ? truncateString(tagged.message) : String(error),
			error_stack: typeof tagged.stack === "string" ? truncateString(tagged.stack) : undefined,
		};
	}

	return {
		error_tag: "UnknownError",
		error_message: truncateString(String(error)),
	};
}

function sanitizeValue(key: string, value: unknown, depth = 0): unknown {
	if (depth > 4) {
		return "[Truncated]";
	}

	const normalizedKey = camelToSnake(key);

	if (SENSITIVE_KEYS.has(normalizedKey)) {
		if (typeof value === "string") {
			if (normalizedKey === "code") {
				return undefined;
			}
			return REDACTED;
		}
		return REDACTED;
	}

	if (value instanceof Error) {
		return normalizeError(value);
	}

	if (typeof value === "string") {
		return truncateString(value);
	}

	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null ||
		value === undefined
	) {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(key, item, depth + 1));
	}

	if (typeof value === "bigint") {
		return value.toString();
	}

	if (value instanceof URL) {
		return value.toString();
	}

	if (isPlainObject(value)) {
		const nested: Record<string, unknown> = {};
		for (const [nestedKey, nestedValue] of Object.entries(value)) {
			const normalizedNestedKey = camelToSnake(nestedKey);

			if (normalizedNestedKey === "error") {
				const normalized = normalizeError(nestedValue);
				for (const [errorKey, errorValue] of Object.entries(normalized)) {
					if (errorValue !== undefined) {
						nested[errorKey] = errorValue;
					}
				}
				continue;
			}

			if (normalizedNestedKey === "user_input" && typeof nestedValue === "string") {
				nested.input_length = nestedValue.length;
				continue;
			}

			if (normalizedNestedKey === "raw_body" && typeof nestedValue === "string") {
				nested.body_size_bytes = nestedValue.length;
				continue;
			}

			const sanitized = sanitizeValue(normalizedNestedKey, nestedValue, depth + 1);
			if (sanitized !== undefined) {
				nested[normalizedNestedKey] = sanitized;
			}
		}

		return nested;
	}

	return String(value);
}

function normalizeContext(context?: LogContext): LogContext {
	if (!context) {
		return {};
	}

	const normalized: LogContext = {};

	for (const [key, rawValue] of Object.entries(context)) {
		const normalizedKey = camelToSnake(key);

		if (normalizedKey === "error") {
			Object.assign(normalized, normalizeError(rawValue));
			continue;
		}

		if (normalizedKey === "user_input" && typeof rawValue === "string") {
			normalized.input_length = rawValue.length;
			continue;
		}

		if (normalizedKey === "raw_body" && typeof rawValue === "string") {
			normalized.body_size_bytes = rawValue.length;
			continue;
		}

		const sanitized = sanitizeValue(normalizedKey, rawValue);
		if (sanitized !== undefined) {
			normalized[normalizedKey] = sanitized;
		}
	}

	return normalized;
}

export function getLogContext(): LogContext {
	return asyncLogContext.getStore() ?? {};
}

export function withLogContext<T>(context: LogContext, callback: () => T): T {
	const merged = { ...getLogContext(), ...normalizeContext(context) };
	return asyncLogContext.run(merged, callback);
}

/**
 * Measures wall time for I/O-bound spans.
 *
 * In Cloudflare Workers, Date.now()/performance.now() only advance after I/O.
 * That's fine for the request/RPC/webhook timings we use this for, but not for
 * pure CPU measurements.
 */
export function startTimer(): () => number {
	const startedAt = Date.now();
	return () => Date.now() - startedAt;
}

export class Logger {
	constructor(private readonly baseContext: LogContext = {}) {}

	child(context: LogContext): Logger {
		return new Logger({ ...this.baseContext, ...normalizeContext(context) });
	}

	debug(message: string, context?: LogContext): void {
		this.log("debug", message, context);
	}

	info(message: string, context?: LogContext): void {
		this.log("info", message, context);
	}

	warn(message: string, context?: LogContext): void {
		this.log("warn", message, context);
	}

	error(message: string, context?: LogContext): void {
		this.log("error", message, context);
	}

	private log(level: LogLevel, message: string, context?: LogContext): void {
		const mergedContext = {
			...getLogContext(),
			...this.baseContext,
			...normalizeContext(context),
		};
		const event =
			typeof mergedContext.event === "string" && mergedContext.event.length > 0
				? mergedContext.event
				: fallbackEvent(level, message);
		const component = inferComponent(mergedContext);
		const restContext = { ...mergedContext };
		delete restContext.component;
		delete restContext.event;

		const logData = {
			ts: new Date().toISOString(),
			level,
			event,
			message,
			component,
			...restContext,
		};

		const serialized = JSON.stringify(logData);

		switch (level) {
			case "debug":
				console.debug(serialized);
				break;
			case "info":
				console.info(serialized);
				break;
			case "warn":
				console.warn(serialized);
				break;
			case "error":
				console.error(serialized);
				break;
		}
	}
}

export const logger = new Logger();
