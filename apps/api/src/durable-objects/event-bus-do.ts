/**
 * EventBusDO - Singleton event router for domain events
 *
 * Receives events from sagas/DOs, routes to registered handlers.
 * Features:
 * - Immediate delivery attempt on publish
 * - On failure: persist to pending_events with retry schedule
 * - Exponential backoff: 1s, 4s, 16s (max 3 attempts)
 * - Alarm-driven retry processing
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { desc, eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../../drizzle/event-bus-do/migrations";
import { getStub, rpc, withRpcSerialization } from "../lib/durable-objects";
import {
	DLQItemNotFoundError,
	EventBusDbError,
	EventBusHandlerError,
	EventBusRoutingError,
	EventBusValidationError,
	type EventBusError,
} from "../lib/errors";
import { logger } from "../lib/logger";
import * as schema from "./schemas/event-bus-do.schema";
import {
	deadLetterQueue,
	EventSchema,
	EventType,
	pendingEvents,
	type Event,
	type PendingEvent,
} from "./schemas/event-bus-do.schema";

import type { Env } from "../index";

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of delivery attempts before giving up */
const MAX_ATTEMPTS = 3;

/** Backoff delays in milliseconds: 1s, 4s, 16s (exponential: 1000 * 4^attempt) */
const BACKOFF_DELAYS_MS: readonly [number, number, number] = [1000, 4000, 16000];

/** DLQ retention period in days */
const DLQ_RETENTION_DAYS = 30;

/** DLQ retention in milliseconds */
const DLQ_RETENTION_MS = DLQ_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Get backoff delay for a given attempt number.
 * Returns the delay for the attempt, capped at the maximum delay.
 */
function getBackoffDelayMs(attempt: number): number {
	const index = Math.min(attempt, BACKOFF_DELAYS_MS.length - 1);
	// Safe: index is always 0, 1, or 2 due to Math.min
	return BACKOFF_DELAYS_MS[index] ?? BACKOFF_DELAYS_MS[0];
}

// =============================================================================
// Handler Interface
// =============================================================================

/**
 * Event handler DO interface.
 * DOs that handle events must implement this method.
 */
export interface EventHandler {
	handleEvent(event: Event): Promise<Result<void, unknown>>;
}

// =============================================================================
// Routing Configuration
// =============================================================================

/**
 * Hardcoded event type → handler DO mapping.
 * All events currently route to AchievementsDO.
 */
const EVENT_ROUTES: Record<EventType, "ACHIEVEMENTS_DO"> = {
	[EventType.SongRequestSuccess]: "ACHIEVEMENTS_DO",
	[EventType.RaffleRoll]: "ACHIEVEMENTS_DO",
	[EventType.StreamOnline]: "ACHIEVEMENTS_DO",
	[EventType.StreamOffline]: "ACHIEVEMENTS_DO",
};

// =============================================================================
// EventBusDO Implementation
// =============================================================================

/**
 * EventBusDO - Durable Object for event routing with retry support
 *
 * Singleton instance that receives domain events and routes them to
 * the appropriate handler DOs. Failed deliveries are retried with
 * exponential backoff via alarms.
 */
