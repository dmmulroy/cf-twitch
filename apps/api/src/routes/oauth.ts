/**
 * OAuth routes for initial token setup
 *
 * Handles authorization redirects and callbacks for Spotify and Twitch.
 * Protected by OAUTH_SETUP_SECRET - must be provided via header or query param.
 */

import { Hono } from "hono";

import { getStub } from "../lib/durable-objects";
import { logger } from "../lib/logger";
import { SpotifyService } from "../services/spotify-service";
import { TwitchService } from "../services/twitch-service";

import type { Env } from "../index";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const TWITCH_AUTH_URL = "https://id.twitch.tv/oauth2/authorize";

/**
 * Spotify OAuth scopes required for the application
 */
const SPOTIFY_SCOPES = [
	"user-modify-playback-state",
	"user-read-playback-state",
	"user-read-currently-playing",
].join(" ");

/**
 * Twitch OAuth scopes required for the application
 */
const TWITCH_SCOPES = [
	"channel:read:redemptions",
	"channel:manage:redemptions",
	"user:read:chat",
	"user:write:chat",
].join(" ");

const oauth = new Hono<{ Bindings: Env }>();

/**
 * Middleware to verify setup secret on authorize endpoints.
 * Accepts secret via X-Setup-Secret header or setup_secret query param.
 */
oauth.use("/*/authorize", async (c, next) => {
	const secret = c.req.header("x-setup-secret") ?? c.req.query("setup_secret");

	if (!c.env.OAUTH_SETUP_SECRET) {
		logger.error("OAUTH_SETUP_SECRET not configured");
		return c.json({ error: "OAuth setup not configured" }, 500);
	}

	if (!secret || secret !== c.env.OAUTH_SETUP_SECRET) {
		logger.warn("Unauthorized OAuth setup attempt", {
			hasSecret: !!secret,
			path: c.req.path,
		});
		return c.json({ error: "Unauthorized" }, 401);
	}

	await next();
});

/**
 * Get origin respecting X-Forwarded-Proto from reverse proxies (cloudflared, etc.)
 */
function getOrigin(c: {
	req: { url: string; header: (name: string) => string | undefined };
}): string {
	const url = new URL(c.req.url);
	const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
	return `${proto}://${url.host}`;
}

/**
 * GET /oauth/spotify/authorize
 * Redirects to Spotify authorization page
 */
oauth.get("/spotify/authorize", (c) => {
	const origin = getOrigin(c);
	const redirectUri = `${origin}/oauth/spotify/callback`;

	const authUrl = new URL(SPOTIFY_AUTH_URL);
	authUrl.searchParams.set("client_id", c.env.SPOTIFY_CLIENT_ID);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("redirect_uri", redirectUri);
	authUrl.searchParams.set("scope", SPOTIFY_SCOPES);

	logger.info("Redirecting to Spotify authorization", { redirectUri });

	return c.redirect(authUrl.toString(), 302);
});

/**
 * GET /oauth/spotify/callback
 * Handles Spotify OAuth callback, exchanges code for tokens
 */
oauth.get("/spotify/callback", async (c) => {
	const code = c.req.query("code");
	const error = c.req.query("error");

	// Handle authorization errors
	if (error) {
		logger.error("Spotify authorization error", { error });
		return c.json({ error: "Authorization failed", details: error }, 400);
	}

	if (!code) {
		logger.error("No authorization code received");
		return c.json({ error: "No authorization code received" }, 400);
	}

	const origin = getOrigin(c);
	const redirectUri = `${origin}/oauth/spotify/callback`;

	logger.info("Spotify callback - exchanging token", {
		redirectUri,
		xForwardedProto: c.req.header("x-forwarded-proto"),
		host: c.req.header("host"),
	});

	// Create service instance
	// AI: I really like this pattern of services/classes taking the env as DI, lets add a static .fromEnv on all of our classes that do this rather than newing up an instance directly
	const spotifyService = new SpotifyService(c.env);
	const tokensResult = await spotifyService.exchangeToken(code, redirectUri);

	if (tokensResult.status === "error") {
		const err = tokensResult.error;
		logger.error("Spotify callback error", {
			error: err.message,
			code: err._tag,
		});
		return c.json({ error: err.message, code: err._tag }, 500);
	}

	const tokens = tokensResult.value;

	// Store tokens in SpotifyTokenDO via RPC
	const stub = getStub("SPOTIFY_TOKEN_DO");
	// AI: debug why this (setTokens) returns never, it should def return a promise as all stub methods do
	await stub.setTokens(tokens);

	logger.info("Spotify tokens stored successfully");

	return c.json({
		success: true,
		message: "Spotify authorization complete",
		scopes: tokens.scope,
	});
});

/**
 * GET /oauth/twitch/authorize
 * Redirects to Twitch authorization page
 */
oauth.get("/twitch/authorize", (c) => {
	const origin = getOrigin(c);
	const redirectUri = `${origin}/oauth/twitch/callback`;

	const authUrl = new URL(TWITCH_AUTH_URL);
	authUrl.searchParams.set("client_id", c.env.TWITCH_CLIENT_ID);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("redirect_uri", redirectUri);
	authUrl.searchParams.set("scope", TWITCH_SCOPES);

	logger.info("Redirecting to Twitch authorization", { redirectUri });

	return c.redirect(authUrl.toString(), 302);
});

/**
 * GET /oauth/twitch/callback
 * Handles Twitch OAuth callback, exchanges code for tokens
 */
oauth.get("/twitch/callback", async (c) => {
	const code = c.req.query("code");
	const error = c.req.query("error");
	const errorDescription = c.req.query("error_description");

	// Handle authorization errors
	if (error) {
		logger.error("Twitch authorization error", { error, errorDescription });
		return c.json(
			{
				error: "Authorization failed",
				details: errorDescription ?? error,
			},
			400,
		);
	}

	if (!code) {
		logger.error("No authorization code received");
		return c.json({ error: "No authorization code received" }, 400);
	}

	const origin = getOrigin(c);
	const redirectUri = `${origin}/oauth/twitch/callback`;

	// Create service instance
	const twitchService = new TwitchService(c.env);
	const tokensResult = await twitchService.exchangeToken(code, redirectUri);

	if (tokensResult.status === "error") {
		const err = tokensResult.error;
		logger.error("Twitch callback error", {
			error: err.message,
			code: err._tag,
		});
		return c.json({ error: err.message, code: err._tag }, 500);
	}

	const tokens = tokensResult.value;

	// Store tokens in TwitchTokenDO via RPC
	const stub = getStub("TWITCH_TOKEN_DO");
	await stub.setTokens(tokens);

	logger.info("Twitch tokens stored successfully");

	return c.json({
		success: true,
		message: "Twitch authorization complete",
		scopes: tokens.scope,
	});
});

export default oauth;
