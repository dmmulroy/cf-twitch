/**
 * Analytics Engine helpers for metric writing
 */

import { logger } from "./logger";

/**
 * Song request metric data
 */
export interface SongRequestMetric {
	requester: string;
	trackId: string;
	trackName: string;
	status: "fulfilled" | "failed";
	latencyMs: number;
}

/**
 * Raffle roll metric data
 */
export interface RaffleRollMetric {
	user: string;
	roll: number;
	winningNumber: number;
	distance: number;
	status: "win" | "loss";
}

/**
 * Error metric data
 */
export interface ErrorMetric {
	errorType: string;
	errorMessage: string;
	endpoint?: string;
	statusCode?: number;
}

// =============================================================================
// Chat Command Metrics
// =============================================================================

/**
 * Chat command types
 */
export type ChatCommandType = "song" | "queue";

/**
 * Chat command status
 */
export type ChatCommandStatus = "success" | "error";

/**
 * Chat command metric data
 */
export interface ChatCommandMetric {
	command: ChatCommandType;
	userId: string;
	userName: string;
	status: ChatCommandStatus;
	durationMs: number;
	error?: string;
}

/**
 * Write a chat command metric to Analytics Engine
 *
 * Index: "chat-command" (category-level queries)
 * Blobs: command, userId, userName, status, error
 * Doubles: durationMs
 */
export function writeChatCommandMetric(
	analytics: AnalyticsEngineDataset,
	metric: ChatCommandMetric,
): void {
	safeWriteMetric(analytics, "chat-command", {
		blobs: [
			metric.command,
			metric.userId,
			metric.userName,
			metric.status,
			(metric.error ?? "").slice(0, 900),
		],
		doubles: [metric.durationMs],
	});
}

// =============================================================================
// Saga Lifecycle Metrics
// =============================================================================

/**
 * Saga types for lifecycle tracking
 */
export type SagaType = "song-request-saga" | "keyboard-raffle-saga";

/**
 * Saga lifecycle events
 */
export type SagaEvent =
	| "started"
	| "step_started"
	| "step_completed"
	| "step_failed"
	| "step_compensated"
	| "step_compensation_failed"
	| "fulfilled" // point of no return
	| "compensating"
	| "completed"
	| "failed";

/**
 * Saga lifecycle metric data
 *
 * sagaId doubles as traceId for cross-service correlation (DO instance ID)
 */
export interface SagaLifecycleMetric {
	sagaType: SagaType;
	sagaId: string;
	event: SagaEvent;
	stepName?: string;
	error?: string;
	durationMs?: number;
}

/**
 * Write a saga lifecycle metric to Analytics Engine
 *
 * Index: sagaType (enables efficient filtering by saga type)
 * Blobs: sagaId, event, stepName, error (truncated to 900 bytes)
 * Doubles: durationMs
 */
export function writeSagaLifecycleMetric(
	analytics: AnalyticsEngineDataset,
	metric: SagaLifecycleMetric,
): void {
	safeWriteMetric(analytics, metric.sagaType, {
		blobs: [
			metric.sagaId,
			metric.event,
			metric.stepName ?? "",
			(metric.error ?? "").slice(0, 900), // truncate to AE blob limit
		],
		doubles: [metric.durationMs ?? 0],
	});
}

/**
 * Write a song request metric to Analytics Engine
 */
export function writeSongRequestMetric(
	analytics: AnalyticsEngineDataset,
	metric: SongRequestMetric,
): void {
	safeWriteMetric(analytics, "song_request", {
		blobs: [metric.requester, metric.trackId, metric.trackName, metric.status],
		doubles: [metric.latencyMs],
	});
}

/**
 * Write a raffle roll metric to Analytics Engine
 */
export function writeRaffleRollMetric(
	analytics: AnalyticsEngineDataset,
	metric: RaffleRollMetric,
): void {
	safeWriteMetric(analytics, "raffle_roll", {
		blobs: [metric.user, metric.status],
		doubles: [metric.roll, metric.winningNumber, metric.distance],
	});
}

/**
 * Write an error metric to Analytics Engine
 */
export function writeErrorMetric(analytics: AnalyticsEngineDataset, metric: ErrorMetric): void {
	safeWriteMetric(analytics, "error", {
		blobs: [metric.errorType, metric.errorMessage, metric.endpoint ?? ""],
		doubles: [metric.statusCode ?? 0],
	});
}

/**
 * Safe wrapper around analytics.writeDataPoint that catches and logs failures
 */
export function safeWriteMetric(
	analytics: AnalyticsEngineDataset,
	eventName: string,
	data: { blobs?: string[]; doubles?: number[] },
): void {
	try {
		analytics.writeDataPoint({
			blobs: data.blobs,
			doubles: data.doubles,
			indexes: [eventName],
		});
	} catch (error) {
		logger.error("Failed to write analytics metric", {
			eventName,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
