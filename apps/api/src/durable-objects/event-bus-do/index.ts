/**
 * EventBusDO - Singleton event router for domain events
 *
 * Receives events from sagas/DOs, routes to registered handlers.
 * Phase 1: Basic publish/route (no retry/DLQ yet)
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";

import {
	EventBusHandlerError,
	EventBusRoutingError,
	EventBusValidationError,
	type EventBusError,
} from "../../lib/errors";
import { getStub } from "../../lib/durable-objects";
import { logger } from "../../lib/logger";
import { EventSchema, EventType, type Event } from "./schema";

import type { Env } from "../../index";

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
 * EventBusDO - Durable Object for event routing
 *
 * Singleton instance that receives domain events and routes them to
 * the appropriate handler DOs.
 */
export class EventBusDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/**
	 * Publish a domain event to be routed to handlers.
	 *
	 * Validates the event, looks up the route, and calls the handler's
	 * handleEvent() RPC method.
	 *
	 * @param event - The domain event to publish
	 * @returns Result<void, EventBusError> - Success if handler accepted the event
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

		// Route to handler
		// Note: AchievementsDO.handleEvent() will be implemented in a later task.
		// For now, we route to the stub but the method may not exist yet.
		// Once handleEvent is added to AchievementsDO, this will work.
		const routeResult = await this.routeToHandler(domainEvent, handlerKey);

		if (routeResult.isErr()) {
			logger.error("EventBusDO: Handler failed", {
				eventId: domainEvent.id,
				eventType: domainEvent.type,
				handler: handlerKey,
				error: routeResult.error.message,
			});
			return routeResult;
		}

		logger.info("EventBusDO: Event delivered", {
			eventId: domainEvent.id,
			eventType: domainEvent.type,
			handler: handlerKey,
		});

		return Result.ok();
	}

	/**
	 * Route event to a specific handler DO.
	 */
	private async routeToHandler(
		event: Event,
		handlerKey: "ACHIEVEMENTS_DO",
	): Promise<Result<void, EventBusError>> {
		try {
			const stub = getStub(handlerKey);

			// TODO: Remove this assertion once AchievementsDO implements EventHandler interface.
			// Track: type assertion violates conventions but required until handleEvent exists.
			const handler = stub as unknown as EventHandler;

			const result = await handler.handleEvent(event);

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
}
