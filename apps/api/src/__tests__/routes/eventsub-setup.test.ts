import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { fetchMock } from "../helpers/fetch-mock";

const adminHeaders = { Authorization: `Bearer ${env.ADMIN_SECRET}` };

function mockAppToken(body: unknown = {
	access_token: "test-app-token",
	token_type: "bearer",
	expires_in: 3600,
}): void {
	fetchMock
		.get("https://id.twitch.tv")
		.intercept({ path: "/oauth2/token", method: "POST" })
		.reply(200, JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function eventSubSubscription(
	id: string,
	type: string,
	status: "enabled" | "webhook_callback_verification_pending" = "enabled",
): Record<string, unknown> {
	const condition =
		type === "channel.raid"
			? { to_broadcaster_user_id: env.TWITCH_BROADCASTER_ID }
			: type === "channel.chat.message"
				? {
						broadcaster_user_id: env.TWITCH_BROADCASTER_ID,
						user_id: env.TWITCH_BROADCASTER_ID,
					}
				: { broadcaster_user_id: env.TWITCH_BROADCASTER_ID };
	return {
		id,
		status,
		type,
		version: "1",
		cost: 0,
		condition,
		transport: { method: "webhook", callback: "http://localhost/webhooks/twitch" },
		created_at: "2026-05-25T00:00:00Z",
	};
}

function mockEventSubPage(data: unknown[], cursor?: string): void {
	fetchMock
		.get("https://api.twitch.tv")
		.intercept({
			path: cursor === undefined
				? "/helix/eventsub/subscriptions"
				: `/helix/eventsub/subscriptions?after=${cursor}`,
		})
		.reply(
			200,
			JSON.stringify({
				data,
				total: data.length,
				total_cost: 0,
				max_total_cost: 10,
				pagination: {},
			}),
			{ headers: { "content-type": "application/json" } },
		);
}

describe("EventSub management routes", () => {
	it("fails closed for missing, malformed, and wrong management credentials", async () => {
		const missing = await exports.default.fetch("http://localhost/eventsub/list");
		expect(missing.status).toBe(401);

		const malformed = await exports.default.fetch("http://localhost/eventsub/list", {
			headers: { Authorization: env.ADMIN_SECRET },
		});
		expect(malformed.status).toBe(401);

		const wrong = await exports.default.fetch("http://localhost/eventsub/list", {
			headers: { Authorization: "Bearer wrong-secret" },
		});
		expect(wrong.status).toBe(403);
	});

	it("lists every EventSub page", async () => {
		mockAppToken();
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: "/helix/eventsub/subscriptions" })
			.reply(
				200,
				JSON.stringify({
					data: [eventSubSubscription("first", "stream.online")],
					total: 2,
					total_cost: 0,
					max_total_cost: 10,
					pagination: { cursor: "next-page" },
				}),
				{ headers: { "content-type": "application/json" } },
			);
		mockEventSubPage([eventSubSubscription("second", "stream.offline")], "next-page");

		const response = await exports.default.fetch("http://localhost/eventsub/list", {
			headers: adminHeaders,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(
			expect.objectContaining({
				total: 2,
				subscriptions: [
					expect.objectContaining({ id: "first" }),
					expect.objectContaining({ id: "second" }),
				],
			}),
		);
	});

	it("treats callback-verification-pending subscriptions as idempotently configured", async () => {
		mockAppToken();
		mockEventSubPage([
			eventSubSubscription("online", "stream.online", "webhook_callback_verification_pending"),
			eventSubSubscription("offline", "stream.offline", "webhook_callback_verification_pending"),
			eventSubSubscription(
				"redemption",
				"channel.channel_points_custom_reward_redemption.add",
				"webhook_callback_verification_pending",
			),
			eventSubSubscription("chat", "channel.chat.message", "webhook_callback_verification_pending"),
			eventSubSubscription("raid", "channel.raid", "webhook_callback_verification_pending"),
		]);

		const response = await exports.default.fetch("http://localhost/eventsub/setup", {
			method: "POST",
			headers: adminHeaders,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(
			expect.objectContaining({ success: true, subscriptions: [], skipped: expect.any(Array) }),
		);
	});

	it("reports malformed app-token responses at the management entrypoint", async () => {
		mockAppToken({ access_token: "" });
		const response = await exports.default.fetch("http://localhost/eventsub/list", {
			headers: adminHeaders,
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual(expect.objectContaining({ code: "TwitchParseError" }));
	});

	it("URL-encodes subscription IDs when deleting", async () => {
		mockAppToken();
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: "/helix/eventsub/subscriptions?id=id%2Fwith+space", method: "DELETE" })
			.reply(204);
		const response = await exports.default.fetch("http://localhost/eventsub/id%2Fwith%20space", {
			method: "DELETE",
			headers: adminHeaders,
		});
		expect(response.status).toBe(200);
	});

	it("reports partial cleanup outcomes without claiming success", async () => {
		mockAppToken();
		mockEventSubPage([
			eventSubSubscription("delete-me", "stream.online"),
			eventSubSubscription("keep-on-failure", "stream.offline"),
		]);
		mockAppToken();
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: "/helix/eventsub/subscriptions?id=delete-me", method: "DELETE" })
			.reply(204);
		mockAppToken();
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({
				path: "/helix/eventsub/subscriptions?id=keep-on-failure",
				method: "DELETE",
			})
			.reply(500, "provider unavailable");

		const response = await exports.default.fetch("http://localhost/eventsub/cleanup", {
			method: "POST",
			headers: adminHeaders,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(
			expect.objectContaining({ success: false, deleted: 1, failed: 1 }),
		);
	});
});
