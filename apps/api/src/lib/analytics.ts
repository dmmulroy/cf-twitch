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
