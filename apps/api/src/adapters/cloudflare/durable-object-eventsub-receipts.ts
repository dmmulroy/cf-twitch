import { Result } from "better-result";
import { z } from "zod";

import { EventSubReceiptAcceptanceError } from "../../capabilities/eventsub-receipts";
import { DurableObjectError } from "../../lib/errors";
import { fromRpcResult, type RpcPayloadParser } from "../../lib/rpc-result";

import type {
	AcceptedEventSubReceipt,
	EventSubReceiptAcceptor,
} from "../../capabilities/eventsub-receipts";
import type { Tracer } from "../../capabilities/tracer";
import type { Result as ResultType } from "better-result";

const EventSubAcceptanceWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({ _tag: z.literal("EventSubReceiptConflictError"), message: z.string() }).passthrough(),
	z.object({ _tag: z.literal("EventSubReceiptCorruptError"), message: z.string() }).passthrough(),
]);

type EventSubAcceptanceWireError = z.infer<typeof EventSubAcceptanceWireErrorSchema>;

interface EventSubReceiptRpcStub {
	accept(receipt: AcceptedEventSubReceipt): Promise<unknown>;
}

const parseVoidPayload: RpcPayloadParser<void> = (input) =>
	input === undefined ? Result.ok(undefined) : Result.err("Expected an undefined success value");
const parseAcceptanceWireError: RpcPayloadParser<EventSubAcceptanceWireError> = (input) => {
	const parsed = EventSubAcceptanceWireErrorSchema.safeParse(input);
	return parsed.success ? Result.ok(parsed.data) : Result.err(parsed.error.message);
};

/** Durable Object adapter for accepting parsed EventSub receipts by Twitch message ID. */
export class DurableObjectEventSubReceiptAcceptor implements EventSubReceiptAcceptor {
	constructor(
		private readonly namespace: Cloudflare.Env["EVENTSUB_WEBHOOK_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Persists and runtime-validates one EventSub durable inbox acceptance result. */
	accept(
		messageId: string,
		receipt: AcceptedEventSubReceipt,
	): Promise<ResultType<void, EventSubReceiptAcceptanceError>> {
		return this.tracer.span(
			"durable_object.eventsub_receipts.accept",
			{ message_id: messageId },
			async () => {
				let rawResult: unknown;
				try {
					rawResult = await this.acquireReceiptStub(messageId).accept(receipt);
				} catch (cause) {
					return Result.err(
						new EventSubReceiptAcceptanceError({ messageId, failure: "transport", cause }),
					);
				}
				const parsed = fromRpcResult(rawResult, "EventSubWebhookDO.accept", {
					success: parseVoidPayload,
					error: parseAcceptanceWireError,
				});
				if (parsed.status === "ok") return Result.ok(undefined);
				if (DurableObjectError.is(parsed.error)) {
					return Result.err(
						new EventSubReceiptAcceptanceError({
							messageId,
							failure: "protocol",
							cause: parsed.error,
						}),
					);
				}
				return Result.err(
					new EventSubReceiptAcceptanceError({
						messageId,
						failure: parsed.error._tag === "EventSubReceiptConflictError" ? "conflict" : "corrupt",
					}),
				);
			},
		);
	}

	private acquireReceiptStub(messageId: string): EventSubReceiptRpcStub {
		return this.namespace.getByName(messageId);
	}
}
