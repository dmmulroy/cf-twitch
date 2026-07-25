import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

describe("Achievement HTTP routes", () => {
	it("returns parsed Achievement Definitions", async () => {
		const response = await exports.default.fetch("http://example.com/api/achievements/definitions");
		expect(response.status).toBe(200);
		const body = await response.json<Array<{ id: string; category: string }>>();
		expect(body).toContainEqual(
			expect.objectContaining({ id: "first_request", category: "song_request" }),
		);
	});

	it("returns bounded leaderboards and rejects invalid public limits", async () => {
		const valid = await exports.default.fetch(
			"http://example.com/api/achievements/leaderboard?limit=1",
		);
		expect(valid.status).toBe(200);
		expect((await valid.json<Array<unknown>>()).length).toBeLessThanOrEqual(1);

		for (const limit of ["-1", "0", "1.5", "101", "not-a-number"]) {
			const response = await exports.default.fetch(
				`http://example.com/api/achievements/leaderboard?limit=${limit}`,
			);
			expect(response.status).toBe(400);
		}
	});

	it("returns Viewer Achievement Progress and unlocked Achievements", async () => {
		const progress = await exports.default.fetch(
			"http://example.com/api/achievements/UnknownViewer",
		);
		expect(progress.status).toBe(200);
		expect((await progress.json<Array<unknown>>()).length).toBeGreaterThan(0);

		const unlocked = await exports.default.fetch(
			"http://example.com/api/achievements/UnknownViewer/unlocked",
		);
		expect(unlocked.status).toBe(200);
		expect(await unlocked.json()).toEqual([]);
	});
});
