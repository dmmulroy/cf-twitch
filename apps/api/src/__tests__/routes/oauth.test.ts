import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { fetchMock } from "../helpers/fetch-mock";

async function startOAuthAuthorization(provider: "spotify" | "twitch"): Promise<URL> {
	const response = await exports.default.fetch(`http://localhost/oauth/${provider}/authorize`, {
		redirect: "manual",
		headers: { "x-setup-secret": env.OAUTH_SETUP_SECRET },
	});
	expect(response.status).toBe(302);
	const location = response.headers.get("location");
	expect(location).not.toBeNull();
	if (location === null) throw new Error("OAuth authorization redirect was missing");
	return new URL(location);
}

describe("OAuth routes", () => {
	it("accepts the setup secret only from a header", async () => {
		const queryResponse = await exports.default.fetch(
			`http://localhost/oauth/spotify/authorize?setup_secret=${env.OAUTH_SETUP_SECRET}`,
			{ redirect: "manual" },
		);
		expect(queryResponse.status).toBe(401);

		const headerResponse = await exports.default.fetch("http://localhost/oauth/spotify/authorize", {
			redirect: "manual",
			headers: { "x-setup-secret": env.OAUTH_SETUP_SECRET },
		});
		expect(headerResponse.status).toBe(302);
	});

	it("requests Twitch scopes and includes a correlated state value", async () => {
		const authorizeUrl = await startOAuthAuthorization("twitch");
		const scopes = authorizeUrl.searchParams.get("scope")?.split(" ") ?? [];
		expect(scopes).toContain("moderator:manage:shoutouts");
		expect(authorizeUrl.searchParams.get("state")).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("rejects callbacks with missing or wrong-provider state before exchanging a code", async () => {
		const missingResponse = await exports.default.fetch(
			"http://localhost/oauth/twitch/callback?code=uncorrelated",
		);
		expect(missingResponse.status).toBe(400);
		expect(await missingResponse.json()).toEqual(
			expect.objectContaining({ error: "Invalid or expired OAuth state", code: "invalid" }),
		);

		const spotifyAuthorizeUrl = await startOAuthAuthorization("spotify");
		const spotifyState = spotifyAuthorizeUrl.searchParams.get("state");
		expect(spotifyState).not.toBeNull();
		if (spotifyState === null) return;
		const wrongProviderResponse = await exports.default.fetch(
			`http://localhost/oauth/twitch/callback?code=wrong-provider&state=${spotifyState}`,
		);
		expect(wrongProviderResponse.status).toBe(400);
		expect(await wrongProviderResponse.json()).toEqual(
			expect.objectContaining({ code: "mismatch" }),
		);
	});

	it("exchanges and persists Spotify tokens, then rejects state replay", async () => {
		const authorizeUrl = await startOAuthAuthorization("spotify");
		const state = authorizeUrl.searchParams.get("state");
		expect(state).not.toBeNull();
		if (state === null) return;

		fetchMock
			.get("https://accounts.spotify.com")
			.intercept({ path: "/api/token", method: "POST" })
			.reply(
				200,
				JSON.stringify({
					access_token: "spotify-callback-access-token",
					refresh_token: "spotify-callback-refresh-token",
					token_type: "Bearer",
					expires_in: 3600,
					scope: "user-read-playback-state",
				}),
				{ headers: { "content-type": "application/json" } },
			);

		const callbackUrl = `http://localhost/oauth/spotify/callback?code=spotify-code&state=${state}`;
		const response = await exports.default.fetch(callbackUrl);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(expect.objectContaining({ success: true }));

		const tokenStub = env.SPOTIFY_TOKEN_DO.getByName("spotify-token");
		const tokenResult = await tokenStub.getValidToken();
		expect(tokenResult).toEqual(
			expect.objectContaining({ status: "ok", value: "spotify-callback-access-token" }),
		);

		const replayResponse = await exports.default.fetch(callbackUrl);
		expect(replayResponse.status).toBe(400);
		expect(await replayResponse.json()).toEqual(expect.objectContaining({ code: "consumed" }));
	});

	it("exchanges and persists Twitch tokens", async () => {
		const authorizeUrl = await startOAuthAuthorization("twitch");
		const state = authorizeUrl.searchParams.get("state");
		expect(state).not.toBeNull();
		if (state === null) return;

		fetchMock
			.get("https://id.twitch.tv")
			.intercept({ path: "/oauth2/token", method: "POST" })
			.reply(
				200,
				JSON.stringify({
					access_token: "twitch-callback-access-token",
					refresh_token: "twitch-callback-refresh-token",
					token_type: "bearer",
					expires_in: 14_400,
					scope: ["user:write:chat"],
				}),
				{ headers: { "content-type": "application/json" } },
			);

		const response = await exports.default.fetch(
			`http://localhost/oauth/twitch/callback?code=twitch-code&state=${state}`,
		);
		expect(response.status).toBe(200);
		const tokenResult = await env.TWITCH_TOKEN_DO.getByName("twitch-token").getValidToken();
		expect(tokenResult).toEqual(
			expect.objectContaining({ status: "ok", value: "twitch-callback-access-token" }),
		);
	});

	it("rejects malformed successful provider token responses before persistence", async () => {
		const authorizeUrl = await startOAuthAuthorization("spotify");
		const state = authorizeUrl.searchParams.get("state");
		expect(state).not.toBeNull();
		if (state === null) return;

		fetchMock
			.get("https://accounts.spotify.com")
			.intercept({ path: "/api/token", method: "POST" })
			.reply(200, JSON.stringify({ access_token: "", expires_in: 0 }), {
				headers: { "content-type": "application/json" },
			});

		const response = await exports.default.fetch(
			`http://localhost/oauth/spotify/callback?code=bad-response&state=${state}`,
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual(expect.objectContaining({ code: "SpotifyParseError" }));
	});
});
