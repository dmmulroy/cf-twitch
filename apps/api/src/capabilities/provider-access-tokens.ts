import { TaggedError } from "better-result";

import type { RedactedValue } from "../lib/redacted";
import type { Result } from "better-result";

/** Expected failure when a provider access token cannot be obtained from durable state. */
export class ProviderAccessTokenError extends TaggedError("ProviderAccessTokenError")<{
	readonly provider: "spotify" | "twitch";
	readonly operation: "getValidAccessToken" | "setTokens" | "onStreamOnline" | "onStreamOffline";
	readonly failureTag: string;
	readonly message: string;
	readonly cause?: unknown;
}>() {
	constructor(args: {
		provider: "spotify" | "twitch";
		failureTag: string;
		operation?: "getValidAccessToken" | "setTokens" | "onStreamOnline" | "onStreamOffline";
		cause?: unknown;
	}) {
		super({
			...args,
			operation: args.operation ?? "getValidAccessToken",
			message: `${args.provider === "spotify" ? "Spotify" : "Twitch"} access token unavailable`,
		});
	}
}

/** Receives Stream Lifecycle transitions that govern provider token availability. */
export interface ProviderTokenLifecycle {
	/** Marks provider token refresh as eligible for an active Stream Session. */
	onStreamOnline(): Promise<Result<void, ProviderAccessTokenError>>;
	/** Marks provider token refresh as unavailable after a Stream Session ends. */
	onStreamOffline(): Promise<Result<void, ProviderAccessTokenError>>;
}

/** Supplies a valid Spotify user access token without exposing token storage. */
export interface SpotifyAccessTokens {
	/** Returns a redacted token for immediate use by the Spotify I/O adapter. */
	getValidAccessToken(): Promise<Result<RedactedValue<string>, ProviderAccessTokenError>>;
}

/** Supplies a valid Twitch broadcaster access token without exposing token storage. */
export interface TwitchAccessTokens {
	/** Returns a redacted token for immediate use by the Twitch I/O adapter. */
	getValidAccessToken(): Promise<Result<RedactedValue<string>, ProviderAccessTokenError>>;
}