class _EventBusDO extends DurableObject<Env> {
	private db: ReturnType<typeof drizzle<typeof schema>>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });

		void this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	/**
	 * Publish a domain event to be routed to handlers.
	 *
	 * Attempts immediate delivery. On failure, queues for retry.
	 *
	 * @param event - The domain event to publish
	 * @returns Result<void, EventBusError> - Success if delivered or queued
	 */
	@rpc
	async publish(event: unknown): Promise<Result<void, EventBusError>> {
		// Validate event with Zod
		const parseResult = EventSchema.safeParse(event);
		if (!parseResult.success) {
			logger.warn("EventBusDO: Invalid event format", {
				error: parseResult.error.message,
			});
			return Result.err(
				new EventBusValidationError({
					parseError: parseResult.error.message,
				}),
			);
		}

		const domainEvent = parseResult.data;

		logger.info("EventBusDO: Publishing event", {
			eventId: domainEvent.id,
			eventType: domainEvent.type,
			source: domainEvent.source,
		});

		// Look up handler
		const handlerKey = EVENT_ROUTES[domainEvent.type];
		if (!handlerKey) {
			logger.warn("EventBusDO: No handler for event type", {
				eventType: domainEvent.type,
			});
			return Result.err(
				new EventBusRoutingError({
					eventType: domainEvent.type,
				}),
			);
		}

		// Attempt immediate delivery
		const deliveryResult = await this.deliverEvent(domainEvent, handlerKey);

		if (deliveryResult.isOk()) {
			logger.info("EventBusDO: Event delivered", {
				eventId: domainEvent.id,
				eventType: domainEvent.type,
				handler: handlerKey,
			});
			return Result.ok();
		}

		// Delivery failed - queue for retry
		logger.warn("EventBusDO: Initial delivery failed, queueing for retry", {
			eventId: domainEvent.id,
			eventType: domainEvent.type,
			handler: handlerKey,
			error: deliveryResult.error.message,
		});

		const queueResult = await this.queueForRetry(domainEvent, 0);
		if (queueResult.isErr()) {
			return queueResult;
		}

		// Return success - event is queued for retry
		return Result.ok();
	}

	/**
	 * Alarm handler - processes pending events that are due for retry.
	 * Also purges expired DLQ items.
	 */
	override async alarm(): Promise<void> {
		const now = new Date().toISOString();

		logger.info("EventBusDO: Alarm fired, processing pending events", { now });

		// Purge expired DLQ items
		await this.purgeExpiredDLQ();

		// Get all events due for retry
		const dueEvents = await this.db
			.select()
			.from(pendingEvents)
			.where(lte(pendingEvents.nextRetryAt, now));

		if (dueEvents.length === 0) {
			logger.info("EventBusDO: No pending events to process");
			return;
		}

		logger.info("EventBusDO: Processing pending events", {
			count: dueEvents.length,
		});

		for (const pending of dueEvents) {
			await this.processPendingEvent(pending);
		}

		// Schedule next alarm if there are more pending events
		await this.scheduleNextAlarm();
	}

	/**
	 * Process a single pending event - attempt delivery or give up.
	 */
	private async processPendingEvent(pending: PendingEvent): Promise<void> {
		// Parse the stored event
		const parseResult = EventSchema.safeParse(JSON.parse(pending.event));
		if (!parseResult.success) {
			// Corrupted event - delete it
			logger.error("EventBusDO: Corrupted pending event, deleting", {
				eventId: pending.id,
				error: parseResult.error.message,
			});
			await this.db.delete(pendingEvents).where(eq(pendingEvents.id, pending.id));
			return;
		}

		const event = parseResult.data;
		const handlerKey = EVENT_ROUTES[event.type];
		const attemptNumber = pending.attempts + 1;

		logger.info("EventBusDO: Retrying event delivery", {
			eventId: event.id,
			eventType: event.type,
			attempt: attemptNumber,
			maxAttempts: MAX_ATTEMPTS,
		});

		// Attempt delivery
		const deliveryResult = await this.deliverEvent(event, handlerKey);

		if (deliveryResult.isOk()) {
			// Success - remove from pending
			logger.info("EventBusDO: Retry succeeded", {
				eventId: event.id,
				eventType: event.type,
				attempt: attemptNumber,
			});
			await this.db.delete(pendingEvents).where(eq(pendingEvents.id, pending.id));
			return;
		}

		// Delivery failed again
		if (attemptNumber >= MAX_ATTEMPTS) {
			// Max attempts reached - move to DLQ
			logger.error("EventBusDO: Max retry attempts reached, moving to DLQ", {
				eventId: event.id,
				eventType: event.type,
				attempts: attemptNumber,
				error: deliveryResult.error.message,
			});

			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + DLQ_RETENTION_MS).toISOString();

			// Atomic move: insert to DLQ + delete from pending in single transaction
			await this.db.transaction(async (tx) => {
				await tx.insert(deadLetterQueue).values({
					id: event.id,
					event: pending.event,
					error: deliveryResult.error.message,
					attempts: attemptNumber,
					firstFailedAt: pending.createdAt,
					lastFailedAt: now,
					expiresAt,
				});
				await tx.delete(pendingEvents).where(eq(pendingEvents.id, pending.id));
			});
			return;
		}

		// Schedule next retry
		const delayMs = getBackoffDelayMs(attemptNumber);
		const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

		logger.info("EventBusDO: Scheduling next retry", {
			eventId: event.id,
			eventType: event.type,
			attempt: attemptNumber,
			nextRetryAt,
			delayMs,
		});

		await this.db
			.update(pendingEvents)
			.set({
				attempts: attemptNumber,
				nextRetryAt,
			})
			.where(eq(pendingEvents.id, pending.id));
	}

	/**
	 * Queue an event for retry with exponential backoff.
	 */
	private async queueForRetry(
		event: Event,
		currentAttempts: number,
	): Promise<Result<void, EventBusDbError>> {
		const delayMs = getBackoffDelayMs(currentAttempts);
		const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
		const now = new Date().toISOString();

		return Result.tryPromise({
			try: async () => {
				await this.db.insert(pendingEvents).values({
					id: event.id,
					event: JSON.stringify(event),
					attempts: currentAttempts,
					nextRetryAt,
					createdAt: now,
				});

				logger.info("EventBusDO: Event queued for retry", {
					eventId: event.id,
					eventType: event.type,
					nextRetryAt,
					delayMs,
				});

				// Schedule alarm for the retry
				await this.scheduleNextAlarm();
			},
			catch: (cause) => new EventBusDbError({ operation: "queueForRetry", cause }),
		});
	}

	/**
	 * Schedule an alarm for the earliest pending event.
	 */
	private async scheduleNextAlarm(): Promise<void> {
		// Find earliest pending event
		const [earliest] = await this.db
			.select({ nextRetryAt: pendingEvents.nextRetryAt })
			.from(pendingEvents)
			.orderBy(pendingEvents.nextRetryAt)
			.limit(1);

		if (!earliest) {
			return;
		}

		const alarmTime = new Date(earliest.nextRetryAt).getTime();
		const now = Date.now();

		// Schedule alarm for earliest retry time (at least 1 second in future)
		const scheduleAt = Math.max(alarmTime, now + 1000);

		logger.info("EventBusDO: Scheduling alarm", {
			scheduleAt: new Date(scheduleAt).toISOString(),
		});

		await this.ctx.storage.setAlarm(scheduleAt);
	}

	/**
	 * Attempt to deliver event to handler DO.
	 */
	private async deliverEvent(
		event: Event,
		handlerKey: "ACHIEVEMENTS_DO",
	): Promise<Result<void, EventBusHandlerError>> {
		try {
			const stub = getStub(handlerKey);
			const result = await stub.handleEvent(event);

			if (result.isErr()) {
				return Result.err(
					new EventBusHandlerError({
						eventType: event.type,
						handlerName: handlerKey,
						cause: result.error,
					}),
				);
			}

			return Result.ok();
		} catch (error) {
			return Result.err(
				new EventBusHandlerError({
					eventType: event.type,
					handlerName: handlerKey,
					cause: error,
				}),
			);
		}
	}

	/**
	 * Get count of pending events (for monitoring/testing).
	 */
	@rpc
	async getPendingCount(): Promise<Result<number, EventBusDbError>> {
		return Result.tryPromise({
			try: async () => {
				const result = await this.db.select().from(pendingEvents);
				return result.length;
			},
			catch: (cause) => new EventBusDbError({ operation: "getPendingCount", cause }),
		});
	}

	// =============================================================================
	// Dead Letter Queue RPC Methods
	// =============================================================================

	/**
	 * Get DLQ items for admin inspection.
	 *
	 * @param options.limit - Max items to return (default 50)
	 * @param options.offset - Pagination offset (default 0)
	 * @returns Result<DLQListResponse, EventBusDbError>
	 */
	@rpc
	async getDLQ(options?: {
		limit?: number;
		offset?: number;
	}): Promise<Result<DLQListResponse, EventBusDbError>> {
		const limit = options?.limit ?? 50;
		const offset = options?.offset ?? 0;

		return Result.tryPromise({
			try: async () => {
				// Get items (sorted by last failure, newest first)
				const items = await this.db
					.select()
					.from(deadLetterQueue)
					.orderBy(desc(deadLetterQueue.lastFailedAt))
					.limit(limit)
					.offset(offset);

				// Get total count
				const allItems = await this.db.select().from(deadLetterQueue);
				const totalCount = allItems.length;

				// Parse events for response
				const parsedItems: DLQItem[] = items.map((item) => {
					let event: Event | null = null;
					try {
						const parseResult = EventSchema.safeParse(JSON.parse(item.event));
						event = parseResult.success ? parseResult.data : null;
					} catch {
						// Corrupted JSON - leave event as null
					}
					return {
						id: item.id,
						event,
						error: item.error,
						attempts: item.attempts,
						firstFailedAt: item.firstFailedAt,
						lastFailedAt: item.lastFailedAt,
						expiresAt: item.expiresAt,
					};
				});

				return {
					items: parsedItems,
					totalCount,
					limit,
					offset,
				};
			},
			catch: (cause) => new EventBusDbError({ operation: "getDLQ", cause }),
		});
	}

	/**
	 * Replay a DLQ item - attempt delivery again.
	 *
	 * If successful, removes from DLQ. If failed, updates lastFailedAt and resets attempts to 0.
	 *
	 * @param id - Event ID to replay
	 * @returns Result<ReplayResult, EventBusDbError | DLQItemNotFoundError | EventBusValidationError>
	 */
	@rpc
	async replayDLQ(
		id: string,
	): Promise<
		Result<ReplayResult, EventBusDbError | DLQItemNotFoundError | EventBusValidationError>
	> {
		// Find the DLQ item
		const [item] = await this.db.select().from(deadLetterQueue).where(eq(deadLetterQueue.id, id));

		if (!item) {
			return Result.err(new DLQItemNotFoundError({ eventId: id }));
		}

		// Parse the event
		let parsed: unknown;
		try {
			parsed = JSON.parse(item.event);
		} catch {
			return Result.err(new EventBusValidationError({ parseError: "Malformed JSON in DLQ item" }));
		}
		const parseResult = EventSchema.safeParse(parsed);
		if (!parseResult.success) {
			return Result.err(new EventBusValidationError({ parseError: parseResult.error.message }));
		}

		const event = parseResult.data;
		const handlerKey = EVENT_ROUTES[event.type];

		logger.info("EventBusDO: Replaying DLQ item", {
			eventId: event.id,
			eventType: event.type,
			handler: handlerKey,
		});

		// Attempt delivery
		const deliveryResult = await this.deliverEvent(event, handlerKey);

		if (deliveryResult.isOk()) {
			// Success - remove from DLQ
			await this.db.delete(deadLetterQueue).where(eq(deadLetterQueue.id, id));
			logger.info("EventBusDO: DLQ replay succeeded", { eventId: event.id });
			return Result.ok({ success: true, eventId: event.id });
		}

		// Failed again - update lastFailedAt, reset to retry queue
		const now = new Date().toISOString();
		await this.db
			.update(deadLetterQueue)
			.set({
				lastFailedAt: now,
				error: deliveryResult.error.message,
			})
			.where(eq(deadLetterQueue.id, id));

		logger.warn("EventBusDO: DLQ replay failed", {
			eventId: event.id,
			error: deliveryResult.error.message,
		});

		return Result.ok({
			success: false,
			eventId: event.id,
			error: deliveryResult.error.message,
		});
	}

	/**
	 * Delete a DLQ item - discard the failed event.
	 *
	 * @param id - Event ID to delete
	 * @returns Result<void, EventBusDbError | DLQItemNotFoundError>
	 */
	@rpc
	async deleteDLQ(id: string): Promise<Result<void, EventBusDbError | DLQItemNotFoundError>> {
		// Check if item exists
		const [item] = await this.db.select().from(deadLetterQueue).where(eq(deadLetterQueue.id, id));

		if (!item) {
			return Result.err(new DLQItemNotFoundError({ eventId: id }));
		}

		return Result.tryPromise({
			try: async () => {
				await this.db.delete(deadLetterQueue).where(eq(deadLetterQueue.id, id));
				logger.info("EventBusDO: DLQ item deleted", { eventId: id });
			},
			catch: (cause) => new EventBusDbError({ operation: "deleteDLQ", cause }),
		});
	}

	/**
	 * Purge expired DLQ items (older than 30 days).
	 * Called during alarm processing.
	 */
	private async purgeExpiredDLQ(): Promise<void> {
		const now = new Date().toISOString();

		const expired = await this.db
			.select()
			.from(deadLetterQueue)
			.where(lte(deadLetterQueue.expiresAt, now));

		if (expired.length === 0) {
			return;
		}

		logger.info("EventBusDO: Purging expired DLQ items", { count: expired.length });

		await this.db.delete(deadLetterQueue).where(lte(deadLetterQueue.expiresAt, now));
	}
}

// =============================================================================
// DLQ Response Types
// =============================================================================

/** Single DLQ item with parsed event */
export interface DLQItem {
	id: string;
	event: Event | null;
	error: string;
	attempts: number;
	firstFailedAt: string;
	lastFailedAt: string;
	expiresAt: string;
}

/** Response for getDLQ */
export interface DLQListResponse {
	items: DLQItem[];
	totalCount: number;
	limit: number;
	offset: number;
}

/** Response for replayDLQ */
export interface ReplayResult {
	success: boolean;
	eventId: string;
	error?: string;
}

export const EventBusDO = withRpcSerialization(_EventBusDO);
