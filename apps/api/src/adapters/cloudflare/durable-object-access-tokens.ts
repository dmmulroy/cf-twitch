import { Result } from "better-result";

import { ProviderAccessTokenError } from "../../capabilities/provider-access-tokens";
import { RedactedValue } from "../../lib/redacted";
import {
	GetValidSpotifyTokenResultCodec,
	GetValidTwitchTokenResultCodec,
	SetSpotifyTokensResultCodec,
	SetTwitchTokensResultCodec,
	SpotifyTokenStreamOfflineResultCodec,
	SpotifyTokenStreamOnlineResultCodec,
	TwitchTokenStreamOfflineResultCodec,
	TwitchTokenStreamOnlineResultCodec,
} from "../../lib/token-rpc-result-codecs";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type {
	ProviderTokenLifecycle,
	SpotifyAccessTokens,
	TwitchAccessTokens,
} from "../../capabilities/provider-access-tokens";
import type { Tracer } from "../../capabilities/tracer";
import type { SpotifyTokenResponse } from "../../services/spotify-service";
import type { TwitchTokenResponse } from "../../services/twitch-service";
import type { DurableObjectAgentStub } from "./durable-object-agent-stub";
import type { SerializedResult } from "better-result";

type TokenProvider = "spotify" | "twitch";
type TokenRpcOperation = "getValidAccessToken" | "setTokens" | "onStreamOnline" | "onStreamOffline";
export type TokenRpcWireError = Readonly<{ _tag: string }>;
export type TokenRpcWireResult<T> = SerializedResult<T, TokenRpcWireError>;
export interface TokenRpcStub<Tokens> extends DurableObjectAgentStub {
	getValidToken(): Promise<TokenRpcWireResult<string>>;
	setTokens(tokens: Tokens): Promise<TokenRpcWireResult<void>>;
	onStreamOnline(): Promise<TokenRpcWireResult<void>>;
	onStreamOffline(): Promise<TokenRpcWireResult<void>>;
}
export type TokenRpcNamespace<Tokens> = Readonly<{
	getByName(name: string): TokenRpcStub<Tokens>;
}>;

async function callProviderTokenRpc<T, Tokens>(args: {
	readonly namespace: TokenRpcNamespace<Tokens>;
	readonly provider: TokenProvider;
	readonly operation: TokenRpcOperation;
	readonly invoke: (stub: TokenRpcStub<Tokens>) => Promise<TokenRpcWireResult<T>>;
	readonly deserializeUnsafe: (
		value: TokenRpcWireResult<T>,
	) => Result<T, Readonly<{ _tag: string }>> | Promise<Result<T, Readonly<{ _tag: string }>>>;
}): Promise<Result<T, ProviderAccessTokenError>> {
	let rawResult: TokenRpcWireResult<T>;
	try {
		const name = args.provider === "spotify" ? "spotify-token" : "twitch-token";
		const stub = await initializeDurableObjectAgentStub(args.namespace.getByName(name), name);
		rawResult = await args.invoke(stub);
	} catch (cause) {
		return Result.err(
			new ProviderAccessTokenError({
				provider: args.provider,
				operation: args.operation,
				failureTag: "DurableObjectUnavailable",
				cause,
			}),
		);
	}
	const result = await args.deserializeUnsafe(rawResult);
	return result.status === "ok"
		? Result.ok(result.value)
		: Result.err(
				new ProviderAccessTokenError({
					provider: args.provider,
					operation: args.operation,
					failureTag: result.error._tag,
				}),
			);
}

