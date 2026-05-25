import { env, fetchMock } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import { TwitchService } from "../../services/twitch-service";
import { VALID_TOKEN_RESPONSE } from "../fixtures/twitch";

async function ensureTwitchTokenStub(): Promise<DurableObjectStub<TwitchTokenDO>> {
	const id = env.TWITCH_TOKEN_DO.idFromName("twitch-token");
	const stub = env.TWITCH_TOKEN_DO.get(id);
	await stub.setName("twitch-token");
	await stub.setTokens(VALID_TOKEN_RESPONSE);
	return stub;
}

describe("TwitchService", () => {
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

		const service = new TwitchService(env);
		const result = await service.createShoutout(raiderUserId);

		expect(result.status).toBe("ok");
	});
});
