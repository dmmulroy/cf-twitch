/**
 * Analytics Engine helpers for metric writing
 *
 * Schema documentation:
 * - song_request: blobs=[requester, trackId, trackName, status], doubles=[latencyMs], index=song_request
 * - raffle_roll: blobs=[user, status], doubles=[roll, winningNumber, distance], index=raffle_roll
 * - viewer_count: blobs=[], doubles=[count], index=viewer_count
 * - stream_session: blobs=[sessionId], doubles=[durationMs, peakViewers], index=stream_session
 * - spotify_sync: blobs=[], doubles=[latencyMs, queueSize, matchedCount], index=spotify_sync
 * - app_error: blobs=[errorTag, endpoint], doubles=[statusCode], index=app_error
 *
 * Query patterns:
 * - Use `WHERE index1 = 'event_name'` (NOT blob1)
 * - Use `SUM(_sample_interval)` for event counts
 * - Use `SUM(_sample_interval * doubleN) / SUM(_sample_interval)` for weighted averages
 */

import { logger } from "./logger";

/** Maximum blob length (Analytics Engine limit) */
const MAX_BLOB_LENGTH = 255;

/**
 * Truncate string to Analytics Engine blob limit
 */
function truncate(value: string): string {
	return value.length > MAX_BLOB_LENGTH ? value.slice(0, MAX_BLOB_LENGTH) : value;
}

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
 * Viewer count metric data
 */
export interface ViewerCountMetric {
	count: number;
}

/**
 * Stream session metric data (written on stream offline)
 */
export interface StreamSessionMetric {
	sessionId: string;
	durationMs: number;
	peakViewers: number;
}

/**
 * Spotify sync metric data
 */
export interface SpotifySyncMetric {
	latencyMs: number;
	queueSize: number;
	matchedCount: number;
}

/**
 * App error metric data (API/DO errors, not worker exceptions)
 */
export interface AppErrorMetric {
	errorTag: string;
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
		blobs: [
			truncate(metric.requester),
			truncate(metric.trackId),
			truncate(metric.trackName),
			metric.status,
		],
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
		blobs: [truncate(metric.user), metric.status],
		doubles: [metric.roll, metric.winningNumber, metric.distance],
	});
}

/**
 * Write a viewer count metric to Analytics Engine
 */
export function writeViewerCountMetric(
	analytics: AnalyticsEngineDataset,
	metric: ViewerCountMetric,
): void {
	safeWriteMetric(analytics, "viewer_count", {
		doubles: [metric.count],
	});
}

/**
 * Write a stream session metric to Analytics Engine
 */
export function writeStreamSessionMetric(
	analytics: AnalyticsEngineDataset,
	metric: StreamSessionMetric,
): void {
	safeWriteMetric(analytics, "stream_session", {
		blobs: [metric.sessionId],
		doubles: [metric.durationMs, metric.peakViewers],
	});
}

/**
 * Write a Spotify sync metric to Analytics Engine
 */
export function writeSpotifySyncMetric(
	analytics: AnalyticsEngineDataset,
	metric: SpotifySyncMetric,
): void {
	safeWriteMetric(analytics, "spotify_sync", {
		doubles: [metric.latencyMs, metric.queueSize, metric.matchedCount],
	});
}

/**
 * Write an app error metric to Analytics Engine
 */
export function writeAppErrorMetric(
	analytics: AnalyticsEngineDataset,
	metric: AppErrorMetric,
): void {
	safeWriteMetric(analytics, "app_error", {
		blobs: [truncate(metric.errorTag), truncate(metric.endpoint ?? "")],
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
