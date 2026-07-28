import { z } from "zod";

import { EventSchema } from "../domain/domain-event";

import type { DLQItemNotFoundError, EventBusDbError, EventBusValidationError } from "../lib/errors";
import type { Result } from "better-result";

/** Runtime parser for one Event Bus dead-letter item. */
export const DeadLetterItemSchema = z.object({
	id: z.string(),
	event: EventSchema.nullable(),
	error: z.string(),
	attempts: z.number().int().nonnegative(),
	firstFailedAt: z.string(),
	lastFailedAt: z.string(),
	expiresAt: z.string(),
});

/** Runtime parser for a paginated Event Bus dead-letter response. */
export const DeadLetterListSchema = z.object({
	items: z.array(DeadLetterItemSchema),
	totalCount: z.number().int().nonnegative(),
	limit: z.number().int().positive(),
	offset: z.number().int().nonnegative(),
});
export type DeadLetterList = z.infer<typeof DeadLetterListSchema>;

/** Runtime parser for one pending Event Bus delivery. */
export const PendingEventItemSchema = z.object({
	id: z.string(),
	event: EventSchema.nullable(),
	attempts: z.number().int().nonnegative(),
	nextRetryAt: z.string(),
	createdAt: z.string(),
});

/** Runtime parser for a paginated pending Event Bus response. */
export const PendingEventListSchema = z.object({
	items: z.array(PendingEventItemSchema),
	totalCount: z.number().int().nonnegative(),
	limit: z.number().int().positive(),
	offset: z.number().int().nonnegative(),
});
export type PendingEventList = z.infer<typeof PendingEventListSchema>;

/** Runtime parser for an attempted dead-letter replay. */
export const DeadLetterReplayResultSchema = z.object({
	success: z.boolean(),
	eventId: z.string(),
	error: z.string().optional(),
});
export type DeadLetterReplayResult = z.infer<typeof DeadLetterReplayResultSchema>;

export type EventBusAdministrationError =
	| EventBusDbError
	| EventBusValidationError
	| DLQItemNotFoundError;

/** Inspects and administers pending and dead-letter Event Bus deliveries. */
export interface EventBusAdministration {
	/** Lists pending Event Bus deliveries. */
	getPending(options: {
		readonly limit: number;
		readonly offset: number;
	}): Promise<Result<PendingEventList, EventBusAdministrationError>>;
	/** Lists dead-letter Event Bus deliveries. */
	getDeadLetters(options: {
		readonly limit: number;
		readonly offset: number;
	}): Promise<Result<DeadLetterList, EventBusAdministrationError>>;
	/** Attempts to replay one dead-letter Event. */
	replayDeadLetter(
		id: string,
	): Promise<Result<DeadLetterReplayResult, EventBusAdministrationError>>;
	/** Permanently deletes one dead-letter Event. */
	deleteDeadLetter(id: string): Promise<Result<void, EventBusAdministrationError>>;
}
