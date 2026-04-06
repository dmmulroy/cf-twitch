/**
 * EventBusDO - Singleton event router for domain events
 *
 * Migrated to Agent for Agent-native lifecycle and delayed scheduling.
 * SQLite remains the source of truth for pending retries and DLQ state.
 *
 * Workflows were evaluated and intentionally deferred. EventBus is a small,
 * due-time-driven router; Agent scheduling plus SQLite is the simplest fit.
 */

import { Agent, type AgentContext } from "agents";
import { Result } from "better-result";
import { desc, eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../../drizzle/event-bus-do/migrations";
import { getStub, rpc, withRpcSerialization } from "../lib/durable-objects";
import {
	DLQItemNotFoundError,
	EventBusDbError,
	EventBusHandlerError,
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

const MAX_ATTEMPTS = 3;
const BACKOFF_DELAYS_MS: readonly [number, number, number] = [1000, 4000, 16000];
const DLQ_RETENTION_DAYS = 30;
const DLQ_RETENTION_MS = DLQ_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function getBackoffDelayMs(attempt: number): number {
	const index = Math.min(attempt, BACKOFF_DELAYS_MS.length - 1);
	return BACKOFF_DELAYS_MS[index] ?? BACKOFF_DELAYS_MS[0];
}

export interface EventHandler {
	handleEvent(event: Event): Promise<Result<void, unknown>>;
}

const EVENT_ROUTES = {
	[EventType.SongRequestSuccess]: "ACHIEVEMENTS_DO",
	[EventType.RaffleRoll]: "ACHIEVEMENTS_DO",
	[EventType.StreamOnline]: "ACHIEVEMENTS_DO",
	[EventType.StreamOffline]: "ACHIEVEMENTS_DO",
} satisfies Record<EventType, "ACHIEVEMENTS_DO">;

interface EventBusAgentState {
	retrySweepScheduleId: string | null;
	retrySweepDueAt: string | null;
	dlqPurgeScheduleId: string | null;
	dlqPurgeDueAt: string | null;
}

class _EventBusDO extends Agent<Env, EventBusAgentState> {
	private db: ReturnType<typeof drizzle<typeof schema>>;

	initialState: EventBusAgentState = {
		retrySweepScheduleId: null,
		retrySweepDueAt: null,
		dlqPurgeScheduleId: null,
		dlqPurgeDueAt: null,
	};

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });
	}

	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
			await this.ctx.storage.deleteAlarm();
			await this.ensureRetrySweepSchedule();
			await this.ensureDlqPurgeSchedule();
		});
	}

	@rpc
	async publish(event: unknown): Promise<Result<void, EventBusError>> {
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
		const handlerKey = EVENT_ROUTES[domainEvent.type];

		logger.info("EventBusDO: Publishing event", {
			eventId: domainEvent.id,
			eventType: domainEvent.type,
			source: domainEvent.source,
		});

		const deliveryResult = await this.deliverEvent(domainEvent, handlerKey);
		if (deliveryResult.isOk()) {
			logger.info("EventBusDO: Event delivered", {
				eventId: domainEvent.id,
				eventType: domainEvent.type,
				handler: handlerKey,
			});
			return Result.ok();
		}

		logger.warn("EventBusDO: Initial delivery failed, queueing for retry", {
			eventId: domainEvent.id,
			eventType: domainEvent.type,
			handler: handlerKey,
			error: deliveryResult.error.message,
		});

		const queueResult = await this.queueForRetry(domainEvent, 0);
		if (queueResult.isErr()) {
			return Result.err(queueResult.error);
		}

		return Result.ok();
	}

	async retryDueEventsTick(_scheduledFor?: string): Promise<void> {
		if (this.state.retrySweepScheduleId !== null || this.state.retrySweepDueAt !== null) {
			this.setState({
				...this.state,
				retrySweepScheduleId: null,
				retrySweepDueAt: null,
			});
		}

		const now = new Date().toISOString();
		const dueEvents = await this.db
			.select()
			.from(pendingEvents)
			.where(lte(pendingEvents.nextRetryAt, now));

		if (dueEvents.length === 0) {
			await this.ensureRetrySweepSchedule();
			return;
		}

		logger.info("EventBusDO: Processing pending events", { count: dueEvents.length, now });

		for (const pending of dueEvents) {
			await this.processPendingEvent(pending);
		}

		await this.ensureRetrySweepSchedule();
		await this.ensureDlqPurgeSchedule();
	}

	async purgeExpiredDlqTick(_scheduledFor?: string): Promise<void> {
		if (this.state.dlqPurgeScheduleId !== null || this.state.dlqPurgeDueAt !== null) {
			this.setState({
				...this.state,
				dlqPurgeScheduleId: null,
				dlqPurgeDueAt: null,
			});
		}

		await this.purgeExpiredDLQ();
		await this.ensureDlqPurgeSchedule();
	}

	private async processPendingEvent(pending: PendingEvent): Promise<void> {
		let parsedEvent: unknown;
		try {
			parsedEvent = JSON.parse(pending.event);
		} catch (error) {
			logger.error("EventBusDO: Corrupted pending event JSON, deleting", {
				eventId: pending.id,
				error: error instanceof Error ? error.message : String(error),
			});
			await this.db.delete(pendingEvents).where(eq(pendingEvents.id, pending.id));
			return;
		}

		const parseResult = EventSchema.safeParse(parsedEvent);
		if (!parseResult.success) {
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

		const deliveryResult = await this.deliverEvent(event, handlerKey);
		if (deliveryResult.isOk()) {
			logger.info("EventBusDO: Retry succeeded", {
				eventId: event.id,
				eventType: event.type,
				attempt: attemptNumber,
			});
			await this.db.delete(pendingEvents).where(eq(pendingEvents.id, pending.id));
			return;
		}

		if (attemptNumber >= MAX_ATTEMPTS) {
			logger.error("EventBusDO: Max retry attempts reached, moving to DLQ", {
				eventId: event.id,
				eventType: event.type,
				attempts: attemptNumber,
				error: deliveryResult.error.message,
			});

			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + DLQ_RETENTION_MS).toISOString();

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

	private async queueForRetry(
		event: Event,
		currentAttempts: number,
	): Promise<Result<void, EventBusDbError>> {
		const delayMs = getBackoffDelayMs(currentAttempts);
		const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
		const now = new Date().toISOString();

		return Result.tryPromise({
			try: async () => {
				const [existingPending] = await this.db
					.select({ id: pendingEvents.id })
					.from(pendingEvents)
					.where(eq(pendingEvents.id, event.id))
					.limit(1);
				if (existingPending) {
					logger.info("EventBusDO: Event already pending, skipping duplicate retry queue", {
						eventId: event.id,
					});
					return;
				}

				const [existingDlq] = await this.db
					.select({ id: deadLetterQueue.id })
					.from(deadLetterQueue)
					.where(eq(deadLetterQueue.id, event.id))
					.limit(1);
				if (existingDlq) {
					logger.info("EventBusDO: Event already in DLQ, skipping duplicate retry queue", {
						eventId: event.id,
					});
					return;
				}

				await this.db
					.insert(pendingEvents)
					.values({
						id: event.id,
						event: JSON.stringify(event),
						attempts: currentAttempts,
						nextRetryAt,
						createdAt: now,
					})
					.onConflictDoNothing();

				logger.info("EventBusDO: Event queued for retry", {
					eventId: event.id,
					eventType: event.type,
					nextRetryAt,
					delayMs,
				});

				await this.ensureRetrySweepSchedule();
			},
			catch: (cause) => new EventBusDbError({ operation: "queueForRetry", cause }),
		});
	}

	private async ensureRetrySweepSchedule(): Promise<void> {
		const [earliest] = await this.db
			.select({ nextRetryAt: pendingEvents.nextRetryAt })
			.from(pendingEvents)
			.orderBy(pendingEvents.nextRetryAt)
			.limit(1);

		if (!earliest) {
			await this.clearRetrySweepSchedule();
			return;
		}

		const earliestDueAt = earliest.nextRetryAt;
		if (new Date(earliestDueAt).getTime() <= Date.now()) {
			await this.clearRetrySweepSchedule();
			await this.retryDueEventsTick(earliestDueAt);
			return;
		}

		if (
			this.state.retrySweepScheduleId !== null &&
			this.state.retrySweepDueAt === earliestDueAt &&
			this.getSchedule(this.state.retrySweepScheduleId) !== undefined
		) {
			return;
		}

		await this.scheduleRetrySweepAt(earliestDueAt);
	}

	private async ensureDlqPurgeSchedule(): Promise<void> {
		const [earliest] = await this.db
			.select({ expiresAt: deadLetterQueue.expiresAt })
			.from(deadLetterQueue)
			.orderBy(deadLetterQueue.expiresAt)
			.limit(1);

		if (!earliest) {
			await this.clearDlqPurgeSchedule();
			return;
		}

		const earliestExpiryAt = earliest.expiresAt;
		if (new Date(earliestExpiryAt).getTime() <= Date.now()) {
			await this.clearDlqPurgeSchedule();
			await this.purgeExpiredDlqTick(earliestExpiryAt);
			return;
		}

		if (
			this.state.dlqPurgeScheduleId !== null &&
			this.state.dlqPurgeDueAt === earliestExpiryAt &&
			this.getSchedule(this.state.dlqPurgeScheduleId) !== undefined
		) {
			return;
		}

		await this.scheduleDlqPurgeAt(earliestExpiryAt);
	}

	private async scheduleRetrySweepAt(whenIso: string): Promise<void> {
		await this.clearRetrySweepSchedule();
		const schedule = await this.schedule(new Date(whenIso), "retryDueEventsTick", whenIso, {
			idempotent: true,
			retry: { maxAttempts: 1 },
		});
		this.setState({
			...this.state,
			retrySweepScheduleId: schedule.id,
			retrySweepDueAt: whenIso,
		});
	}

	private async scheduleDlqPurgeAt(whenIso: string): Promise<void> {
		await this.clearDlqPurgeSchedule();
		const schedule = await this.schedule(new Date(whenIso), "purgeExpiredDlqTick", whenIso, {
			idempotent: true,
			retry: { maxAttempts: 1 },
		});
		this.setState({
			...this.state,
			dlqPurgeScheduleId: schedule.id,
			dlqPurgeDueAt: whenIso,
		});
	}

	private async clearRetrySweepSchedule(): Promise<void> {
		if (this.state.retrySweepScheduleId !== null) {
			await this.cancelSchedule(this.state.retrySweepScheduleId);
		}

		if (this.state.retrySweepScheduleId !== null || this.state.retrySweepDueAt !== null) {
			this.setState({
				...this.state,
				retrySweepScheduleId: null,
				retrySweepDueAt: null,
			});
		}
	}

	private async clearDlqPurgeSchedule(): Promise<void> {
		if (this.state.dlqPurgeScheduleId !== null) {
			await this.cancelSchedule(this.state.dlqPurgeScheduleId);
		}

		if (this.state.dlqPurgeScheduleId !== null || this.state.dlqPurgeDueAt !== null) {
			this.setState({
				...this.state,
				dlqPurgeScheduleId: null,
				dlqPurgeDueAt: null,
			});
		}
	}

	private async deliverEvent(
		event: Event,
		handlerKey: "ACHIEVEMENTS_DO",
	): Promise<Result<void, EventBusHandlerError>> {
		try {
			const stub = getStub(handlerKey);
			const result = await stub.handleEvent(event);

			if (result.isErr()) {
				const cause = result.error;
				logger.error("EventBusDO: Handler returned error", {
					eventId: event.id,
					eventType: event.type,
					handler: handlerKey,
					errorTag:
						cause && typeof cause === "object" && "_tag" in cause ? cause._tag : "UnknownError",
					errorMessage: cause instanceof Error ? cause.message : String(cause),
					errorStack: cause instanceof Error ? cause.stack : undefined,
					cause: cause && typeof cause === "object" ? JSON.stringify(cause) : cause,
				});
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
			logger.error("EventBusDO: Handler threw exception", {
				eventId: event.id,
				eventType: event.type,
				handler: handlerKey,
				errorMessage: error instanceof Error ? error.message : String(error),
				errorStack: error instanceof Error ? error.stack : undefined,
				error: error && typeof error === "object" ? JSON.stringify(error) : error,
			});
			return Result.err(
				new EventBusHandlerError({
					eventType: event.type,
					handlerName: handlerKey,
					cause: error,
				}),
			);
		}
	}

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

	@rpc
	async getPending(options?: {
		limit?: number;
		offset?: number;
	}): Promise<Result<PendingListResponse, EventBusDbError>> {
		const limit = options?.limit ?? 50;
		const offset = options?.offset ?? 0;

		return Result.tryPromise({
			try: async () => {
				const items = await this.db
					.select()
					.from(pendingEvents)
					.orderBy(pendingEvents.nextRetryAt)
					.limit(limit)
					.offset(offset);

				const allItems = await this.db.select().from(pendingEvents);
				const totalCount = allItems.length;

				const parsedItems: PendingItem[] = items.map((item) => {
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
						attempts: item.attempts,
						nextRetryAt: item.nextRetryAt,
						createdAt: item.createdAt,
					};
				});

				return {
					items: parsedItems,
					totalCount,
					limit,
					offset,
				};
			},
			catch: (cause) => new EventBusDbError({ operation: "getPending", cause }),
		});
	}

	@rpc
	async getDLQ(options?: {
		limit?: number;
		offset?: number;
	}): Promise<Result<DLQListResponse, EventBusDbError>> {
		const limit = options?.limit ?? 50;
		const offset = options?.offset ?? 0;

		return Result.tryPromise({
			try: async () => {
				const items = await this.db
					.select()
					.from(deadLetterQueue)
					.orderBy(desc(deadLetterQueue.lastFailedAt))
					.limit(limit)
					.offset(offset);

				const allItems = await this.db.select().from(deadLetterQueue);
				const totalCount = allItems.length;

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

	@rpc
	async replayDLQ(
		id: string,
	): Promise<
		Result<ReplayResult, EventBusDbError | DLQItemNotFoundError | EventBusValidationError>
	> {
		const [item] = await this.db.select().from(deadLetterQueue).where(eq(deadLetterQueue.id, id));

		if (!item) {
			return Result.err(new DLQItemNotFoundError({ eventId: id }));
		}

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

		const deliveryResult = await this.deliverEvent(event, handlerKey);
		if (deliveryResult.isOk()) {
			await this.db.delete(deadLetterQueue).where(eq(deadLetterQueue.id, id));
			await this.ensureDlqPurgeSchedule();
			logger.info("EventBusDO: DLQ replay succeeded", { eventId: event.id });
			return Result.ok({ success: true, eventId: event.id });
		}

		const now = new Date().toISOString();
		await this.db
			.update(deadLetterQueue)
			.set({
				lastFailedAt: now,
				error: deliveryResult.error.message,
			})
			.where(eq(deadLetterQueue.id, id));
		await this.ensureDlqPurgeSchedule();

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

	@rpc
	async deleteDLQ(id: string): Promise<Result<void, EventBusDbError | DLQItemNotFoundError>> {
		const [item] = await this.db.select().from(deadLetterQueue).where(eq(deadLetterQueue.id, id));

		if (!item) {
			return Result.err(new DLQItemNotFoundError({ eventId: id }));
		}

		return Result.tryPromise({
			try: async () => {
				await this.db.delete(deadLetterQueue).where(eq(deadLetterQueue.id, id));
				await this.ensureDlqPurgeSchedule();
				logger.info("EventBusDO: DLQ item deleted", { eventId: id });
			},
			catch: (cause) => new EventBusDbError({ operation: "deleteDLQ", cause }),
		});
	}

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

export interface DLQItem {
	id: string;
	event: Event | null;
	error: string;
	attempts: number;
	firstFailedAt: string;
	lastFailedAt: string;
	expiresAt: string;
}

export interface DLQListResponse {
	items: DLQItem[];
	totalCount: number;
	limit: number;
	offset: number;
}

export interface PendingItem {
	id: string;
	event: Event | null;
	attempts: number;
	nextRetryAt: string;
	createdAt: string;
}

export interface PendingListResponse {
	items: PendingItem[];
	totalCount: number;
	limit: number;
	offset: number;
}

export interface ReplayResult {
	success: boolean;
	eventId: string;
	error?: string;
}

export const EventBusDO = withRpcSerialization(_EventBusDO);
