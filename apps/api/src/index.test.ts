import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { fetchMock } from "./__tests__/helpers/fetch-mock";

const adminAuthorization = { Authorization: `Bearer ${env.ADMIN_SECRET}` };

describe("Worker HTTP entrypoint", () => {
	it("returns health and server-owned correlation headers", async () => {
		const response = await exports.default.fetch("http://localhost/health", {
			headers: {
				"x-request-id": "caller-request-id",
				"x-trace-id": "caller-trace-id",
				"user-agent": "private-test-agent",
				"cf-connecting-ip": "192.0.2.1",
			},
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
		expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
		expect(response.headers.get("x-trace-id")).toMatch(/^[0-9a-f-]{36}$/u);
		expect(response.headers.get("x-request-id")).not.toBe("caller-request-id");
		expect(response.headers.get("x-trace-id")).not.toBe("caller-trace-id");
	});

	it("renders bounded, independently validated overlay polling", async () => {
		const response = await exports.default.fetch("http://localhost/overlay/now-playing");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");

		const body = await response.text();
		expect(body.toLowerCase()).toContain("<!doctype html>");
		expect(body).toContain("const REQUEST_TIMEOUT_MS = 4000");
		expect(body).toContain("if (pollInFlight) return");
		expect(body).toContain("parseNowPlayingResponse");
		expect(body).toContain("parseQueueResponse");
		expect(body).toContain('return { status: "error" }');
	});

	describe("public API query parsing", () => {
		it("returns the initial now-playing and queue contracts", async () => {
			const [nowPlayingResponse, queueResponse] = await Promise.all([
				exports.default.fetch("http://localhost/api/now-playing"),
				exports.default.fetch("http://localhost/api/queue?limit=5"),
			]);

			expect(nowPlayingResponse.status).toBe(200);
			expect(await nowPlayingResponse.json()).toEqual({ track: null, position: 0 });
			expect(queueResponse.status).toBe(200);
			expect(await queueResponse.json()).toEqual({ tracks: [], totalCount: 0 });
		});

		it.each([
			"/api/queue?limit=101",
			"/api/queue?limit=1.5",
			"/api/queue?limit=1&limit=2",
			"/api/queue?unknown=true",
			"/api/song-requests/history?limit=NaN",
			"/api/achievements/leaderboard?limit=-1",
		])("rejects invalid query input for %s", async (path) => {
			const response = await exports.default.fetch(`http://localhost${path}`);
			expect(response.status).toBe(400);
			await response.text();
		});
	});

	describe("achievement HTTP contracts", () => {
		it("returns definitions, leaderboard, Viewer progress, and unlocked Achievements", async () => {
			const [definitions, leaderboard, progress, unlocked] = await Promise.all([
				exports.default.fetch("http://localhost/api/achievements/definitions"),
				exports.default.fetch("http://localhost/api/achievements/leaderboard?limit=10"),
				exports.default.fetch("http://localhost/api/achievements/TestViewer"),
				exports.default.fetch("http://localhost/api/achievements/TestViewer/unlocked"),
			]);
			expect(definitions.status).toBe(200);
			expect(Array.isArray(await definitions.json())).toBe(true);
			expect(leaderboard.status).toBe(200);
			expect(await leaderboard.json()).toEqual([]);
			expect(progress.status).toBe(200);
			expect(Array.isArray(await progress.json())).toBe(true);
			expect(unlocked.status).toBe(200);
			expect(await unlocked.json()).toEqual([]);
		});
	});

	describe("debug validation", () => {
		it.each([
			"/api/debug/keyboard-raffle/leaderboard?sortBy=unknown",
			"/api/debug/keyboard-raffle/leaderboard?limit=0",
			"/api/debug/keyboard-raffle/leaderboard?limit=1000",
		])("rejects invalid raffle leaderboard input for %s", async (path) => {
			const response = await exports.default.fetch(`http://localhost${path}`, {
				headers: adminAuthorization,
			});
			expect(response.status).toBe(400);
			await response.text();
		});

		it("rejects missing and malformed debug credentials", async () => {
			const missing = await exports.default.fetch("http://localhost/api/debug/stream-state");
			const malformed = await exports.default.fetch("http://localhost/api/debug/stream-state", {
				headers: { Authorization: "test-admin-secret" },
			});
			expect(missing.status).toBe(401);
			expect(malformed.status).toBe(401);
			await Promise.all([missing.text(), malformed.text()]);
		});
	});

	it("preserves Twitch's authoritative Stream Session start during reconciliation", async () => {
		const twitchStartedAt = "2026-07-25T12:00:00.000Z";
		fetchMock
			.get("https://id.twitch.tv")
			.intercept({ path: "/oauth2/token", method: "POST" })
			.reply(
				200,
				JSON.stringify({ access_token: "app-token", token_type: "bearer", expires_in: 3600 }),
			);
		fetchMock
			.get("https://api.twitch.tv")
			.intercept({ path: "/helix/streams?user_login=dillon" })
			.reply(
				200,
				JSON.stringify({
					data: [
						{
							id: "stream-id",
							user_id: "12345",
							user_login: "dillon",
							user_name: "Dillon",
							game_id: "game-id",
							game_name: "Software and Game Development",
							type: "live",
							title: "Building on Cloudflare",
							viewer_count: 42,
							started_at: twitchStartedAt,
							language: "en",
							thumbnail_url: "https://example.com/thumbnail.jpg",
							is_mature: false,
						},
					],
				}),
			);

		const response = await exports.default.fetch(
			"http://localhost/api/debug/reconcile-stream-state",
			{ method: "POST", headers: adminAuthorization },
		);
		const body = (await response.json()) as {
			action: string;
			after: { startedAt: string | null };
		};
		expect(response.status).toBe(200);
		expect(body.action).toBe("set_online");
		expect(body.after.startedAt).toBe(twitchStartedAt);
	});

	describe("stats routes and edge cache", () => {
		it.each([
			["/api/stats/top-tracks", []],
			["/api/stats/top-requesters", []],
			["/api/stats/raffle/leaderboard", []],
		] as const)("returns the initial contract for %s", async (path, expectedBody) => {
			const response = await exports.default.fetch(`http://localhost${path}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("public, max-age=60");
			expect(await response.json()).toEqual(expectedBody);
		});

		it("evicts a malformed cached stats payload and refetches validated data", async () => {
			const cacheKey = new Request("https://stats.internal/api/stats/top-requesters?limit=7");
			await caches.default.put(cacheKey, Response.json({ malformed: true }));

			const response = await exports.default.fetch(
				"http://localhost/api/stats/top-requesters?limit=7",
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual([]);
		});

		it("canonicalizes an omitted stats limit to the explicit default cache entry", async () => {
			const omitted = await exports.default.fetch("http://localhost/api/stats/top-tracks");
			const explicit = await exports.default.fetch(
				"http://localhost/api/stats/top-tracks?limit=10",
			);
			expect(omitted.status).toBe(200);
			expect(explicit.status).toBe(200);
			expect(await omitted.json()).toEqual(await explicit.json());
		});

		it.each([
			"/api/stats/top-tracks?nonce=1",
			"/api/stats/top-requesters?limit=101",
			"/api/stats/top-tracks/not-a-viewer",
			"/api/stats/raffle/user/not-a-viewer",
			"/api/stats/raffle/user/123?nonce=1",
		])("rejects non-canonical stats input for %s", async (path) => {
			const response = await exports.default.fetch(`http://localhost${path}`);
			expect(response.status).toBe(400);
			await response.text();
		});

		it("returns not found for a valid Viewer ID without raffle stats", async () => {
			const response = await exports.default.fetch("http://localhost/api/stats/raffle/user/999999");
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "User not found" });
		});
	});

	it("registers Spotify and Twitch OAuth callback routes", async () => {
		const [spotify, twitch] = await Promise.all([
			exports.default.fetch("http://localhost/oauth/spotify/callback"),
			exports.default.fetch("http://localhost/oauth/twitch/callback"),
		]);
		expect(spotify.status).not.toBe(404);
		expect(twitch.status).not.toBe(404);
		await Promise.all([spotify.text(), twitch.text()]);
	});
});