/** Durable Object adapter for Spotify access-token lifecycle operations. */
export class DurableObjectSpotifyAccessTokens
	implements SpotifyAccessTokens, ProviderTokenLifecycle
{
	constructor(
		private readonly namespace: TokenRpcNamespace<SpotifyTokenResponse>,
		private readonly tracer: Tracer,
	) {}

	/** Returns a validated, redacted Spotify user access token. */
	getValidAccessToken(): Promise<Result<RedactedValue<string>, ProviderAccessTokenError>> {
		return this.tracer.span(
			"durable_object.spotify_access_tokens.get_valid_access_token",
			{},
			async () => {
				const result = await callProviderTokenRpc({
					namespace: this.namespace,
					provider: "spotify",
					operation: "getValidAccessToken",
					invoke: (stub) => stub.getValidToken(),
					deserializeUnsafe: (value) => GetValidSpotifyTokenResultCodec.deserializeUnsafe(value),
				});
				return result.map(RedactedValue.fromSensitiveValue);
			},
		);
	}

	onStreamOnline(): Promise<Result<void, ProviderAccessTokenError>> {
		return this.callLifecycle("onStreamOnline");
	}

	onStreamOffline(): Promise<Result<void, ProviderAccessTokenError>> {
		return this.callLifecycle("onStreamOffline");
	}

	setTokens(tokens: SpotifyTokenResponse): Promise<Result<void, ProviderAccessTokenError>> {
		return callProviderTokenRpc({
			namespace: this.namespace,
			provider: "spotify",
			operation: "setTokens",
			invoke: (stub) => stub.setTokens(tokens),
			deserializeUnsafe: (value) => SetSpotifyTokensResultCodec.deserializeUnsafe(value),
		});
	}

	private callLifecycle(
		operation: "onStreamOnline" | "onStreamOffline",
	): Promise<Result<void, ProviderAccessTokenError>> {
		return this.tracer.span(
			operation === "onStreamOnline"
				? "durable_object.spotify_access_tokens.on_stream_online"
				: "durable_object.spotify_access_tokens.on_stream_offline",
			{ provider: "spotify", operation },
			() =>
				callProviderTokenRpc({
					namespace: this.namespace,
					provider: "spotify",
					operation,
					invoke: (stub) =>
						operation === "onStreamOnline" ? stub.onStreamOnline() : stub.onStreamOffline(),
					deserializeUnsafe: (value) =>
						operation === "onStreamOnline"
							? SpotifyTokenStreamOnlineResultCodec.deserializeUnsafe(value)
							: SpotifyTokenStreamOfflineResultCodec.deserializeUnsafe(value),
				}),
		);
	}
}

/** Durable Object adapter for Twitch access-token lifecycle operations. */
export class DurableObjectTwitchAccessTokens implements TwitchAccessTokens, ProviderTokenLifecycle {
	constructor(
		private readonly namespace: TokenRpcNamespace<TwitchTokenResponse>,
		private readonly tracer: Tracer,
	) {}

	/** Returns a validated, redacted Twitch broadcaster access token. */
	getValidAccessToken(): Promise<Result<RedactedValue<string>, ProviderAccessTokenError>> {
		return this.tracer.span(
			"durable_object.twitch_access_tokens.get_valid_access_token",
			{},
			async () => {
				const result = await callProviderTokenRpc({
					namespace: this.namespace,
					provider: "twitch",
					operation: "getValidAccessToken",
					invoke: (stub) => stub.getValidToken(),
					deserializeUnsafe: (value) => GetValidTwitchTokenResultCodec.deserializeUnsafe(value),
				});
				return result.map(RedactedValue.fromSensitiveValue);
			},
		);
	}

	onStreamOnline(): Promise<Result<void, ProviderAccessTokenError>> {
		return this.callLifecycle("onStreamOnline");
	}

	onStreamOffline(): Promise<Result<void, ProviderAccessTokenError>> {
		return this.callLifecycle("onStreamOffline");
	}

	setTokens(tokens: TwitchTokenResponse): Promise<Result<void, ProviderAccessTokenError>> {
		return callProviderTokenRpc({
			namespace: this.namespace,
			provider: "twitch",
			operation: "setTokens",
			invoke: (stub) => stub.setTokens(tokens),
			deserializeUnsafe: (value) => SetTwitchTokensResultCodec.deserializeUnsafe(value),
		});
	}

	private callLifecycle(
		operation: "onStreamOnline" | "onStreamOffline",
	): Promise<Result<void, ProviderAccessTokenError>> {
		return this.tracer.span(
			operation === "onStreamOnline"
				? "durable_object.twitch_access_tokens.on_stream_online"
				: "durable_object.twitch_access_tokens.on_stream_offline",
			{ provider: "twitch", operation },
			() =>
				callProviderTokenRpc({
					namespace: this.namespace,
					provider: "twitch",
					operation,
					invoke: (stub) =>
						operation === "onStreamOnline" ? stub.onStreamOnline() : stub.onStreamOffline(),
					deserializeUnsafe: (value) =>
						operation === "onStreamOnline"
							? TwitchTokenStreamOnlineResultCodec.deserializeUnsafe(value)
							: TwitchTokenStreamOfflineResultCodec.deserializeUnsafe(value),
				}),
		);
	}
}
