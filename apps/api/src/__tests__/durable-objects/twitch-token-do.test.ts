/**
 * TwitchTokenDO unit tests
 *
 * Tests token management, refresh flows, and stream lifecycle handling.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import {
	mockTwitchTokenRefresh,
	mockTwitchTokenRefreshError,
	VALID_TOKEN_RESPONSE,
} from "../fixtures/twitch";
import { fetchMock } from "../helpers/fetch-mock";

describe("TwitchTokenDO", () => {
	let objectName: string;
	let stub: DurableObjectStub<TwitchTokenDO>;

	beforeEach(async () => {
		objectName = `twitch-token-${crypto.randomUUID()}`;
		const id = env.TWITCH_TOKEN_DO.idFromName(objectName);
		stub = env.TWITCH_TOKEN_DO.get(id);
		await stub.setName(objectName);
		await stub.getValidToken().catch(() => undefined);
	});

	describe("setTokens", () => {
		it("should persist tokens and return Ok", async () => {
			const result = await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				return instance.setTokens(VALID_TOKEN_RESPONSE);
			});

			expect(result.status).toBe("ok");
		});

		it("rejects malformed token RPC payloads before persistence", async () => {
			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.setTokens({ ...VALID_TOKEN_RESPONSE, expires_in: 0 }),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") expect(result.error._tag).toBe("TokenInputParseError");
		});

		it("requires a refresh credential during initial OAuth setup", async () => {
			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.setTokens({ ...VALID_TOKEN_RESPONSE, refresh_token: undefined }),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") expect(result.error._tag).toBe("NoRefreshTokenError");
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
		it("should return TokenNotConfiguredError when no token and stream offline", async () => {
			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("TokenNotConfiguredError");
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
					expires_in: 1, // Inside the five-minute refresh window
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
					expires_in: 1, // Inside the five-minute refresh window
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

	describe("scheduled refresh", () => {
		it("refreshes the current token via the scheduled callback", async () => {
			mockTwitchTokenRefresh(fetchMock, {
				...VALID_TOKEN_RESPONSE,
				access_token: "scheduled-refresh-token",
			});

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
				await instance.onStreamOnline();
			});

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.refreshTokenTick();
			});

			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toBe("scheduled-refresh-token");
			}
		});

		it("schedules a durable retry after a foreground refresh failure", async () => {
			mockTwitchTokenRefreshError(fetchMock, 503, "Service unavailable");

			const result = await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
				await instance.onStreamOnline();
				await instance.setTokens({ ...VALID_TOKEN_RESPONSE, expires_in: 1 });
				const tokenResult = await instance.getValidToken();
				return { tokenResult, schedules: await instance.getSchedules() };
			});

			expect(result.tokenResult.status).toBe("error");
			expect(result.schedules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ callback: "refreshTokenTick", delayInSeconds: 60 }),
				]),
			);
		});

		it("schedules a 60 second retry after a retryable refresh failure", async () => {
			mockTwitchTokenRefreshError(fetchMock, 503, "Service unavailable");

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
				await instance.onStreamOnline();
			});

			const schedules = await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.refreshTokenTick();
				return instance.getSchedules();
			});

			expect(schedules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "delayed",
						callback: "refreshTokenTick",
						delayInSeconds: 60,
					}),
				]),
			);
		});

		it("schedules a 10 minute fallback after a non-retryable refresh failure", async () => {
			fetchMock
				.get("https://id.twitch.tv")
				.intercept({ path: "/oauth2/token", method: "POST" })
				.reply(200, JSON.stringify({ invalid: true }), {
					headers: { "content-type": "application/json" },
				});

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
				await instance.onStreamOnline();
			});

			const schedules = await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.refreshTokenTick();
				return instance.getSchedules();
			});

			expect(schedules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "delayed",
						callback: "refreshTokenTick",
						delayInSeconds: 600,
					}),
				]),
			);
		});
	});

	describe("onStreamOnline/onStreamOffline", () => {
		it("should enable token refresh when stream goes online", async () => {
			// Set up expired token
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: 1, // Inside the five-minute refresh window
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

		it("schedules a durable retry when the online transition refresh fails", async () => {
			mockTwitchTokenRefreshError(fetchMock, 503, "Service unavailable");
			const outcome = await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens({ ...VALID_TOKEN_RESPONSE, expires_in: 1 });
				const onlineResult = await instance.onStreamOnline();
				return { onlineResult, schedules: await instance.getSchedules() };
			});

			expect(outcome.onlineResult.status).toBe("error");
			expect(outcome.schedules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ callback: "refreshTokenTick", delayInSeconds: 60 }),
				]),
			);
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

		it("cancels scheduled refresh work when the stream goes offline", async () => {
			const schedules = await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
				await instance.onStreamOnline();
				await instance.onStreamOffline();
				return instance.getSchedules();
			});

			expect(schedules).toHaveLength(0);
		});
	});

	describe("token refresh error handling", () => {
		it("should require reauthorization on terminal 401", async () => {
			mockTwitchTokenRefreshError(fetchMock, 401, "Unauthorized");

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: 1, // Inside the five-minute refresh window
				});
				// onStreamOnline triggers refresh - check its result directly
				const result = await instance.onStreamOnline();
				expect(result.status).toBe("error");
				if (result.status === "error") {
					expect(result.error._tag).toBe("TokenAuthorizationRevokedError");
				}
			});
		});

		it("persists reauthorization-required and stops scheduling after revoked credentials", async () => {
			mockTwitchTokenRefreshError(
				fetchMock,
				400,
				JSON.stringify({ status: 400, message: "Invalid refresh token" }),
			);

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens({ ...VALID_TOKEN_RESPONSE, expires_in: 1 });
				const result = await instance.onStreamOnline();
				expect(result.status).toBe("error");
				if (result.status === "error")
					expect(result.error._tag).toBe("TokenAuthorizationRevokedError");
				expect(await instance.getSchedules()).toHaveLength(0);
				const laterResult = await instance.getValidToken();
				expect(laterResult.status).toBe("error");
				if (laterResult.status === "error")
					expect(laterResult.error._tag).toBe("TokenAuthorizationRevokedError");
			});
		});

		it("should return TokenRefreshParseError on malformed JSON", async () => {
			fetchMock
				.get("https://id.twitch.tv")
				.intercept({ path: "/oauth2/token", method: "POST" })
				.reply(200, "not valid json");

			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens({
					...VALID_TOKEN_RESPONSE,
					expires_in: 1, // Inside the five-minute refresh window
				});
				// onStreamOnline triggers refresh - check its result directly
				const result = await instance.onStreamOnline();
				expect(result.status).toBe("error");
				if (result.status === "error") {
					expect(result.error._tag).toBe("TokenRefreshParseError");
				}
			});
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
					expires_in: 1, // Inside the five-minute refresh window
				});
				// onStreamOnline triggers refresh - check its result directly
				const result = await instance.onStreamOnline();
				expect(result.status).toBe("error");
				if (result.status === "error") {
					expect(result.error._tag).toBe("TokenRefreshParseError");
				}
			});
		});

		it("should return TokenNotConfiguredError when no token cache exists", async () => {
			// No tokens set, stream offline - getValidToken should error
			const result = await runInDurableObject(stub, (instance: TwitchTokenDO) =>
				instance.getValidToken(),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("TokenNotConfiguredError");
			}
		});
	});

	describe("persistence", () => {
		it("migrates legacy persisted state before token retrieval", async () => {
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				instance.setState({
					token: {
						accessToken: "legacy-access",
						refreshToken: "legacy-refresh",
						tokenType: "bearer",
						expiresIn: 3600,
						expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
					},
					isStreamLive: false,
					refreshScheduleId: null,
					refreshRetryCount: 0,
				});
				await instance.onStart();
				const result = await instance.getValidToken();
				expect(result.status).toBe("ok");
				if (result.status === "ok") expect(result.value).toBe("legacy-access");
			});
		});

		it("safely resets malformed persisted state", async () => {
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				instance.setState({ token: { accessToken: "leaked-partial" } });
				await instance.onStart();
				const result = await instance.getValidToken();
				expect(result.status).toBe("error");
				if (result.status === "error") expect(result.error._tag).toBe("TokenNotConfiguredError");
			});
		});

		it("should persist tokens across DO instances", async () => {
			await runInDurableObject(stub, async (instance: TwitchTokenDO) => {
				await instance.setTokens(VALID_TOKEN_RESPONSE);
			});

			const newStub = env.TWITCH_TOKEN_DO.get(env.TWITCH_TOKEN_DO.idFromName(objectName));

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
