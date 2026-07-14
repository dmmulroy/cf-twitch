import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

describe("OAuth routes", () => {
	it("requests Twitch shoutout management scope during authorization", async () => {
		const response = await exports.default.fetch("http://localhost/oauth/twitch/authorize", {
			redirect: "manual",
			headers: { "x-setup-secret": env.OAUTH_SETUP_SECRET },
		});

		expect(response.status).toBe(302);
		const location = response.headers.get("location");
		expect(location).not.toBeNull();
		if (location === null) return;

		const authorizeUrl = new URL(location);
		const scopes = authorizeUrl.searchParams.get("scope")?.split(" ") ?? [];
		expect(scopes).toContain("moderator:manage:shoutouts");
	});
});
