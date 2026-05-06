/**
 * Analytics Engine helpers for metric writing
 */

import { logger } from "./logger";

/**
 * Song request metric data.
 *
 * @param requester - Viewer who requested the song.
 * @param trackId - Spotify track identifier.
 * @param trackName - Human-readable track name.
 * @param status - Fulfillment status for the request.
 * @param latencyMs - Request latency in milliseconds.
 * @returns A serializable song request metric payload.
 */
export interface SongRequestMetric {
	requester: string;
	trackId: string;
	trackName: string;
	status: "fulfilled" | "failed";
	latencyMs: number;
}

/**
 * Raffle roll metric data.
 *
 * @param user - Viewer who rolled.
 * @param roll - Viewer roll value.
 * @param winningNumber - Winning raffle number.
 * @param distance - Distance between roll and winning number.
 * @param status - Whether the roll won or lost.
 * @returns A serializable raffle roll metric payload.
 */
export interface RaffleRollMetric {
	user: string;
	roll: number;
	winningNumber: number;
	distance: number;
	status: "win" | "loss";
}

/**
 * Error metric data.
 *
 * @param errorType - Error category or tag.
 * @param errorMessage - Human-readable error message.
 * @param endpoint - Optional endpoint associated with the error.
 * @param statusCode - Optional HTTP status code associated with the error.
 * @returns A serializable error metric payload.
 */
export interface ErrorMetric {
	errorType: string;
	errorMessage: string;
	endpoint?: string;
	statusCode?: number;
}

/**
 * Achievement unlock metric data.
 *
 * @param user - Viewer who unlocked the achievement.
 * @param achievementId - Achievement identifier.
 * @param achievementName - Human-readable achievement name.
 * @param category - Achievement category.
 * @returns A serializable achievement unlock metric payload.
 */
export interface AchievementUnlockMetric {
	user: string;
	achievementId: string;
	achievementName: string;
	category: string;
}

// =============================================================================
// Chat Command Metrics
// =============================================================================

/**
 * Chat command metric command identifier.
 *
 * @param command - Canonical command name.
 * @returns A string command identifier.
 */
export type ChatCommandType = string;

/**
 * Chat command metric status bucket.
 *
 * @param status - Success, ignored, or error status value.
 * @returns A supported chat command metric status.
 */
export type ChatCommandStatus = "success" | "ignored" | "error";

/**
 * Chat command metric data.
 *
 * @param command - Canonical command name.
 * @param userId - Twitch user identifier.
 * @param userName - Twitch display name.
 * @param status - Execution status bucket.
 * @param durationMs - Executor duration in milliseconds.
 * @param error - Optional error message for failed executions.
 * @returns A serializable chat command metric payload.
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
 * Write a chat command metric to Analytics Engine.
 *
 * @param analytics - Analytics Engine dataset binding.
 * @param metric - Chat command metric payload to write.
 * @returns Nothing.
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
 * Saga metric type identifier.
 *
 * @param sagaType - Supported saga type value.
 * @returns A supported saga metric type.
 */
export type SagaType = "song-request-saga" | "keyboard-raffle-saga";

/**
 * Saga lifecycle event identifier.
 *
 * @param event - Supported saga lifecycle event value.
 * @returns A supported saga lifecycle event.
 */
export type SagaEvent =
	| "started"
	| "step_started"
	| "step_completed"
	| "step_failed"
	| "step_compensated"
	| "step_compensation_failed"
	| "fulfilled"
	| "compensating"
	| "completed"
	| "failed";

/**
 * Saga lifecycle metric data.
 *
 * @param sagaType - Type of saga emitting the metric.
 * @param sagaId - Saga identifier that doubles as a trace identifier.
 * @param event - Lifecycle event being recorded.
 * @param stepName - Optional step name for step-level events.
 * @param error - Optional error message for failed events.
 * @param durationMs - Optional duration in milliseconds.
 * @returns A serializable saga lifecycle metric payload.
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
 * Write a saga lifecycle metric to Analytics Engine.
 *
 * @param analytics - Analytics Engine dataset binding.
 * @param metric - Saga lifecycle metric payload to write.
 * @returns Nothing.
 */
export function writeSagaLifecycleMetric(
	analytics: AnalyticsEngineDataset,
	metric: SagaLifecycleMetric,
): void {
	safeWriteMetric(analytics, metric.sagaType, {
		blobs: [metric.sagaId, metric.event, metric.stepName ?? "", (metric.error ?? "").slice(0, 900)],
		doubles: [metric.durationMs ?? 0],
	});
}

/**
 * Write a song request metric to Analytics Engine.
 *
 * @param analytics - Analytics Engine dataset binding.
 * @param metric - Song request metric payload to write.
 * @returns Nothing.
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
 * Write a raffle roll metric to Analytics Engine.
 *
 * @param analytics - Analytics Engine dataset binding.
 * @param metric - Raffle roll metric payload to write.
 * @returns Nothing.
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
 * Write an error metric to Analytics Engine.
 *
 * @param analytics - Analytics Engine dataset binding.
 * @param metric - Error metric payload to write.
 * @returns Nothing.
 */
export function writeErrorMetric(analytics: AnalyticsEngineDataset, metric: ErrorMetric): void {
	safeWriteMetric(analytics, "error", {
		blobs: [metric.errorType, metric.errorMessage, metric.endpoint ?? ""],
		doubles: [metric.statusCode ?? 0],
	});
}

/**
 * Write an achievement unlock metric to Analytics Engine.
 *
 * @param analytics - Analytics Engine dataset binding.
 * @param metric - Achievement unlock metric payload to write.
 * @returns Nothing.
 */
export function writeAchievementUnlockMetric(
	analytics: AnalyticsEngineDataset,
	metric: AchievementUnlockMetric,
): void {
	safeWriteMetric(analytics, "achievement_unlock", {
		blobs: [metric.user, metric.achievementId, metric.achievementName, metric.category],
		doubles: [],
	});
}

/**
 * Safely write an Analytics Engine data point and log failures.
 *
 * @param analytics - Analytics Engine dataset binding.
 * @param eventName - Event name to place in the Analytics Engine index.
 * @param data - Optional blob and double values for the data point.
 * @returns Nothing.
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
			event: "analytics.write.failed",
			component: "analytics",
			metric_name: eventName,
			error: error,
		});
	}
}
