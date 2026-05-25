import { env, fetchMock, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import { VALID_TOKEN_RESPONSE, mockTwitchChatMessage } from "../fixtures/twitch";

async function ensureTwitchTokenStub(): Promise<DurableObjectStub<TwitchTokenDO>> {
	const id = env.TWITCH_TOKEN_DO.idFromName("twitch-token");
	const stub = env.TWITCH_TOKEN_DO.get(id);
	await stub.setName("twitch-token");
	await stub.setTokens(VALID_TOKEN_RESPONSE);
	return stub;
}

async function signEventSubMessage(
	messageId: string,
	timestamp: string,
	body: string,
): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(env.TWITCH_EVENTSUB_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signatureBuffer = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(messageId + timestamp + body),
	);
	const hexSignature = Array.from(new Uint8Array(signatureBuffer))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `sha256=${hexSignature}`;
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

describe("Twitch webhooks", () => {
	it("routes channel.raid notifications to the raid shoutout saga", async () => {
		await ensureTwitchTokenStub();
		const messageId = `raid-message-${crypto.randomUUID()}`;
		const timestamp = new Date().toISOString();
		const raiderUserId = "raider-user-id";
		const body = JSON.stringify({
			subscription: {
				id: "subscription-id",
				type: "channel.raid",
				version: "1",
				status: "enabled",
				cost: 0,
				condition: { to_broadcaster_user_id: env.TWITCH_BROADCASTER_ID },
				transport: { method: "webhook", callback: "http://localhost/webhooks/twitch" },
				created_at: "2026-05-25T00:00:00Z",
			},
			event: {
				from_broadcaster_user_id: raiderUserId,
				from_broadcaster_user_login: "raiderlogin",
				from_broadcaster_user_name: "RaiderLogin",
				to_broadcaster_user_id: env.TWITCH_BROADCASTER_ID,
				to_broadcaster_user_login: "dillon",
				to_broadcaster_user_name: "dillon",
				viewers: 42,
			},
		});
		const signature = await signEventSubMessage(messageId, timestamp, body);
		mockTwitchChatMessage(fetchMock);
		mockTwitchShoutout(raiderUserId);

		const response = await SELF.fetch("http://localhost/webhooks/twitch", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"twitch-eventsub-message-id": messageId,
				"twitch-eventsub-message-retry": "0",
				"twitch-eventsub-message-type": "notification",
				"twitch-eventsub-message-signature": signature,
				"twitch-eventsub-message-timestamp": timestamp,
				"twitch-eventsub-subscription-type": "channel.raid",
				"twitch-eventsub-subscription-version": "1",
			},
			body,
		});

		expect(response.status).toBe(200);
	});
});
