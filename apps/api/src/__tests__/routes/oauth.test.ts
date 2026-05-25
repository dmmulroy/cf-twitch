import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("OAuth routes", () => {
	it("requests Twitch shoutout management scope during authorization", async () => {
		const response = await SELF.fetch("http://localhost/oauth/twitch/authorize", {
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
