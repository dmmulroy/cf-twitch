/**
 * TwitchTokenDO unit tests
 *
 * Tests token management, refresh flows, and stream lifecycle handling.
 */

import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import {
	mockTwitchTokenRefresh,
	mockTwitchTokenRefreshError,
	VALID_TOKEN_RESPONSE,
} from "../fixtures/twitch";

describe("TwitchTokenDO", () => {
	let stub: DurableObjectStub<TwitchTokenDO>;

	beforeEach(() => {
		const id = env.TWITCH_TOKEN_DO.idFromName("twitch-token");
		stub = env.TWITCH_TOKEN_DO.get(id);
	});

	describe("setTokens", () => {
		it("should persist tokens and return Ok", async () => {
			const result = await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				return instance.setTokens(VALID_TOKEN_RESPONSE);
			});

			expect(result.status).toBe("ok");
		});

		it("should preserve existing refresh_token if not provided in new response", async () => {
			// First set tokens with refresh_token
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
			});

			// Set tokens without refresh_token
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					refresh_token: undefined,
				});
			});

			// Token should still be retrievable
			const tokenResult = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);
			expect(tokenResult.status).toBe("ok");
		});
	});

	describe("getValidToken", () => {
		it("should return StreamOfflineNoTokenError when no token and stream offline", async () => {
			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("StreamOfflineNoTokenError");
			}
		});

		it("should return cached token when stream is offline", async () => {
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
			});

			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe("test-twitch-access-token");
			}
		});

		it("should return valid token without refresh when not expired", async () => {
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe("test-twitch-access-token");
			}
		});

		it("should refresh token when stream is live and token expired", async () => {
			mockTwitchTokenRefresh(fetchMock);

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				// Set expired token
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired 1 hour ago
				});
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("ok");
		});

		it("should coalesce concurrent refresh requests", async () => {
			mockTwitchTokenRefresh(fetchMock);

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
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

				// All should succeed
				for (const r of results) {
					expect(r.status).toBe("ok");
				}
			});
		});
	});

	describe("onStreamOnline/onStreamOffline", () => {
		it("should enable token refresh when stream goes online", async () => {
			// Set up expired token
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired
				});
			});

			// Mock refresh endpoint
			mockTwitchTokenRefresh(fetchMock);

			// Go online and request token - should trigger refresh
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.onStreamOnline();
			});

			const onlineResult = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);
			expect(onlineResult.status).toBe("ok");
		});

		it("should disable proactive refresh when stream goes offline", async () => {
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
				await instance.onStreamOnline();
				await instance.onStreamOffline();
			});

			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);
			expect(result.status).toBe("ok");
		});
	});

	describe("token refresh error handling", () => {
		it("should return TokenRefreshNetworkError on 401", async () => {
			mockTwitchTokenRefreshError(fetchMock, 401, "Unauthorized");

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired
				});
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("TokenRefreshNetworkError");
			}
		});

		it("should return TokenRefreshParseError on malformed JSON", async () => {
			fetchMock
				.get("https://id.twitch.tv")
				.intercept({ path: "/oauth2/token", method: "POST" })
				.reply(200, "not valid json");

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired
				});
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("TokenRefreshParseError");
			}
		});

		it("should return TokenRefreshParseError on invalid schema", async () => {
			fetchMock
				.get("https://id.twitch.tv")
				.intercept({ path: "/oauth2/token", method: "POST" })
				.reply(200, JSON.stringify({ invalid: "response" }), {
					headers: { "content-type": "application/json" },
				});

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: -3600, // Expired
				});
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("TokenRefreshParseError");
			}
		});

		it("should return NoRefreshTokenError when no token cache exists", async () => {
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.onStreamOnline();
			});

			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("NoRefreshTokenError");
			}
		});
	});

	describe("persistence", () => {
		it("should persist tokens across DO instances", async () => {
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
			});

			const newStub = env.TWITCH_TOKEN_DO.get(env.TWITCH_TOKEN_DO.idFromName("twitch-token"));

			const result = await runInDurableObject(newStub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe("test-twitch-access-token");
			}
		});
	});
});
