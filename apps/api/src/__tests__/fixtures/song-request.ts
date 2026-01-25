/**
 * Song request test data and utilities
 */

import type { InsertPendingRequest } from "../../durable-objects/schemas/song-queue-do.schema";
import type { SongRequestParams } from "../../workflows/song-request";

/**
 * Test pending request data
 */
export const TEST_PENDING_REQUEST: InsertPendingRequest = {
	eventId: "test-event-123",
	trackId: "4iV5W9uYEdYUVa79Axb7Rh",
	trackName: "Test Track",
	artists: JSON.stringify(["Test Artist"]),
	album: "Test Album",
	albumCoverUrl: "https://example.com/cover.jpg",
	requesterUserId: "user-123",
	requesterDisplayName: "TestUser",
	requestedAt: "2026-01-22T12:00:00.000Z",
};

/**
 * Song request workflow params (redemption event)
 */
export const SONG_REQUEST_PARAMS: SongRequestParams = {
	id: "redemption-123",
	broadcaster_user_id: "12345",
	broadcaster_user_login: "teststreamer",
	broadcaster_user_name: "TestStreamer",
	user_id: "user-123",
	user_login: "testuser",
	user_name: "TestUser",
	user_input: "https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh",
	status: "unfulfilled",
	reward: {
		id: "test-song-reward",
		title: "Song Request",
		cost: 100,
		prompt: "Enter a Spotify URL",
	},
	redeemed_at: "2026-01-22T12:00:00.000Z",
};

/**
 * Create a test pending request with custom values
 */
export function createPendingRequest(
	overrides: Partial<InsertPendingRequest> = {},
): InsertPendingRequest {
	return {
		...TEST_PENDING_REQUEST,
		...overrides,
		eventId: overrides.eventId ?? `test-event-${Date.now()}`,
	};
}

/**
 * Create song request params with custom values
 */
export function createSongRequestParams(
	overrides: Partial<SongRequestParams> = {},
): SongRequestParams {
	return {
		...SONG_REQUEST_PARAMS,
		...overrides,
		id: overrides.id ?? `redemption-${Date.now()}`,
	};
}
