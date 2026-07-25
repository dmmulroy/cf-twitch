import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { TwitchTokenDO } from "../../durable-objects/twitch-token-do";
import { VALID_TOKEN_RESPONSE, mockTwitchChatMessage } from "../fixtures/twitch";
import {
	ensureAchievementsSingletonStub,
	ensureNamedSpotifyTokenStub,
	ensureNamedTwitchTokenStub,
} from "../helpers/durable-objects";
import { fetchMock } from "../helpers/fetch-mock";

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

async function postSignedEventSub(input: {
	readonly messageId?: string;
	readonly timestamp?: string;
	readonly messageType?: "notification" | "webhook_callback_verification" | "revocation";
	readonly subscriptionType: string;
	readonly version?: string;
	readonly retryCount?: string;
	readonly body: string;
	readonly signature?: string;
}): Promise<Response> {
	const messageId = input.messageId ?? `eventsub-${crypto.randomUUID()}`;
	const timestamp = input.timestamp ?? new Date().toISOString();
	const signature =
		input.signature ?? (await signEventSubMessage(messageId, timestamp, input.body));
	return exports.default.fetch("http://localhost/webhooks/twitch", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"twitch-eventsub-message-id": messageId,
			"twitch-eventsub-message-retry": input.retryCount ?? "0",
			"twitch-eventsub-message-type": input.messageType ?? "notification",
			"twitch-eventsub-message-signature": signature,
			"twitch-eventsub-message-timestamp": timestamp,
			"twitch-eventsub-subscription-type": input.subscriptionType,
			"twitch-eventsub-subscription-version": input.version ?? "1",
		},
		body: input.body,
	});
}

