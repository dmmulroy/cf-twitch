import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { STREAM_INFO, mockTwitchGetStreams, mockTwitchTokenRefresh } from "../fixtures/twitch";
import {
	ensureAchievementsSingletonStub,
	ensureNamedSpotifyTokenStub,
	ensureNamedTwitchTokenStub,
} from "../helpers/durable-objects";
import { fetchMock } from "../helpers/fetch-mock";

describe("Stream Lifecycle reconciliation", () => {
	it("replays same-state transition effects and preserves Twitch authoritative start time", async () => {
		await ensureNamedSpotifyTokenStub();
		await ensureNamedTwitchTokenStub();
		await ensureAchievementsSingletonStub();
		const streamStub = env.STREAM_LIFECYCLE_DO.get(
			env.STREAM_LIFECYCLE_DO.idFromName("stream-lifecycle"),
		);
		await streamStub.setName("stream-lifecycle");
		const online = await streamStub.onStreamOnline(STREAM_INFO.started_at);
		expect(online.status).toBe("ok");

		mockTwitchTokenRefresh(fetchMock);
		mockTwitchGetStreams(fetchMock, true);
		const response = await exports.default.fetch(
			"http://localhost/api/debug/reconcile-stream-state",
			{
				method: "POST",
				headers: { authorization: `Bearer ${env.ADMIN_SECRET}` },
			},
		);

		expect(response.status).toBe(200);
		const body = await response.json<{
			action: string;
			after: { startedAt: string | null };
		}>();
		expect(body.action).toBe("noop");
		expect(body.after.startedAt).toBe(new Date(STREAM_INFO.started_at).toISOString());
	});
});
