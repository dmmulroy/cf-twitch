import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

/**
 * Integration tests for HTTP routes.
 *
 * LIMITATION: Routes that call getStub() in nested code paths (via services)
 * cannot be tested with SELF.fetch. The vi.mock in setup.ts mocks getStub to
 * use cloudflare:test env, but this only applies to direct imports - not to
 * code loaded dynamically via SELF.fetch. Use DO unit tests for coverage.
 */
describe("Integration Tests", () => {
	describe("Overlay Endpoint", () => {
		it("should render now-playing overlay HTML", async () => {
			const response = await SELF.fetch("http://localhost/overlay/now-playing");

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");

			const html = await response.text();
			// HTML may be formatted differently - check for essential content
			expect(html.toLowerCase()).toContain("<!doctype html>");
			expect(html).toContain("/api/now-playing");
		});
	});

	// NOTE: These routes call getStub() in nested service calls (e.g., SongQueueDO → SpotifyService → getStub).
	// The vi.mock in setup.ts only applies to direct imports, not to code loaded via SELF.fetch.
	// Use DO unit tests in __tests__/durable-objects/ for coverage of these code paths.
	describe.skip("API Routes - Initial State", () => {
		it("should return empty queue initially", async () => {
			const response = await SELF.fetch("http://localhost/api/queue");

			expect(response.status).toBe(200);
			const data = (await response.json()) as { queue: unknown[] };
			expect(data).toHaveProperty("queue");
			expect(Array.isArray(data.queue)).toBe(true);
		});

		it("should return no currently playing track initially", async () => {
			const response = await SELF.fetch("http://localhost/api/now-playing");

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toHaveProperty("currentlyPlaying");
			// Initial state: either null or empty result
		});

		it("should accept limit param for queue", async () => {
			const response = await SELF.fetch("http://localhost/api/queue?limit=5");

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toHaveProperty("queue");
		});

		it("should reject limit above 100", async () => {
			const response = await SELF.fetch("http://localhost/api/queue?limit=101");

			expect(response.status).toBe(400);
		});
	});

	describe("OAuth Routes", () => {
		it("should have Spotify OAuth callback route", async () => {
			const response = await SELF.fetch("http://localhost/oauth/spotify/callback");

			// Should return some response (not 404)
			expect(response.status).not.toBe(404);
			await response.text(); // Consume body per vitest-pool-workers requirements
		});

		it("should have Twitch OAuth callback route", async () => {
			const response = await SELF.fetch("http://localhost/oauth/twitch/callback");

			// Should return some response (not 404)
			expect(response.status).not.toBe(404);
			await response.text(); // Consume body per vitest-pool-workers requirements
		});
	});

	// NOTE: Webhook routes use getStub() internally
	describe.skip("Webhook Routes", () => {
		it("should accept Twitch webhook events", async () => {
			const response = await SELF.fetch("http://localhost/webhooks/twitch", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					subscription: {
						type: "channel.channel_points_custom_reward_redemption.add",
					},
					event: {
						id: "test-event-id",
						user_id: "12345",
						user_login: "testuser",
						user_name: "TestUser",
						user_input: "spotify:track:test",
						reward: {
							id: "test-reward-id",
							title: "Test Reward",
						},
					},
				}),
			});

			// Webhook handler should process the request
			expect(response.status).toBe(200);
		});
	});
});
