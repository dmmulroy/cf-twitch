/**
 * OAuth routes for initial token setup
 *
 * Handles authorization redirects and callbacks for Spotify and Twitch.
 * Protected by OAUTH_SETUP_SECRET, which must be provided only via the setup header.
 */

import { Hono } from "hono";

import { constantTimeEquals } from "../../lib/crypto";
import { RedactedValue } from "../../lib/redacted";
import { type AppRouteEnv, getRequestLogger } from "../../lib/request-context";

import type { OAuthAuthorizationStateStore } from "../../capabilities/oauth-authorization-state";
import type { ProviderAccessTokenError } from "../../capabilities/provider-access-tokens";
import type { RedactedValue as RedactedString } from "../../lib/redacted";
import type { SpotifyService, SpotifyTokenResponse } from "../../services/spotify-service";
import type { TwitchService, TwitchTokenResponse } from "../../services/twitch-service";
import type { Result } from "better-result";

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
	"moderator:manage:shoutouts",
].join(" ");

/** Exact dependencies required by Spotify and Twitch OAuth setup routes. */
export type OAuthRouteDependencies = Readonly<{
	oauthSetupSecret: RedactedString<string>;
	spotifyClientId: string;
	twitchClientId: string;
	authorizationStates: OAuthAuthorizationStateStore;
	spotifyOAuth: Pick<SpotifyService, "exchangeToken">;
	twitchOAuth: Pick<TwitchService, "exchangeToken">;
	spotifyTokens: {
		setTokens(tokens: SpotifyTokenResponse): Promise<Result<void, ProviderAccessTokenError>>;
	};
	twitchTokens: {
		setTokens(tokens: TwitchTokenResponse): Promise<Result<void, ProviderAccessTokenError>>;
	};
}>;

