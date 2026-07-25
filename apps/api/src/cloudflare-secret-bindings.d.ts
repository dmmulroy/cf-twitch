/** Secret bindings configured outside wrangler.jsonc and merged into generated Worker bindings. */
declare namespace Cloudflare {
	interface Env {
		TWITCH_CLIENT_ID: string;
		TWITCH_CLIENT_SECRET: string;
		TWITCH_ACCESS_TOKEN: string;
		TWITCH_REFRESH_TOKEN: string;
		TWITCH_EVENTSUB_SECRET: string;
		TWITCH_BROADCASTER_ID: string;
		SPOTIFY_CLIENT_ID: string;
		SPOTIFY_CLIENT_SECRET: string;
		OAUTH_SETUP_SECRET: string;
		ADMIN_SECRET: string;
	}
}
