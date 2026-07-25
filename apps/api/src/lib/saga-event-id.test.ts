import { describe, expect, it } from "vite-plus/test";

import { deriveSagaEventId } from "./saga-event-id";

describe("deriveSagaEventId", () => {
	it("returns one stable UUID identity for every replay of a saga", async () => {
		const first = await deriveSagaEventId("song-request-redemption-123");
		const replay = await deriveSagaEventId("song-request-redemption-123");
		const other = await deriveSagaEventId("song-request-redemption-456");

		expect(first).toBe(replay);
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(other).not.toBe(first);
	});
});
