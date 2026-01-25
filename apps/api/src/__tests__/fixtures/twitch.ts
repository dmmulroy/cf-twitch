/**
 * Twitch API mock responses and utilities
 */

import type { TwitchTokenResponse } from "../../durable-objects/twitch-token-do";
import type { fetchMock as FetchMock } from "cloudflare:test";

/**
 * Valid token response from Twitch OAuth
 */
export const VALID_TOKEN_RESPONSE: TwitchTokenResponse = {
	access_token: "test-twitch-access-token",
	token_type: "bearer",
	expires_in: 14400,
	refresh_token: "test-twitch-refresh-token",
	scope: ["channel:read:redemptions", "channel:manage:redemptions", "chat:write"],
};

/**
 * Expired token response (for testing refresh flows)
 */
export const EXPIRED_TOKEN_RESPONSE: TwitchTokenResponse = {
	...VALID_TOKEN_RESPONSE,
	expires_in: -3600, // Expired 1 hour ago
};

/**
 * Stream info matching Twitch API format
 */
export const STREAM_INFO = {
	id: "stream-123",
	user_id: "12345",
	user_login: "teststreamer",
	user_name: "TestStreamer",
	game_id: "509670",
	game_name: "Science & Technology",
	type: "live",
	title: "Test Stream",
	viewer_count: 250,
	started_at: "2026-01-22T12:00:00Z",
	language: "en",
	thumbnail_url: "https://example.com/thumb.jpg",
	is_mature: false,
};

/**
 * Mock Twitch token refresh endpoint
 */
export function mockTwitchTokenRefresh(
	mock: typeof FetchMock,
	response: TwitchTokenResponse = VALID_TOKEN_RESPONSE,
): void {
	mock
		.get("https://id.twitch.tv")
		.intercept({ path: "/oauth2/token", method: "POST" })
		.reply(200, JSON.stringify(response), {
			headers: { "content-type": "application/json" },
		});
}

/**
 * Mock Twitch token refresh with error
 */
export function mockTwitchTokenRefreshError(
	mock: typeof FetchMock,
	status: number,
	body = "Unauthorized",
): void {
	mock
		.get("https://id.twitch.tv")
		.intercept({ path: "/oauth2/token", method: "POST" })
		.reply(status, body);
}

/**
 * Mock Twitch get streams endpoint
 */
export function mockTwitchGetStreams(mock: typeof FetchMock, live = true): void {
	mock
		.get("https://api.twitch.tv")
		.intercept({ path: /\/helix\/streams/ })
		.reply(
			200,
			JSON.stringify({
				data: live ? [STREAM_INFO] : [],
			}),
			{
				headers: { "content-type": "application/json" },
			},
		);
}

/**
 * Mock Twitch redemption update endpoint
 */
export function mockTwitchRedemptionUpdate(mock: typeof FetchMock): void {
	mock
		.get("https://api.twitch.tv")
		.intercept({ path: /\/helix\/channel_points\/custom_rewards\/redemptions/, method: "PATCH" })
		.reply(200, JSON.stringify({ data: [{}] }), {
			headers: { "content-type": "application/json" },
		});
}

/**
 * Mock Twitch chat message endpoint
 */
export function mockTwitchChatMessage(mock: typeof FetchMock): void {
	mock
		.get("https://api.twitch.tv")
		.intercept({ path: "/helix/chat/messages", method: "POST" })
		.reply(200, JSON.stringify({ data: [{}] }), {
			headers: { "content-type": "application/json" },
		});
}
