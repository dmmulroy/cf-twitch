import { Result, TaggedError } from "better-result";
import { Hono } from "hono";
import { z } from "zod";

import { EventSubHeadersSchema, parseEventSubMessage } from "../../lib/eventsub-webhook-message";
import { normalizeError, withLogContext } from "../../lib/logger";
import { type AppRouteEnv, getRequestLogger } from "../../lib/request-context";

import type { EventSubReceiptAcceptor } from "../../capabilities/eventsub-receipts";
import type { RedactedValue } from "../../lib/redacted";
import type { RequestId, TraceId } from "../../lib/request-context";

/** Maximum authenticated Twitch EventSub body size accepted by this Worker. */
export const MAX_EVENTSUB_BODY_BYTES = 1_048_576;
const EVENTSUB_TIMESTAMP_TOLERANCE_MS = 10 * 60 * 1_000;

class EventSubBodyTooLargeError extends TaggedError("EventSubBodyTooLargeError")<{
	message: string;
	maximumBytes: number;
}> {
	constructor() {
		super({
			message: `EventSub body too large: maximum is ${MAX_EVENTSUB_BODY_BYTES} bytes`,
			maximumBytes: MAX_EVENTSUB_BODY_BYTES,
		});
	}
}

async function readBoundedEventSubBody(
	request: Request,
): Promise<Result<string, EventSubBodyTooLargeError | Error>> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null) {
		const parsedLength = Number(contentLength);
		if (Number.isFinite(parsedLength) && parsedLength > MAX_EVENTSUB_BODY_BYTES) {
			return Result.err(new EventSubBodyTooLargeError());
		}
	}

	if (request.body === null) return Result.ok("");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			totalBytes += next.value.byteLength;
			if (totalBytes > MAX_EVENTSUB_BODY_BYTES) {
				await reader.cancel();
				return Result.err(new EventSubBodyTooLargeError());
			}
			chunks.push(next.value);
		}
	} catch (cause) {
		return Result.err(
			new Error("EventSub body read failed", {
				cause,
			}),
		);
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return Result.ok(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch (cause) {
		return Result.err(new Error("EventSub body UTF-8 decode failed", { cause }));
	}
}

function decodeEventSubSignature(signature: string): Uint8Array {
	const hex = signature.slice("sha256=".length);
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

async function verifyEventSubSignature(input: {
	readonly secret: string;
	readonly messageId: string;
	readonly timestamp: string;
	readonly body: string;
	readonly signature: string;
}): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(input.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		"HMAC",
		key,
		decodeEventSubSignature(input.signature),
		encoder.encode(input.messageId + input.timestamp + input.body),
	);
}

function isEventSubTimestampCurrent(timestamp: string): boolean {
	return Math.abs(Date.now() - Date.parse(timestamp)) <= EVENTSUB_TIMESTAMP_TOLERANCE_MS;
}

/** Exact dependencies required by the authenticated Twitch EventSub webhook route. */
export type EventSubWebhookRouteDependencies = Readonly<{
	eventSubSecret: RedactedValue<string>;
	receipts: EventSubReceiptAcceptor;
	correlation: Readonly<{ requestId: RequestId; traceId: TraceId }>;
}>;

/** Creates the authenticated Twitch EventSub webhook route. */
export function createEventSubWebhookRoutes(
	dependencies: EventSubWebhookRouteDependencies,
): Hono<AppRouteEnv<object>> {
	const webhooks = new Hono<AppRouteEnv<object>>();

	webhooks.post("/twitch", async (c) => {
		const routeLogger = getRequestLogger(c).child({
			route: "/webhooks/twitch",
			component: "route",
		});
		const headersResult = EventSubHeadersSchema.safeParse(c.req.header());
		if (!headersResult.success) {
			routeLogger.warn("EventSub headers rejected", {
				event: "webhook.twitch.headers_invalid",
				parse_error: headersResult.error.message,
			});
			return c.json({ error: "Invalid EventSub headers" }, 400);
		}

		const headers = headersResult.data;
		const messageId = headers["twitch-eventsub-message-id"];
		const timestamp = headers["twitch-eventsub-message-timestamp"];
		const subscriptionType = headers["twitch-eventsub-subscription-type"];

		return withLogContext(
			{ trace_id: messageId, message_id: messageId, subscription_type: subscriptionType },
			async () => {
				if (!isEventSubTimestampCurrent(timestamp)) {
					return c.json({ error: "EventSub timestamp outside the allowed window" }, 403);
				}

				const bodyResult = await readBoundedEventSubBody(c.req.raw);
				if (bodyResult.status === "error") {
					if (EventSubBodyTooLargeError.is(bodyResult.error)) {
						return c.json({ error: "EventSub body too large" }, 413);
					}
					routeLogger.warn("EventSub body read rejected", {
						event: "webhook.twitch.body_read_failed",
						...normalizeError(bodyResult.error),
					});
					return c.json({ error: "Invalid EventSub body" }, 400);
				}
				const rawBody = bodyResult.value;

				const signatureValid = await verifyEventSubSignature({
					secret: dependencies.eventSubSecret.unsafeUnwrapForFinalIo(),
					messageId,
					timestamp,
					body: rawBody,
					signature: headers["twitch-eventsub-message-signature"],
				});
				if (!signatureValid) {
					return c.json({ error: "Invalid EventSub signature" }, 403);
				}

				let body: unknown;
				try {
					body = JSON.parse(rawBody) as unknown;
				} catch (cause) {
					routeLogger.warn("EventSub JSON body rejected", {
						event: "webhook.twitch.body_parse_failed",
						...normalizeError(cause),
					});
					return c.json({ error: "Invalid EventSub JSON body" }, 400);
				}

				const jsonBodyResult = z.json().safeParse(body);
				if (!jsonBodyResult.success) return c.json({ error: "Invalid EventSub JSON body" }, 400);
				const messageResult = parseEventSubMessage(headers, jsonBodyResult.data);
				if (messageResult.status === "error") {
					routeLogger.warn("EventSub message payload rejected", {
						event: "webhook.twitch.payload_invalid",
						message_id: messageId,
						subscription_type: subscriptionType,
						parse_error: messageResult.error.parseError,
					});
					return c.json({ error: "Invalid EventSub payload" }, 400);
				}

				if (messageResult.value._tag === "EventSubChallenge") {
					return c.text(messageResult.value.challenge, 200, {
						"content-type": "text/plain; charset=UTF-8",
					});
				}

				const acceptance = await dependencies.receipts.accept(messageId, {
					headers,
					body: jsonBodyResult.data,
					correlation: dependencies.correlation,
				});
				if (acceptance.status === "error") {
					routeLogger.error("EventSub durable acceptance failed", {
						event: "webhook.twitch.acceptance_failed",
						message_id: messageId,
						subscription_type: subscriptionType,
						...normalizeError(acceptance.error),
					});
					return c.json({ error: "EventSub durable acceptance failed" }, 503);
				}

				routeLogger.info("EventSub message durably accepted", {
					event: "webhook.twitch.accepted",
					message_id: messageId,
					subscription_type: subscriptionType,
					retry_count: Number(headers["twitch-eventsub-message-retry"]),
				});
				return c.json({ success: true }, 200);
			},
		);
	});

	return webhooks;
}