function eventSubSubscription(type: string, overrides: Record<string, unknown> = {}): object {
	return {
		id: "subscription-id",
		type,
		version: "1",
		status: "enabled",
		cost: 0,
		condition: {},
		transport: { method: "webhook", callback: "http://localhost/webhooks/twitch" },
		created_at: "2026-05-25T00:00:00Z",
		...overrides,
	};
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

		const response = await exports.default.fetch("http://localhost/webhooks/twitch", {
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
		const receiptStub = env.EVENTSUB_WEBHOOK_DO.get(env.EVENTSUB_WEBHOOK_DO.idFromName(messageId));
		const receipt = await receiptStub.getReceiptStatus();
		expect(receipt.status).toBe("ok");
		if (receipt.status === "ok") expect(receipt.value?.status).toBe("completed");

		const duplicate = await postSignedEventSub({
			messageId,
			timestamp,
			subscriptionType: "channel.raid",
			body,
		});
		expect(duplicate.status).toBe(200);
	});

	it("rejects missing headers, malformed retry counts, stale timestamps, and invalid signatures", async () => {
		const missing = await exports.default.fetch("http://localhost/webhooks/twitch", {
			method: "POST",
			body: "{}",
		});
		expect(missing.status).toBe(400);

		const body = JSON.stringify({
			subscription: eventSubSubscription("unknown.subscription"),
			event: {},
		});
		const malformedRetry = await postSignedEventSub({
			subscriptionType: "unknown.subscription",
			retryCount: "not-a-count",
			body,
		});
		expect(malformedRetry.status).toBe(400);

		const stale = await postSignedEventSub({
			timestamp: "2020-01-01T00:00:00Z",
			subscriptionType: "unknown.subscription",
			body,
		});
		expect(stale.status).toBe(403);
		const future = await postSignedEventSub({
			timestamp: "2099-01-01T00:00:00Z",
			subscriptionType: "unknown.subscription",
			body,
		});
		expect(future.status).toBe(403);

		const invalidSignature = await postSignedEventSub({
			subscriptionType: "unknown.subscription",
			body,
			signature: `sha256=${"0".repeat(64)}`,
		});
		expect(invalidSignature.status).toBe(403);
	});

	it("returns non-2xx when durable acceptance detects conflicting message content", async () => {
		const messageId = `conflict-${crypto.randomUUID()}`;
		const timestamp = new Date().toISOString();
		const firstBody = JSON.stringify({
			subscription: eventSubSubscription("unknown.subscription"),
			event: { value: 1 },
		});
		const first = await postSignedEventSub({
			messageId,
			timestamp,
			subscriptionType: "unknown.subscription",
			body: firstBody,
		});
		expect(first.status).toBe(200);

		const conflicting = await postSignedEventSub({
			messageId,
			timestamp,
			subscriptionType: "unknown.subscription",
			body: JSON.stringify({
				subscription: eventSubSubscription("unknown.subscription"),
				event: { value: 2 },
			}),
		});
		expect(conflicting.status).toBe(503);
	});

	it("returns a plain-text callback challenge only after complete signed parsing", async () => {
		const challenge = `challenge-${crypto.randomUUID()}`;
		const body = JSON.stringify({
			subscription: eventSubSubscription("stream.online", {
				status: "webhook_callback_verification_pending",
			}),
			challenge,
		});
		const response = await postSignedEventSub({
			messageType: "webhook_callback_verification",
			subscriptionType: "stream.online",
			body,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/plain");
		expect(await response.text()).toBe(challenge);
	});

	it("rejects invalid JSON and contradictory signed subscription metadata", async () => {
		const invalidJson = await postSignedEventSub({
			subscriptionType: "stream.online",
			body: "{",
		});
		expect(invalidJson.status).toBe(400);

		const body = JSON.stringify({
			subscription: eventSubSubscription("stream.offline"),
			event: {
				broadcaster_user_id: env.TWITCH_BROADCASTER_ID,
				broadcaster_user_login: "dillon",
				broadcaster_user_name: "dillon",
			},
		});
		const mismatch = await postSignedEventSub({
			subscriptionType: "stream.online",
			body,
		});
		expect(mismatch.status).toBe(400);
	});

	it("rejects malformed event-specific notification payloads before durable acceptance", async () => {
		for (const subscriptionType of [
			"stream.online",
			"stream.offline",
			"channel.channel_points_custom_reward_redemption.add",
			"channel.raid",
			"channel.chat.message",
		]) {
			const response = await postSignedEventSub({
				subscriptionType,
				body: JSON.stringify({
					subscription: eventSubSubscription(subscriptionType),
					event: {},
				}),
			});
			expect(response.status, subscriptionType).toBe(400);
		}
	});

	it("durably accepts chat and unknown reward notifications through their real dispatch paths", async () => {
		const chatBody = JSON.stringify({
			subscription: eventSubSubscription("channel.chat.message"),
			event: {
				broadcaster_user_id: env.TWITCH_BROADCASTER_ID,
				broadcaster_user_login: "dillon",
				broadcaster_user_name: "dillon",
				chatter_user_id: "viewer-id",
				chatter_user_login: "viewer",
				chatter_user_name: "Viewer",
				message_id: `chat-${crypto.randomUUID()}`,
				message: { text: "not a command", fragments: [] },
				badges: [],
			},
		});
		const chatResponse = await postSignedEventSub({
			subscriptionType: "channel.chat.message",
			body: chatBody,
		});
		expect(chatResponse.status).toBe(200);

		const redemptionBody = JSON.stringify({
			subscription: eventSubSubscription("channel.channel_points_custom_reward_redemption.add"),
			event: {
				id: `redemption-${crypto.randomUUID()}`,
				user_id: "viewer-id",
				user_login: "viewer",
				user_name: "Viewer",
				broadcaster_user_id: env.TWITCH_BROADCASTER_ID,
				broadcaster_user_login: "dillon",
				broadcaster_user_name: "dillon",
				reward: { id: "unknown-reward", title: "Unknown", cost: 1, prompt: "" },
				user_input: "",
				status: "unfulfilled",
				redeemed_at: new Date().toISOString(),
			},
		});
		const redemptionResponse = await postSignedEventSub({
			subscriptionType: "channel.channel_points_custom_reward_redemption.add",
			body: redemptionBody,
		});
		expect(redemptionResponse.status).toBe(200);
	});

	it("preserves Chat Command argument casing and checkpoints the provider send", async () => {
		await ensureTwitchTokenStub();
		const messageId = `chat-update-receipt-${crypto.randomUUID()}`;
		const chatMessageId = `chat-update-${crypto.randomUUID()}`;
		const timestamp = new Date().toISOString();
		const body = JSON.stringify({
			subscription: eventSubSubscription("channel.chat.message"),
			event: {
				broadcaster_user_id: env.TWITCH_BROADCASTER_ID,
				broadcaster_user_login: "dillon",
				broadcaster_user_name: "dillon",
				chatter_user_id: "moderator-id",
				chatter_user_login: "moderator",
				chatter_user_name: "ModeratorViewer",
				message_id: chatMessageId,
				message: { text: "!update today Using TypeScript", fragments: [] },
				badges: [{ set_id: "moderator", id: "1", info: "" }],
			},
		});
		mockTwitchChatMessage(fetchMock);
		const response = await postSignedEventSub({
			messageId,
			timestamp,
			subscriptionType: "channel.chat.message",
			body,
		});
		expect(response.status).toBe(200);

		const commandsStub = env.COMMANDS_DO.get(env.COMMANDS_DO.idFromName("commands"));
		await commandsStub.setName("commands");
		expect(await commandsStub.getCommandValue("today")).toMatchObject({
			status: "ok",
			value: "Using TypeScript",
		});
		const receiptStub = env.EVENTSUB_WEBHOOK_DO.get(env.EVENTSUB_WEBHOOK_DO.idFromName(messageId));
		expect(await receiptStub.getReceiptStatus()).toMatchObject({
			status: "ok",
			value: { status: "completed", chatCommandDelivery: "sent" },
		});

		const duplicate = await postSignedEventSub({
			messageId,
			timestamp,
			subscriptionType: "channel.chat.message",
			body,
		});
		expect(duplicate.status).toBe(200);
	});

	it("durably accepts a completely parsed revocation", async () => {
		const body = JSON.stringify({
			subscription: eventSubSubscription("channel.raid", { status: "authorization_revoked" }),
		});
		const response = await postSignedEventSub({
			messageType: "revocation",
			subscriptionType: "channel.raid",
			body,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
	});

	it("rejects an oversized body before signature verification", async () => {
		const messageId = `oversized-${crypto.randomUUID()}`;
		const timestamp = new Date().toISOString();
		const response = await exports.default.fetch("http://localhost/webhooks/twitch", {
			method: "POST",
			headers: {
				"twitch-eventsub-message-id": messageId,
				"twitch-eventsub-message-retry": "0",
				"twitch-eventsub-message-type": "notification",
				"twitch-eventsub-message-signature": `sha256=${"0".repeat(64)}`,
				"twitch-eventsub-message-timestamp": timestamp,
				"twitch-eventsub-subscription-type": "channel.raid",
				"twitch-eventsub-subscription-version": "1",
			},
			body: "x".repeat(1_048_577),
		});
		expect(response.status).toBe(413);
	});

	it("uses stream.online started_at as authoritative Stream Session time", async () => {
		await ensureNamedSpotifyTokenStub();
		await ensureNamedTwitchTokenStub();
		await ensureAchievementsSingletonStub();
		const startedAt = "2026-07-25T16:00:00.000Z";
		const body = JSON.stringify({
			subscription: eventSubSubscription("stream.online"),
			event: {
				id: "stream-id",
				broadcaster_user_id: env.TWITCH_BROADCASTER_ID,
				broadcaster_user_login: "dillon",
				broadcaster_user_name: "dillon",
				type: "live",
				started_at: startedAt,
			},
		});
		const response = await postSignedEventSub({ subscriptionType: "stream.online", body });
		expect(response.status).toBe(200);

		const streamStub = env.STREAM_LIFECYCLE_DO.get(
			env.STREAM_LIFECYCLE_DO.idFromName("stream-lifecycle"),
		);
		const state = await streamStub.getStreamState();
		expect(state.status).toBe("ok");
		if (state.status === "ok") expect(state.value.startedAt).toBe(startedAt);

		const offlineAt = new Date().toISOString();
		const offlineBody = JSON.stringify({
			subscription: eventSubSubscription("stream.offline"),
			event: {
				broadcaster_user_id: env.TWITCH_BROADCASTER_ID,
				broadcaster_user_login: "dillon",
				broadcaster_user_name: "dillon",
			},
		});
		const offlineResponse = await postSignedEventSub({
			timestamp: offlineAt,
			subscriptionType: "stream.offline",
			body: offlineBody,
		});
		expect(offlineResponse.status).toBe(200);
		const offlineState = await streamStub.getStreamState();
		expect(offlineState.status).toBe("ok");
		if (offlineState.status === "ok") expect(offlineState.value.endedAt).toBe(offlineAt);
	});
});
