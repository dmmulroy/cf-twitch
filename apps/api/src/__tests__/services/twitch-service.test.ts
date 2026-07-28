import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { DurableObjectTwitchAccessTokens } from "../../adapters/cloudflare/durable-object-access-tokens";
import { LoggingTracer } from "../../capabilities/tracer";
import { parseWorkerConfiguration } from "../../configuration/worker-configuration";
import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import { logger } from "../../lib/logger";
import { TwitchService } from "../../services/twitch-service";
import { VALID_TOKEN_RESPONSE } from "../fixtures/twitch";
import { fetchMock } from "../helpers/fetch-mock";

async function ensureTwitchTokenStub(): Promise<DurableObjectStub<TwitchTokenDO>> {
	const id = env.TWITCH_TOKEN_DO.idFromName("twitch-token");
	const stub = env.TWITCH_TOKEN_DO.get(id);
	await stub.setName("twitch-token");
	await stub.setTokens(VALID_TOKEN_RESPONSE);
	return stub;
}

function twitchService(): TwitchService {
	const configuration = parseWorkerConfiguration(env);
	if (configuration.status === "error") throw configuration.error;
	return new TwitchService({
		configuration: configuration.value.twitch,
		accessTokens: new DurableObjectTwitchAccessTokens(
			env.TWITCH_TOKEN_DO,
			new LoggingTracer(logger),
		),
	});
}

describe("TwitchService", () => {
	it("rejects blank provider configuration before outbound I/O", () => {
		const result = parseWorkerConfiguration({ ...env, TWITCH_CLIENT_SECRET: "" });
		expect(result.status).toBe("error");
		expect(fetchMock.getRequests()).toHaveLength(0);
	});

	it("creates a native shoutout for the target broadcaster", async () => {
		await ensureTwitchTokenStub();
		const raiderUserId = "raider-user-id";
		const expectedPath = new RegExp(
			`^/helix/chat/shoutouts\\?` +
				`(?=.*from_broadcaster_id=${env.TWITCH_BROADCASTER_ID})` +
				`(?=.*to_broadcaster_id=${raiderUserId})` +
				`(?=.*moderator_id=${env.TWITCH_BROADCASTER_ID}).*$`,
		);
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: expectedPath, method: "POST" })
			.reply(204, "");

		const result = await twitchService().createShoutout(raiderUserId);
		expect(result.status).toBe("ok");
	});

	it("confirms chat delivery from the provider response", async () => {
		await ensureTwitchTokenStub();
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: "/helix/chat/messages", method: "POST" })
			.reply(
				200,
				JSON.stringify({
					data: [{ message_id: "message-1", is_sent: true, drop_reason: null }],
				}),
				{ headers: { "content-type": "application/json" } },
			);

		const result = await twitchService().sendChatMessage("safe test message");
		expect(result.status).toBe("ok");
	});

	it("returns a dropped-message error when Twitch does not deliver an HTTP 200 chat request", async () => {
		await ensureTwitchTokenStub();
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: "/helix/chat/messages", method: "POST" })
			.reply(
				200,
				JSON.stringify({
					data: [
						{
							message_id: "message-2",
							is_sent: false,
							drop_reason: { code: "automod_held", message: "held" },
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			);

		const result = await twitchService().sendChatMessage("message held by automod");
		expect(result).toEqual(
			expect.objectContaining({
				status: "error",
				error: expect.objectContaining({
					_tag: "TwitchChatDroppedError",
					dropCode: "automod_held",
				}),
			}),
		);
	});

	it("does not retry terminal chat 4xx responses", async () => {
		await ensureTwitchTokenStub();
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: "/helix/chat/messages", method: "POST" })
			.reply(422, "invalid message");

		const result = await twitchService().sendChatMessage("terminal rejection");
		expect(result).toEqual(
			expect.objectContaining({
				status: "error",
				error: expect.objectContaining({ _tag: "TwitchChatSendError", status: 422 }),
			}),
		);
		expect(
			fetchMock.getRequests().filter((request) => request.url.includes("/helix/chat/messages")),
		).toHaveLength(1);
	});

	it("returns validated Retry-After timing without retrying inside the adapter", async () => {
		await ensureTwitchTokenStub();
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: "/helix/chat/messages", method: "POST" })
			.reply(429, "rate limited", { headers: { "Retry-After": "12" } });

		const result = await twitchService().sendChatMessage("rate limited message");
		expect(result).toEqual(
			expect.objectContaining({
				status: "error",
				error: expect.objectContaining({ _tag: "TwitchRateLimitError", retryAfterMs: 12_000 }),
			}),
		);
		expect(
			fetchMock.getRequests().filter((request) => request.url.includes("/helix/chat/messages")),
		).toHaveLength(1);
	});

	it("rejects chat messages above Twitch's protocol limit before outbound I/O", async () => {
		const result = await twitchService().sendChatMessage("x".repeat(501));
		expect(result).toEqual(
			expect.objectContaining({
				status: "error",
				error: expect.objectContaining({ _tag: "TwitchChatSendError" }),
			}),
		);
		expect(fetchMock.getRequests()).toHaveLength(0);
	});

	it("reports malformed client-credentials responses as parse errors", async () => {
		fetchMock
			.get("https://id.twitch.tv")
			.intercept({ path: "/oauth2/token", method: "POST" })
			.reply(200, JSON.stringify({ access_token: "" }), {
				headers: { "content-type": "application/json" },
			});

		const result = await twitchService().getStreamInfo("teststreamer");
		expect(result).toEqual(
			expect.objectContaining({
				status: "error",
				error: expect.objectContaining({ _tag: "TwitchParseError" }),
			}),
		);
	});
});
