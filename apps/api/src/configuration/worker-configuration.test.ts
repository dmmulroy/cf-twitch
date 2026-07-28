import { describe, expect, it } from "vite-plus/test";

import { parseWorkerConfiguration } from "./worker-configuration";

const validBindings = {
	TWITCH_CLIENT_ID: "twitch-client",
	TWITCH_CLIENT_SECRET: "twitch-secret",
	TWITCH_BROADCASTER_ID: "viewer-1",
	TWITCH_BROADCASTER_NAME: "Streamer",
	TWITCH_EVENTSUB_SECRET: "eventsub-secret",
	SPOTIFY_CLIENT_ID: "spotify-client",
	SPOTIFY_CLIENT_SECRET: "spotify-secret",
	OAUTH_SETUP_SECRET: "oauth-secret",
	ADMIN_SECRET: "admin-secret",
	SONG_REQUEST_REWARD_ID: "song-reward",
	KEYBOARD_RAFFLE_REWARD_ID: "raffle-reward",
};

describe("Worker configuration", () => {
	it("parses provider, broadcaster, reward, and redacted secret configuration", () => {
		const result = parseWorkerConfiguration(validBindings);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value.twitch.broadcaster).toEqual({ id: "viewer-1", displayName: "Streamer" });
			expect(result.value.rewardRouting).toEqual({
				songRequestRewardId: "song-reward",
				keyboardRaffleRewardId: "raffle-reward",
			});
			expect(String(result.value.administratorSecret)).not.toContain("admin-secret");
		}
	});

	it("returns a typed error without exposing a missing secret value", () => {
		const result = parseWorkerConfiguration({ ...validBindings, ADMIN_SECRET: "" });

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error._tag).toBe("WorkerConfigurationError");
			expect(result.error.message).toBe("Worker configuration parsing failed");
		}
	});
});
