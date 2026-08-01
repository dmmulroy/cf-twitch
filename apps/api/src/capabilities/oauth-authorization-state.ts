import { TaggedError } from "better-result";

import type { Result } from "better-result";

/** OAuth provider supported by the setup authorization flow. */
export type OAuthProvider = "spotify" | "twitch";

/** Non-success outcome when consuming one-time OAuth authorization state. */
export type OAuthAuthorizationStateRejection = "invalid" | "expired" | "consumed" | "mismatch";

/** Expected failure when OAuth authorization state storage is unavailable or malformed. */
export class OAuthAuthorizationStateError extends TaggedError("OAuthAuthorizationStateError")<{
	readonly operation: "create" | "consume";
	readonly failure: "transport" | "protocol";
	readonly message: string;
	readonly cause?: unknown;
}> {
	constructor(args: {
		operation: "create" | "consume";
		failure: "transport" | "protocol";
		cause?: unknown;
	}) {
		super({
			...args,
			message: `OAuth authorization state ${args.operation} failed (${args.failure})`,
		});
	}
}

/** Stores and atomically consumes expiring one-time OAuth authorization state. */
export interface OAuthAuthorizationStateStore {
	/** Creates one state value bound to a provider and exact redirect URI. */
	create(
		provider: OAuthProvider,
		redirectUri: string,
	): Promise<Result<string, OAuthAuthorizationStateError>>;
	/** Consumes state exactly once or returns the reason it was rejected. */
	consume(
		provider: OAuthProvider,
		redirectUri: string,
		state: string,
	): Promise<Result<"ok" | OAuthAuthorizationStateRejection, OAuthAuthorizationStateError>>;
}
