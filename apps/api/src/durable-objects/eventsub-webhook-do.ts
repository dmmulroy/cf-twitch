import { Result, TaggedError } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import {
	parseKnownRewardRedemption,
	type RewardRoutingConfig,
} from "../lib/channel-point-redemptions";
import { makeChatCommandExecutor } from "../lib/chat-command";
import { getStub, rpc, withRpcSerialization } from "../lib/durable-objects";
import { UnknownRewardError } from "../lib/errors";
import {
	EventSubHeadersSchema,
	parseEventSubMessage,
	type ParsedEventSubMessage,
} from "../lib/eventsub-webhook-message";
import { logger } from "../lib/logger";
import { getUserPermission } from "../lib/permissions";

import type { Env } from "../index";

const EVENTSUB_RECEIPT_STORAGE_KEY = "eventsub-receipt";
const MAX_EVENTSUB_PROCESSING_ATTEMPTS = 20;

const AcceptedEventSubReceiptSchema = z.object({
	headers: EventSubHeadersSchema,
	body: z.unknown(),
});

const PersistedEventSubReceiptSchema = z.object({
	headers: EventSubHeadersSchema,
	body: z.unknown(),
	status: z.enum(["pending", "completed", "dead_letter"]),
	attempts: z.number().int().nonnegative(),
	acceptedAt: z.string(),
	completedAt: z.string().nullable(),
	lastError: z.string().nullable(),
});

type AcceptedEventSubReceipt = z.infer<typeof AcceptedEventSubReceiptSchema>;
type PersistedEventSubReceipt = z.infer<typeof PersistedEventSubReceiptSchema>;

/** Expected error when a webhook message id is reused for different signed content. */
export class EventSubReceiptConflictError extends TaggedError("EventSubReceiptConflictError")<{
	message: string;
	messageId: string;
}>() {
	constructor(messageId: string) {
		super({
			message: `EventSub receipt conflict: message ${messageId} already has different content`,
			messageId,
		});
	}
}

/** Expected error when an accepted webhook receipt cannot be decoded from durable storage. */
export class EventSubReceiptCorruptError extends TaggedError("EventSubReceiptCorruptError")<{
	message: string;
	parseError: string;
}>() {
	constructor(parseError: string) {
		super({
			message: `EventSub receipt storage parse failed: ${parseError}`,
			parseError,
		});
	}
}

/** Errors that can prevent durable EventSub receipt acceptance. */
export type EventSubAcceptanceError = EventSubReceiptConflictError | EventSubReceiptCorruptError;

/** Operational projection of one durably accepted EventSub inbox receipt. */
export interface EventSubReceiptStatus {
	readonly status: "pending" | "completed" | "dead_letter";
	readonly attempts: number;
	readonly lastError: string | null;
}

class EventSubProcessingError extends TaggedError("EventSubProcessingError")<{
	message: string;
	operation: string;
}>() {
	constructor(operation: string, detail: string) {
		super({
			message: `EventSub durable processing failed during ${operation}: ${detail}`,
			operation,
		});
	}
}

/**
 * Durable EventSub inbox keyed by Twitch message id.
 *
 * Receipt persistence happens before processing, so HTTP acknowledgement never discards a
 * valid notification when downstream work fails. Pending work is retried by alarm.
 */
class _EventSubWebhookDO extends DurableObject<Env> {
	/** Durably accepts one fully parsed EventSub receipt and idempotently resumes its work. */
	@rpc
	async accept(input: unknown): Promise<Result<void, EventSubAcceptanceError>> {
		const accepted = AcceptedEventSubReceiptSchema.safeParse(input);
		if (!accepted.success) {
			return Result.err(new EventSubReceiptCorruptError(accepted.error.message));
		}

		const message = parseEventSubMessage(accepted.data.headers, accepted.data.body);
		if (message.status === "error") {
			return Result.err(new EventSubReceiptCorruptError(message.error.message));
		}

		const existingResult = await this.readReceipt();
		if (existingResult.status === "error") return existingResult;
		const existing = existingResult.value;
		if (existing !== null) {
			if (!this.hasSameReceipt(existing, accepted.data)) {
				return Result.err(
					new EventSubReceiptConflictError(accepted.data.headers["twitch-eventsub-message-id"]),
				);
			}
			if (existing.status === "pending") await this.processPendingReceipt(existing);
			return Result.ok();
		}

		const receipt: PersistedEventSubReceipt = {
			...accepted.data,
			status: "pending",
			attempts: 0,
			acceptedAt: new Date().toISOString(),
			completedAt: null,
			lastError: null,
		};
		await this.ctx.storage.put(EVENTSUB_RECEIPT_STORAGE_KEY, receipt);
		await this.processPendingReceipt(receipt);
		return Result.ok();
	}

