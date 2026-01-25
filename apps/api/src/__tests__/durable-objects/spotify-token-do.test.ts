/**
 * SpotifyTokenDO unit tests
 *
 * Tests token management, refresh flows, and stream lifecycle handling.
 */

import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { SpotifyTokenDO } from "../../durable-objects/spotify-token-do";
import {
	mockSpotifyTokenRefresh,
	mockSpotifyTokenRefreshError,
	VALID_TOKEN_RESPONSE,
} from "../fixtures/spotify";

describe("SpotifyTokenDO", () => {
	let stub: DurableObjectStub<SpotifyTokenDO>;

	beforeEach(() => {
		const id = env.SPOTIFY_TOKEN_DO.idFromName("spotify-token");
		stub = env.SPOTIFY_TOKEN_DO.get(id);
	});

	describe("setTokens", () => {
		it("should persist tokens and return Ok", async () => {
			const result = await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				return instance.setTokens(VALID_TOKEN_RESPONSE);
			});

			expect(result.status).toBe("ok");
		});

		it("should preserve existing refresh_token if not provided in new response", async () => {
			// First set tokens with refresh_token
			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
			});

			// Set tokens without refresh_token (like a refresh response)
			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					refresh_token: undefined,
				});
			});

			// Token should still be retrievable
			const tokenResult = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);
			expect(tokenResult.status).toBe("ok");
		});
	});

	describe("getValidToken", () => {
		it("should return StreamOfflineNoTokenError when no token and stream offline", async () => {
			const result = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("StreamOfflineNoTokenError");
			}
		});

		it("should return cached token when stream is offline", async () => {
			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
			});

			const result = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe("test-access-token");
			}
		});

		it("should return valid token without refresh when not expired", async () => {
			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe("test-access-token");
			}
		});

		it("should refresh token when stream is live and token expired", async () => {
			mockSpotifyTokenRefresh(fetchMock);

			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				// Set expired token
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired 1 hour ago
				});
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("ok");
		});

		it("should coalesce concurrent refresh requests", async () => {
			mockSpotifyTokenRefresh(fetchMock);

			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired
				});
				await instance.onStreamOnline();

				// Fire multiple concurrent requests
				const results = await Promise.all([
					instance.getValidToken(),
					instance.getValidToken(),
					instance.getValidToken(),
				]);

				// All should succeed with same token
				for (const r of results) {
					expect(r.status).toBe("ok");
				}
			});
		});
	});

	describe("onStreamOnline/onStreamOffline", () => {
		it("should enable token refresh when stream goes online", async () => {
			// Set up expired token
			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired
				});
			});

			// When offline, should return cached token without refresh
			const offlineResult = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);
			expect(offlineResult.status).toBe("ok"); // Returns stale token

			// Mock refresh endpoint
			mockSpotifyTokenRefresh(fetchMock);

			// Go online and request token - should trigger refresh
			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.onStreamOnline();
			});

			const onlineResult = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);
			expect(onlineResult.status).toBe("ok"); // Refreshed token
		});

		it("should disable proactive refresh when stream goes offline", async () => {
			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
				await instance.onStreamOnline();
				await instance.onStreamOffline();
			});

			// Should not attempt refresh when offline
			const result = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);
			expect(result.status).toBe("ok");
		});
	});

	describe("token refresh error handling", () => {
		it("should return TokenRefreshNetworkError on 401", async () => {
			mockSpotifyTokenRefreshError(fetchMock, 401, "Unauthorized");

			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired
				});
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("TokenRefreshNetworkError");
			}
		});

		it("should return TokenRefreshParseError on malformed JSON", async () => {
			fetchMock
				.get("https://accounts.spotify.com")
				.intercept({ path: "/api/token", method: "POST" })
				.reply(200, "not valid json");

			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired
				});
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("TokenRefreshParseError");
			}
		});

		it("should return TokenRefreshParseError on invalid schema", async () => {
			fetchMock
				.get("https://accounts.spotify.com")
				.intercept({ path: "/api/token", method: "POST" })
				.reply(200, JSON.stringify({ invalid: "response" }), {
					headers: { "content-type": "application/json" },
				});

			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired
				});
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("TokenRefreshParseError");
			}
		});

		it("should return NoRefreshTokenError when no token cache exists during refresh", async () => {
			// Stream online but no tokens set
			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				// Will be NoRefreshTokenError since there's no token to refresh
				expect(result.error._tag).toBe("NoRefreshTokenError");
			}
		});
	});

	describe("persistence", () => {
		it("should persist tokens across DO instances", async () => {
			// Set tokens in one instance
			await runInDurableObject(stub, async (instance: SpotifyTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
			});

			// Create new stub to same ID (simulates restart)
			const newStub = env.SPOTIFY_TOKEN_DO.get(env.SPOTIFY_TOKEN_DO.idFromName("spotify-token"));

			const result = await runInDurableObject(newStub, (instance: SpotifyTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe("test-access-token");
			}
		});
	});
});
