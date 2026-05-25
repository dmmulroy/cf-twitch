import { env, fetchMock, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const EventSubSetupResponseSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	subscriptions: z.array(
		z.object({
			type: z.string(),
			condition: z.record(z.string(), z.unknown()),
		}),
	),
	skipped: z.array(
		z.object({
			type: z.string(),
			condition: z.record(z.string(), z.unknown()),
		}),
	),
});

function mockAppToken(): void {
	fetchMock
		.get("https://id.twitch.tv")
		.intercept({ path: "/oauth2/token", method: "POST" })
		.reply(200, JSON.stringify({ access_token: "test-app-token" }), {
			headers: { "content-type": "application/json" },
		});
}

function mockExistingRaidSubscription(callbackUrl: string): void {
	fetchMock
		.get("https://api.twitch.tv")
		.intercept({ path: "/helix/eventsub/subscriptions" })
		.reply(
			200,
			JSON.stringify({
				data: [
					{
						id: "existing-raid-subscription",
						status: "enabled",
						type: "channel.raid",
						version: "1",
						cost: 0,
						condition: { to_broadcaster_user_id: env.TWITCH_BROADCASTER_ID },
						transport: { method: "webhook", callback: callbackUrl },
						created_at: "2026-05-25T00:00:00Z",
					},
				],
				total: 1,
				total_cost: 0,
				max_total_cost: 10,
			}),
			{ headers: { "content-type": "application/json" } },
		);
}

function mockCreateSubscription(id: string, type: string): void {
	fetchMock
		.get("https://api.twitch.tv")
		.intercept({ path: "/helix/eventsub/subscriptions", method: "POST" })
		.reply(
			202,
			JSON.stringify({
				data: [
					{
						id,
						status: "webhook_callback_verification_pending",
						type,
						version: "1",
						cost: 0,
						condition: { broadcaster_user_id: env.TWITCH_BROADCASTER_ID },
						transport: { method: "webhook", callback: "http://localhost/webhooks/twitch" },
						created_at: "2026-05-25T00:00:00Z",
					},
				],
				total: 1,
				total_cost: 0,
				max_total_cost: 10,
			}),
			{ headers: { "content-type": "application/json" } },
		);
}

describe("EventSub setup routes", () => {
	it("skips an enabled matching channel.raid subscription when setup is rerun", async () => {
		const callbackUrl = "http://localhost/webhooks/twitch";
		mockAppToken();
		mockAppToken();
		mockAppToken();
		mockAppToken();
		mockAppToken();
		mockExistingRaidSubscription(callbackUrl);
		mockCreateSubscription("stream-online", "stream.online");
		mockCreateSubscription("stream-offline", "stream.offline");
		mockCreateSubscription("redemptions", "channel.channel_points_custom_reward_redemption.add");
		mockCreateSubscription("chat-message", "channel.chat.message");

		const response = await SELF.fetch("http://localhost/eventsub/setup", { method: "POST" });

		expect(response.status).toBe(200);
		const json = await response.json();
		const body = EventSubSetupResponseSchema.parse(json);
		expect(body.success).toBe(true);
		expect(body.subscriptions.map((subscription) => subscription.type)).not.toContain(
			"channel.raid",
		);
		expect(body.skipped).toEqual([
			expect.objectContaining({
				type: "channel.raid",
				condition: { to_broadcaster_user_id: env.TWITCH_BROADCASTER_ID },
			}),
		]);
	});
});