	/** Read durable EventSub receipt progress without exposing the signed body. */
	@rpc
	async getReceiptStatus(): Promise<
		Result<EventSubReceiptStatus | null, EventSubReceiptCorruptError>
	> {
		const receipt = await this.readReceipt();
		return receipt.status === "error" || receipt.value === null
			? receipt
			: Result.ok({
					status: receipt.value.status,
					attempts: receipt.value.attempts,
					lastError: receipt.value.lastError,
				});
	}

	/** Runtime alarm callback that resumes a previously accepted EventSub receipt. */
	async alarm(): Promise<void> {
		const receiptResult = await this.readReceipt();
		if (receiptResult.status === "error") {
			logger.error("EventSub durable receipt is corrupt", {
				event: "webhook.eventsub.receipt_corrupt",
				error_tag: receiptResult.error._tag,
				parse_error: receiptResult.error.parseError,
			});
			return;
		}
		if (receiptResult.value?.status === "pending") {
			await this.processPendingReceipt(receiptResult.value);
		}
	}

	private async readReceipt(): Promise<
		Result<PersistedEventSubReceipt | null, EventSubReceiptCorruptError>
	> {
		const stored = await this.ctx.storage.get<unknown>(EVENTSUB_RECEIPT_STORAGE_KEY);
		if (stored === undefined) return Result.ok(null);
		const parsed = PersistedEventSubReceiptSchema.safeParse(stored);
		return parsed.success
			? Result.ok(parsed.data)
			: Result.err(new EventSubReceiptCorruptError(parsed.error.message));
	}

	private hasSameReceipt(
		existing: PersistedEventSubReceipt,
		accepted: AcceptedEventSubReceipt,
	): boolean {
		return (
			JSON.stringify(existing.headers) === JSON.stringify(accepted.headers) &&
			JSON.stringify(existing.body) === JSON.stringify(accepted.body)
		);
	}

	private async processPendingReceipt(receipt: PersistedEventSubReceipt): Promise<void> {
		const parsed = parseEventSubMessage(receipt.headers, receipt.body);
		if (parsed.status === "error") {
			await this.recordProcessingFailure(receipt, parsed.error.message);
			return;
		}

		try {
			const processing = await this.dispatchMessage(receipt, parsed.value);
			if (processing.status === "error") {
				await this.recordProcessingFailure(receipt, processing.error.message);
				return;
			}
			await this.ctx.storage.put(EVENTSUB_RECEIPT_STORAGE_KEY, {
				...receipt,
				status: "completed",
				completedAt: new Date().toISOString(),
				lastError: null,
			} satisfies PersistedEventSubReceipt);
			await this.ctx.storage.deleteAlarm();
		} catch (cause) {
			await this.recordProcessingFailure(
				receipt,
				cause instanceof Error ? cause.message : String(cause),
			);
		}
	}

	private async recordProcessingFailure(
		receipt: PersistedEventSubReceipt,
		errorMessage: string,
	): Promise<void> {
		const attempts = receipt.attempts + 1;
		const status = attempts >= MAX_EVENTSUB_PROCESSING_ATTEMPTS ? "dead_letter" : "pending";
		await this.ctx.storage.put(EVENTSUB_RECEIPT_STORAGE_KEY, {
			...receipt,
			status,
			attempts,
			lastError: errorMessage,
		} satisfies PersistedEventSubReceipt);

		logger.error("EventSub accepted notification processing failed", {
			event: "webhook.eventsub.processing_failed",
			message_id: receipt.headers["twitch-eventsub-message-id"],
			subscription_type: receipt.headers["twitch-eventsub-subscription-type"],
			attempts,
			status,
			error_message: errorMessage,
		});
		if (status === "pending") {
			const retryDelayMs = Math.min(1_000 * 2 ** Math.min(attempts, 9), 10 * 60 * 1_000);
			await this.ctx.storage.setAlarm(Date.now() + retryDelayMs);
		}
	}

