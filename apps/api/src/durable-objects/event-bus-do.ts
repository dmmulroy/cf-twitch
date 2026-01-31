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
import { eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../../drizzle/event-bus-do/migrations";
import { getStub } from "../lib/durable-objects";
import {
	EventBusDbError,
	EventBusHandlerError,
	EventBusRoutingError,
	EventBusValidationError,
	type EventBusError,
} from "../lib/errors";
import { logger } from "../lib/logger";
import * as schema from "./schemas/event-bus-do.schema";
import {
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
export class EventBusDO extends DurableObject<Env> {
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
	 */
	override async alarm(): Promise<void> {
		const now = new Date().toISOString();

		logger.info("EventBusDO: Alarm fired, processing pending events", { now });

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
			// Max attempts reached - give up (DLQ will be added in separate task)
			logger.error("EventBusDO: Max retry attempts reached, giving up", {
				eventId: event.id,
				eventType: event.type,
				attempts: attemptNumber,
				error: deliveryResult.error.message,
			});
			await this.db.delete(pendingEvents).where(eq(pendingEvents.id, pending.id));
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
	async getPendingCount(): Promise<Result<number, EventBusDbError>> {
		return Result.tryPromise({
			try: async () => {
				const result = await this.db.select().from(pendingEvents);
				return result.length;
			},
			catch: (cause) => new EventBusDbError({ operation: "getPendingCount", cause }),
		});
	}
}
