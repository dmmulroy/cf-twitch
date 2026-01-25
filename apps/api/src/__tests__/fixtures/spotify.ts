/**
 * Spotify API mock responses and utilities
 */

import type { SpotifyTokenResponse } from "../../durable-objects/spotify-token-do";
import type { fetchMock as FetchMock } from "cloudflare:test";

/**
 * Valid token response from Spotify OAuth
 */
export const VALID_TOKEN_RESPONSE: SpotifyTokenResponse = {
	access_token: "test-access-token",
	token_type: "Bearer",
	expires_in: 3600,
	refresh_token: "test-refresh-token",
	scope: "user-read-playback-state user-modify-playback-state",
};

/**
 * Expired token response (for testing refresh flows)
 */
export const EXPIRED_TOKEN_RESPONSE: SpotifyTokenResponse = {
	...VALID_TOKEN_RESPONSE,
	expires_in: -3600, // Expired 1 hour ago
};

/**
 * Track info matching Spotify API format
 */
export const TRACK_INFO = {
	id: "4iV5W9uYEdYUVa79Axb7Rh",
	name: "Test Track",
	artists: [{ id: "artist1", name: "Test Artist" }],
	album: {
		name: "Test Album",
		images: [{ url: "https://example.com/cover.jpg", height: 64, width: 64 }],
	},
	duration_ms: 180000,
};

/**
 * Queue response matching Spotify API format
 */
export const QUEUE_RESPONSE = {
	currently_playing: TRACK_INFO,
	queue: [TRACK_INFO],
};

/**
 * Currently playing response
 */
export const CURRENTLY_PLAYING_RESPONSE = {
	is_playing: true,
	item: TRACK_INFO,
	progress_ms: 60000,
};

/**
 * Mock Spotify token refresh endpoint
 */
export function mockSpotifyTokenRefresh(
	mock: typeof FetchMock,
	response: SpotifyTokenResponse = VALID_TOKEN_RESPONSE,
): void {
	mock
		.get("https://accounts.spotify.com")
		.intercept({ path: "/api/token", method: "POST" })
		.reply(200, JSON.stringify(response), {
			headers: { "content-type": "application/json" },
		});
}

/**
 * Mock Spotify token refresh with error
 */
export function mockSpotifyTokenRefreshError(
	mock: typeof FetchMock,
	status: number,
	body = "Unauthorized",
): void {
	mock
		.get("https://accounts.spotify.com")
		.intercept({ path: "/api/token", method: "POST" })
		.reply(status, body);
}

/**
 * Mock Spotify get track endpoint
 */
export function mockSpotifyGetTrack(mock: typeof FetchMock, trackId: string): void {
	mock
		.get("https://api.spotify.com")
		.intercept({ path: `/v1/tracks/${trackId}` })
		.reply(200, JSON.stringify(TRACK_INFO), {
			headers: { "content-type": "application/json" },
		});
}

/**
 * Mock Spotify add to queue endpoint
 */
export function mockSpotifyAddToQueue(mock: typeof FetchMock): void {
	mock
		.get("https://api.spotify.com")
		.intercept({ path: /\/v1\/me\/player\/queue/, method: "POST" })
		.reply(204);
}

/**
 * Mock Spotify currently playing endpoint
 */
export function mockSpotifyCurrentlyPlaying(mock: typeof FetchMock, playing = true): void {
	if (playing) {
		mock
			.get("https://api.spotify.com")
			.intercept({ path: "/v1/me/player/currently-playing" })
			.reply(200, JSON.stringify(CURRENTLY_PLAYING_RESPONSE), {
				headers: { "content-type": "application/json" },
			});
	} else {
		mock
			.get("https://api.spotify.com")
			.intercept({ path: "/v1/me/player/currently-playing" })
			.reply(204);
	}
}

/**
 * Mock Spotify queue endpoint
 */
export function mockSpotifyQueue(mock: typeof FetchMock): void {
	mock
		.get("https://api.spotify.com")
		.intercept({ path: "/v1/me/player/queue" })
		.reply(200, JSON.stringify(QUEUE_RESPONSE), {
			headers: { "content-type": "application/json" },
		});
}

/**
 * Mock Spotify skip track endpoint
 */
export function mockSpotifySkipTrack(mock: typeof FetchMock): void {
	mock
		.get("https://api.spotify.com")
		.intercept({ path: "/v1/me/player/next", method: "POST" })
		.reply(204);
}
