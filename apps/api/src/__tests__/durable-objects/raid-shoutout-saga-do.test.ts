import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { RaidShoutoutSagaDO } from "../../durable-objects/raid-shoutout-saga-do";
import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import { VALID_TOKEN_RESPONSE, mockTwitchChatMessage } from "../fixtures/twitch";
import { fetchMock } from "../helpers/fetch-mock";

async function createRaidShoutoutSagaStub(
	name: string,
): Promise<DurableObjectStub<RaidShoutoutSagaDO>> {
	const id = env.RAID_SHOUTOUT_SAGA_DO.idFromName(name);
	const stub = env.RAID_SHOUTOUT_SAGA_DO.get(id);
	await stub.setName(name);
	return stub;
}

async function ensureTwitchTokenStub(): Promise<DurableObjectStub<TwitchTokenDO>> {
	const id = env.TWITCH_TOKEN_DO.idFromName("twitch-token");
	const stub = env.TWITCH_TOKEN_DO.get(id);
	await stub.setName("twitch-token");
	await stub.setTokens(VALID_TOKEN_RESPONSE);
	return stub;
}

function mockTwitchShoutout(toBroadcasterId: string): void {
	const expectedPath = new RegExp(
		`^/helix/chat/shoutouts\\?` +
			`(?=.*from_broadcaster_id=${env.TWITCH_BROADCASTER_ID})` +
			`(?=.*to_broadcaster_id=${toBroadcasterId})` +
			`(?=.*moderator_id=${env.TWITCH_BROADCASTER_ID}).*$`,
	);

	fetchMock
		.get("https://api.twitch.tv")
		.intercept({ path: expectedPath, method: "POST" })
		.reply(204, "");
}

describe("RaidShoutoutSagaDO", () => {
	it("thanks the raider in chat and creates a native shoutout", async () => {
		await ensureTwitchTokenStub();
		const raiderUserId = "raider-user-id";
		const stub = await createRaidShoutoutSagaStub(`raid-shoutout-${crypto.randomUUID()}`);
		mockTwitchChatMessage(fetchMock);
		mockTwitchShoutout(raiderUserId);

		const result = await stub.start({
			messageId: `message-${crypto.randomUUID()}`,
			receivedAt: "2026-05-25T00:00:00.000Z",
			raider: {
				userId: raiderUserId,
				login: "raiderlogin",
				displayName: "RaiderLogin",
			},
			viewers: 42,
		});

		expect(result.status).toBe("ok");
	});

	it("does not repeat chat or native shoutout work when the same message is retried", async () => {
		await ensureTwitchTokenStub();
		const raiderUserId = "raider-user-id";
		const messageId = `message-${crypto.randomUUID()}`;
		const stub = await createRaidShoutoutSagaStub(messageId);
		const params = {
			messageId,
			receivedAt: "2026-05-25T00:00:00.000Z",
			raider: {
				userId: raiderUserId,
				login: "raiderlogin",
				displayName: "RaiderLogin",
			},
			viewers: 42,
		};
		mockTwitchChatMessage(fetchMock);
		mockTwitchShoutout(raiderUserId);

		const firstResult = await stub.start(params);
		const retryResult = await stub.start(params);

		expect(firstResult.status).toBe("ok");
		expect(retryResult.status).toBe("ok");
	});
});