	private async dispatchMessage(
		receipt: PersistedEventSubReceipt,
		message: ParsedEventSubMessage,
	): Promise<Result<void, EventSubProcessingError>> {
		const messageId = receipt.headers["twitch-eventsub-message-id"];
		const receivedAt = receipt.headers["twitch-eventsub-message-timestamp"];

		switch (message._tag) {
			case "EventSubChallenge":
				return Result.ok();
			case "EventSubRevocation":
				logger.warn("EventSub subscription revoked", {
					event: "webhook.twitch.revocation.received",
					message_id: messageId,
					subscription_id: message.subscription.id,
					subscription_type: message.subscription.type,
					status: message.subscription.status,
				});
				return Result.ok();
			case "UnhandledEventSubNotification":
				logger.warn("Unhandled EventSub subscription type", {
					event: "webhook.twitch.notification.unhandled",
					message_id: messageId,
					subscription_type: message.subscription.type,
				});
				return Result.ok();
			case "StreamOnlineNotification": {
				const result = await getStub("STREAM_LIFECYCLE_DO").onStreamOnline(
					message.event.started_at,
				);
				return result.status === "ok"
					? Result.ok()
					: Result.err(new EventSubProcessingError("stream.online", result.error.message));
			}
			case "StreamOfflineNotification": {
				// Twitch stream.offline has no event timestamp; signed receipt time is the ordering fallback.
				const result = await getStub("STREAM_LIFECYCLE_DO").onStreamOffline(receivedAt);
				return result.status === "ok"
					? Result.ok()
					: Result.err(new EventSubProcessingError("stream.offline", result.error.message));
			}
			case "RewardRedemptionNotification":
				return this.dispatchRewardRedemption(message.event);
			case "RaidNotification": {
				const result = await getStub("RAID_SHOUTOUT_SAGA_DO", messageId).start({
					messageId,
					receivedAt,
					raider: {
						userId: message.event.from_broadcaster_user_id,
						login: message.event.from_broadcaster_user_login,
						displayName: message.event.from_broadcaster_user_name,
					},
					viewers: message.event.viewers,
				});
				return result.status === "ok"
					? Result.ok()
					: Result.err(new EventSubProcessingError("channel.raid", result.error.message));
			}
			case "ChatMessageNotification": {
				const executor = makeChatCommandExecutor(this.env);
				const result = await executor.execute({
					messageId: message.event.message_id,
					text: message.event.message.text.trim().toLowerCase(),
					receivedAt,
					viewer: {
						userId: message.event.chatter_user_id,
						displayName: message.event.chatter_user_name,
						permission: getUserPermission(message.event.badges),
					},
				});
				return result.status === "ok"
					? Result.ok()
					: Result.err(new EventSubProcessingError("channel.chat.message", result.error.message));
			}
		}
	}

	private async dispatchRewardRedemption(
		redemption: Extract<ParsedEventSubMessage, { _tag: "RewardRedemptionNotification" }>["event"],
	): Promise<Result<void, EventSubProcessingError>> {
		const routingConfig: RewardRoutingConfig = {
			songRequestRewardId: this.env.SONG_REQUEST_REWARD_ID,
			keyboardRaffleRewardId: this.env.KEYBOARD_RAFFLE_REWARD_ID,
		};
		const known = parseKnownRewardRedemption(redemption, routingConfig);
		if (known.status === "error") {
			if (UnknownRewardError.is(known.error)) return Result.ok();
			return Result.err(
				new EventSubProcessingError("reward routing configuration", known.error.message),
			);
		}

		if (known.value._tag === "SongRequestRedemption") {
			const result = await getStub("SONG_REQUEST_SAGA_DO", redemption.id).start(known.value);
			return result.status === "ok"
				? Result.ok()
				: Result.err(new EventSubProcessingError("song request saga start", result.error.message));
		}
		const result = await getStub("KEYBOARD_RAFFLE_SAGA_DO", redemption.id).start(known.value);
		return result.status === "ok"
			? Result.ok()
			: Result.err(new EventSubProcessingError("keyboard raffle saga start", result.error.message));
	}
}

/** Production Durable Object that owns EventSub durable acceptance and retry. */
export const EventSubWebhookDO = withRpcSerialization(_EventSubWebhookDO);
