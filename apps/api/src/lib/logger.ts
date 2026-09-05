/**
 * Context-aware structured logger.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

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

export type LogContextValue = SanitizedValue;

export interface LogContext extends SanitizedObject {}

export interface LogError {
	error_tag?: string;
	error_message?: string;
	error_stack?: string;
}

interface SanitizedObject {
	[key: string]: SanitizedValue;
}

type SanitizedValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| SanitizedValue[]
	| SanitizedObject
	| LogError;

const StringValueSchema = z.string();
const NumberValueSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const BooleanValueSchema = z.boolean();
const BigIntValueSchema = z.bigint();
const ObjectValueSchema = z.object({});
const ErrorProjectionSchema = z.object({
	_tag: z.string().optional(),
	name: z.string().optional(),
	message: z.string().optional(),
	stack: z.string().optional(),
});

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

function isString<Value>(value: Value): value is Value & string {
	return StringValueSchema.safeParse(value).success;
}

function isNumber<Value>(value: Value): value is Value & number {
	return NumberValueSchema.safeParse(value).success;
}

function isBoolean<Value>(value: Value): value is Value & boolean {
	return BooleanValueSchema.safeParse(value).success;
}

function isBigInt<Value>(value: Value): value is Value & bigint {
	return BigIntValueSchema.safeParse(value).success;
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

	if (isString(context.cache_key) || isNumber(context.ttl_seconds)) {
		return "cache";
	}

	if (isString(context.metric_name)) {
		return "analytics";
	}

	if (
		isString(context.provider) ||
		isString(context.external_url) ||
		isString(context.request_kind)
	) {
		return "service";
	}

	if (
		isString(context.do_name) ||
		isString(context.do_id) ||
		isString(context.rpc_method) ||
		isString(context.saga_id) ||
		isString(context.stream_session_id)
	) {
		return "durable_object";
	}

	if (
		isString(context.route) ||
		isString(context.path) ||
		isString(context.method) ||
		isString(context.request_id)
	) {
		return "route";
	}

	if (isString(context.script_name)) {
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

function isTraversableObject<Value>(value: Value): value is Value & object {
	return (
		ObjectValueSchema.safeParse(value).success && !Array.isArray(value) && !(value instanceof Error)
	);
}

export function normalizeError<ErrorValue>(error: ErrorValue): LogError {
	if (error instanceof Error) {
		const tag = "_tag" in error ? error._tag : undefined;
		return {
			error_tag: isString(tag) ? tag : error.name || "Error",
			error_message: error.message,
			error_stack: error.stack,
		};
	}

	if (isTraversableObject(error)) {
		const projection = ErrorProjectionSchema.safeParse(Object.fromEntries(Object.entries(error)));
		if (projection.success) {
			return {
				error_tag: projection.data._tag ?? projection.data.name ?? "UnknownError",
				error_message:
					projection.data.message === undefined
						? String(error)
						: truncateString(projection.data.message),
				error_stack:
					projection.data.stack === undefined ? undefined : truncateString(projection.data.stack),
			};
		}
	}

	return {
		error_tag: "UnknownError",
		error_message: truncateString(String(error)),
	};
}

function sanitizeValue<Value>(key: string, value: Value, depth = 0): SanitizedValue {
	if (depth > 4) {
		return "[Truncated]";
	}

	const normalizedKey = camelToSnake(key);

	if (SENSITIVE_KEYS.has(normalizedKey)) {
		if (isString(value)) {
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

	if (isString(value)) {
		return truncateString(value);
	}

	if (isNumber(value)) {
		return value;
	}

	if (isBoolean(value)) {
		return value;
	}

	if (value === null) {
		return null;
	}

	if (value === undefined) {
		return undefined;
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(key, item, depth + 1));
	}

	if (isBigInt(value)) {
		return value.toString();
	}

	if (value instanceof URL) {
		return value.toString();
	}

	if (isTraversableObject(value)) {
		const nested: SanitizedObject = {};
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

			if (normalizedNestedKey === "user_input" && isString(nestedValue)) {
				nested.input_length = nestedValue.length;
				continue;
			}

			if (normalizedNestedKey === "raw_body" && isString(nestedValue)) {
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

function normalizeContext<Context extends object>(context?: Context): LogContext {
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

		if (normalizedKey === "user_input" && isString(rawValue)) {
			normalized.input_length = rawValue.length;
			continue;
		}

		if (normalizedKey === "raw_body" && isString(rawValue)) {
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

export function withLogContext<T, Context extends object>(context: Context, callback: () => T): T {
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

	child<Context extends object>(context: Context): Logger {
		return new Logger({ ...this.baseContext, ...normalizeContext(context) });
	}

	debug<Context extends object>(message: string, context?: Context): void {
		this.log("debug", message, context);
	}

	info<Context extends object>(message: string, context?: Context): void {
		this.log("info", message, context);
	}

	warn<Context extends object>(message: string, context?: Context): void {
		this.log("warn", message, context);
	}

	error<Context extends object>(message: string, context?: Context): void {
		this.log("error", message, context);
	}

	private log<Context extends object>(level: LogLevel, message: string, context?: Context): void {
		const mergedContext: LogContext = {
			...getLogContext(),
			...this.baseContext,
			...normalizeContext(context),
		};
		const event =
			isString(mergedContext.event) && mergedContext.event.length > 0
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