/** Creates OAuth setup routes without Worker binding lookup. */
export function createOAuthRoutes(dependencies: OAuthRouteDependencies): Hono<AppRouteEnv<object>> {
	const oauth = new Hono<AppRouteEnv<object>>();

	/**
	 * Middleware to verify the header-only setup secret on authorize endpoints.
	 */
	oauth.use("/*/authorize", async (c, next) => {
		const routeLogger = getRequestLogger(c).child({ route: c.req.path, component: "route" });
		const secret = c.req.header("x-setup-secret");

		const oauthSetupSecret = dependencies.oauthSetupSecret.unsafeUnwrapForFinalIo();
		if (!oauthSetupSecret) {
			routeLogger.error("OAuth setup secret misconfigured", {
				event: "oauth.setup_secret.misconfigured",
				path: c.req.path,
				has_secret: false,
			});
			return c.json({ error: "OAuth setup not configured" }, 500);
		}

		if (!secret || !constantTimeEquals(secret, oauthSetupSecret)) {
			routeLogger.warn("OAuth setup secret denied", {
				event: "oauth.setup_secret.denied",
				has_secret: Boolean(secret),
				path: c.req.path,
			});
			return c.json({ error: "Unauthorized" }, 401);
		}

		routeLogger.info("OAuth setup secret authorized", {
			event: "oauth.setup_secret.authorized",
			has_secret: true,
			path: c.req.path,
		});
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
	oauth.get("/spotify/authorize", async (c) => {
		const routeLogger = getRequestLogger(c).child({
			route: "/oauth/spotify/authorize",
			component: "route",
		});
		const origin = getOrigin(c);
		const redirectUri = `${origin}/oauth/spotify/callback`;
		const stateResult = await dependencies.authorizationStates.create("spotify", redirectUri);
		if (stateResult.status === "error") {
			return c.json({ error: "Unable to start Spotify authorization" }, 503);
		}

		const authUrl = new URL(SPOTIFY_AUTH_URL);
		authUrl.searchParams.set("client_id", dependencies.spotifyClientId);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("redirect_uri", redirectUri);
		authUrl.searchParams.set("scope", SPOTIFY_SCOPES);
		authUrl.searchParams.set("state", stateResult.value);

		routeLogger.info("Redirecting to Spotify authorization", {
			event: "oauth.spotify.authorize.redirecting",
			redirect_uri: redirectUri,
			scopes_count: SPOTIFY_SCOPES.split(" ").length,
		});

		return c.redirect(authUrl.toString(), 302);
	});

	/**
	 * GET /oauth/spotify/callback
	 * Handles Spotify OAuth callback, exchanges code for tokens
	 */
	oauth.get("/spotify/callback", async (c) => {
		const routeLogger = getRequestLogger(c).child({
			route: "/oauth/spotify/callback",
			component: "route",
		});
		const code = c.req.query("code");
		const error = c.req.query("error");
		const state = c.req.query("state");
		const origin = getOrigin(c);
		const redirectUri = `${origin}/oauth/spotify/callback`;
		if (state === undefined)
			return c.json({ error: "Invalid or expired OAuth state", code: "invalid" }, 400);
		const stateResult = await dependencies.authorizationStates.consume(
			"spotify",
			redirectUri,
			state,
		);
		if (stateResult.status === "error") {
			return c.json({ error: "OAuth state validation unavailable" }, 503);
		}
		if (stateResult.value !== "ok") {
			return c.json({ error: "Invalid or expired OAuth state", code: stateResult.value }, 400);
		}

		routeLogger.info("Spotify callback received", {
			event: "oauth.spotify.callback.received",
			code_present: Boolean(code),
			error_present: Boolean(error),
			redirect_uri: redirectUri,
		});

		if (error) {
			routeLogger.warn("Spotify authorization error", {
				event: "oauth.spotify.callback.authorization_error",
				oauth_error: error,
				code_present: Boolean(code),
				error_present: true,
				redirect_uri: redirectUri,
			});
			return c.json({ error: "Authorization failed", details: error }, 400);
		}

		if (!code) {
			routeLogger.warn("Spotify callback missing code", {
				event: "oauth.spotify.callback.missing_code",
				code_present: false,
				error_present: false,
				redirect_uri: redirectUri,
			});
			return c.json({ error: "No authorization code received" }, 400);
		}

		routeLogger.info("Spotify token exchange started", {
			event: "oauth.spotify.callback.exchange_started",
			code_present: true,
			redirect_uri: redirectUri,
		});

		const tokensResult = await dependencies.spotifyOAuth.exchangeToken(
			RedactedValue.fromSensitiveValue(code),
			redirectUri,
		);

		if (tokensResult.status === "error") {
			routeLogger.error("Spotify token exchange failed", {
				event: "oauth.spotify.callback.exchange_failed",
				redirect_uri: redirectUri,
				...tokensResult.error,
			});
			return c.json({ error: tokensResult.error.message, code: tokensResult.error._tag }, 500);
		}

		const tokens = tokensResult.value;
		const persistenceResult = await dependencies.spotifyTokens.setTokens(tokens);
		if (persistenceResult.status === "error") {
			routeLogger.error("Spotify token persistence failed", {
				event: "oauth.spotify.callback.persistence_failed",
				error_tag: persistenceResult.error._tag,
			});
			return c.json(
				{ error: "Spotify tokens could not be stored", code: persistenceResult.error._tag },
				503,
			);
		}

		routeLogger.info("Spotify tokens stored", {
			event: "oauth.spotify.callback.tokens_stored",
			scope_count: tokens.scope?.split(" ").filter(Boolean).length ?? 0,
			expires_in: tokens.expires_in,
		});
		routeLogger.info("Spotify OAuth callback completed", {
			event: "oauth.spotify.callback.completed",
			scope_count: tokens.scope?.split(" ").filter(Boolean).length ?? 0,
			expires_in: tokens.expires_in,
		});

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
	oauth.get("/twitch/authorize", async (c) => {
		const routeLogger = getRequestLogger(c).child({
			route: "/oauth/twitch/authorize",
			component: "route",
		});
		const origin = getOrigin(c);
		const redirectUri = `${origin}/oauth/twitch/callback`;
		const stateResult = await dependencies.authorizationStates.create("twitch", redirectUri);
		if (stateResult.status === "error") {
			return c.json({ error: "Unable to start Twitch authorization" }, 503);
		}

		const authUrl = new URL(TWITCH_AUTH_URL);
		authUrl.searchParams.set("client_id", dependencies.twitchClientId);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("redirect_uri", redirectUri);
		authUrl.searchParams.set("scope", TWITCH_SCOPES);
		authUrl.searchParams.set("state", stateResult.value);

		routeLogger.info("Redirecting to Twitch authorization", {
			event: "oauth.twitch.authorize.redirecting",
			redirect_uri: redirectUri,
			scopes_count: TWITCH_SCOPES.split(" ").length,
		});

		return c.redirect(authUrl.toString(), 302);
	});

	/**
	 * GET /oauth/twitch/callback
	 * Handles Twitch OAuth callback, exchanges code for tokens
	 */
	oauth.get("/twitch/callback", async (c) => {
		const routeLogger = getRequestLogger(c).child({
			route: "/oauth/twitch/callback",
			component: "route",
		});
		const code = c.req.query("code");
		const error = c.req.query("error");
		const errorDescription = c.req.query("error_description");
		const state = c.req.query("state");
		const origin = getOrigin(c);
		const redirectUri = `${origin}/oauth/twitch/callback`;
		if (state === undefined)
			return c.json({ error: "Invalid or expired OAuth state", code: "invalid" }, 400);
		const stateResult = await dependencies.authorizationStates.consume(
			"twitch",
			redirectUri,
			state,
		);
		if (stateResult.status === "error") {
			return c.json({ error: "OAuth state validation unavailable" }, 503);
		}
		if (stateResult.value !== "ok") {
			return c.json({ error: "Invalid or expired OAuth state", code: stateResult.value }, 400);
		}

		routeLogger.info("Twitch callback received", {
			event: "oauth.twitch.callback.received",
			code_present: Boolean(code),
			error_present: Boolean(error),
			redirect_uri: redirectUri,
		});

		if (error) {
			routeLogger.warn("Twitch authorization error", {
				event: "oauth.twitch.callback.authorization_error",
				oauth_error: error,
				oauth_error_description: errorDescription,
				code_present: Boolean(code),
				error_present: true,
				redirect_uri: redirectUri,
			});
			return c.json(
				{
					error: "Authorization failed",
					details: errorDescription ?? error,
				},
				400,
			);
		}

		if (!code) {
			routeLogger.warn("Twitch callback missing code", {
				event: "oauth.twitch.callback.missing_code",
				code_present: false,
				error_present: false,
				redirect_uri: redirectUri,
			});
			return c.json({ error: "No authorization code received" }, 400);
		}

		routeLogger.info("Twitch token exchange started", {
			event: "oauth.twitch.callback.exchange_started",
			code_present: true,
			redirect_uri: redirectUri,
		});

		const tokensResult = await dependencies.twitchOAuth.exchangeToken(
			RedactedValue.fromSensitiveValue(code),
			redirectUri,
		);

		if (tokensResult.status === "error") {
			routeLogger.error("Twitch token exchange failed", {
				event: "oauth.twitch.callback.exchange_failed",
				redirect_uri: redirectUri,
				...tokensResult.error,
			});
			return c.json({ error: tokensResult.error.message, code: tokensResult.error._tag }, 500);
		}

		const tokens = tokensResult.value;
		const persistenceResult = await dependencies.twitchTokens.setTokens(tokens);
		if (persistenceResult.status === "error") {
			routeLogger.error("Twitch token persistence failed", {
				event: "oauth.twitch.callback.persistence_failed",
				error_tag: persistenceResult.error._tag,
			});
			return c.json(
				{ error: "Twitch tokens could not be stored", code: persistenceResult.error._tag },
				503,
			);
		}

		routeLogger.info("Twitch tokens stored", {
			event: "oauth.twitch.callback.tokens_stored",
			scope_count: tokens.scope.length,
			expires_in: tokens.expires_in,
		});
		routeLogger.info("Twitch OAuth callback completed", {
			event: "oauth.twitch.callback.completed",
			scope_count: tokens.scope.length,
			expires_in: tokens.expires_in,
		});

		return c.json({
			success: true,
			message: "Twitch authorization complete",
			scopes: tokens.scope,
		});
	});

	return oauth;
}
