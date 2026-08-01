import { Result } from "better-result";

import { EventSubReceiptAcceptanceError } from "../../capabilities/eventsub-receipts";
import { AcceptEventSubReceiptResultCodec } from "../../lib/eventsub-receipt-rpc-result-codecs";

import type {
	AcceptedEventSubReceipt,
	EventSubReceiptAcceptor,
} from "../../capabilities/eventsub-receipts";
import type { Tracer } from "../../capabilities/tracer";
import type { Result as ResultType } from "better-result";

interface EventSubReceiptRpcStub {
	accept(receipt: AcceptedEventSubReceipt): Promise<unknown>;
}

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
				const parsed = await AcceptEventSubReceiptResultCodec.deserializeUnsafe(rawResult);
				if (parsed.status === "ok") return Result.ok(undefined);
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
