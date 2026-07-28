import { Result } from "better-result";
import { z } from "zod";

import { ProviderAccessTokenError } from "../../capabilities/provider-access-tokens";
import { RedactedValue } from "../../lib/redacted";
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
import type { Result as ResultType } from "better-result";

const TokenRpcResultSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("ok"), value: z.string().min(1) }).strict(),
	z
		.object({
			status: z.literal("error"),
			error: z.object({ _tag: z.string().min(1), message: z.string() }).passthrough(),
		})
		.strict(),
]);

const SetTokensRpcResultSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("ok"), value: z.undefined() }).strict(),
	z
		.object({
			status: z.literal("error"),
			error: z.object({ _tag: z.string().min(1), message: z.string() }).passthrough(),
		})
		.strict(),
]);

/** Durable Object adapter for Spotify access-token lifecycle operations. */
export class DurableObjectSpotifyAccessTokens
	implements SpotifyAccessTokens, ProviderTokenLifecycle
{
	constructor(
		private readonly namespace: Cloudflare.Env["SPOTIFY_TOKEN_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Returns a runtime-validated, redacted Spotify user access token. */
	getValidAccessToken(): Promise<ResultType<RedactedValue<string>, ProviderAccessTokenError>> {
		return this.tracer.span(
			"durable_object.spotify_access_tokens.get_valid_access_token",
			{},
			async () => {
				try {
					const raw: unknown = await this.namespace.getByName("spotify-token").getValidToken();
					const parsed = TokenRpcResultSchema.safeParse(raw);
					if (!parsed.success) {
						return Result.err(
							new ProviderAccessTokenError({
								provider: "spotify",
								failureTag: "DurableObjectRpcProtocolError",
								cause: parsed.error,
							}),
						);
					}
					return parsed.data.status === "ok"
						? Result.ok(RedactedValue.fromSensitiveValue(parsed.data.value))
						: Result.err(
								new ProviderAccessTokenError({
									provider: "spotify",
									failureTag: parsed.data.error._tag,
								}),
							);
				} catch (cause) {
					return Result.err(
						new ProviderAccessTokenError({
							provider: "spotify",
							failureTag: "DurableObjectUnavailable",
							cause,
						}),
					);
				}
			},
		);
	}

	/** Marks Spotify token refresh as eligible for an active Stream Session. */
	onStreamOnline(): Promise<ResultType<void, ProviderAccessTokenError>> {
		return callTokenLifecycleRpc(
			this.namespace,
			"spotify-token",
			"spotify",
			"onStreamOnline",
			this.tracer,
		);
	}

	/** Marks Spotify token refresh as unavailable after a Stream Session ends. */
	onStreamOffline(): Promise<ResultType<void, ProviderAccessTokenError>> {
		return callTokenLifecycleRpc(
			this.namespace,
			"spotify-token",
			"spotify",
			"onStreamOffline",
			this.tracer,
		);
	}

	/** Persists a parsed Spotify OAuth token response. */
	async setTokens(
		tokens: SpotifyTokenResponse,
	): Promise<ResultType<void, ProviderAccessTokenError>> {
		try {
			const raw: unknown = await this.namespace.getByName("spotify-token").setTokens(tokens);
			const parsed = SetTokensRpcResultSchema.safeParse(raw);
			if (parsed.success && parsed.data.status === "ok") return Result.ok(undefined);
			return Result.err(
				new ProviderAccessTokenError({
					provider: "spotify",
					operation: "setTokens",
					failureTag:
						parsed.success && parsed.data.status === "error"
							? parsed.data.error._tag
							: "DurableObjectRpcProtocolError",
				}),
			);
		} catch (cause) {
			return Result.err(
				new ProviderAccessTokenError({
					provider: "spotify",
					operation: "setTokens",
					failureTag: "DurableObjectUnavailable",
					cause,
				}),
			);
		}
	}
}

/** Durable Object adapter for Twitch access-token lifecycle operations. */
export class DurableObjectTwitchAccessTokens implements TwitchAccessTokens, ProviderTokenLifecycle {
	constructor(
		private readonly namespace: Cloudflare.Env["TWITCH_TOKEN_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Returns a runtime-validated, redacted Twitch broadcaster access token. */
	getValidAccessToken(): Promise<ResultType<RedactedValue<string>, ProviderAccessTokenError>> {
		return this.tracer.span(
			"durable_object.twitch_access_tokens.get_valid_access_token",
			{},
			async () => {
				try {
					const raw: unknown = await this.namespace.getByName("twitch-token").getValidToken();
					const parsed = TokenRpcResultSchema.safeParse(raw);
					if (!parsed.success) {
						return Result.err(
							new ProviderAccessTokenError({
								provider: "twitch",
								failureTag: "DurableObjectRpcProtocolError",
								cause: parsed.error,
							}),
						);
					}
					return parsed.data.status === "ok"
						? Result.ok(RedactedValue.fromSensitiveValue(parsed.data.value))
						: Result.err(
								new ProviderAccessTokenError({
									provider: "twitch",
									failureTag: parsed.data.error._tag,
								}),
							);
				} catch (cause) {
					return Result.err(
						new ProviderAccessTokenError({
							provider: "twitch",
							failureTag: "DurableObjectUnavailable",
							cause,
						}),
					);
				}
			},
		);
	}

	/** Marks Twitch token refresh as eligible for an active Stream Session. */
	onStreamOnline(): Promise<ResultType<void, ProviderAccessTokenError>> {
		return callTokenLifecycleRpc(
			this.namespace,
			"twitch-token",
			"twitch",
			"onStreamOnline",
			this.tracer,
		);
	}

	/** Marks Twitch token refresh as unavailable after a Stream Session ends. */
	onStreamOffline(): Promise<ResultType<void, ProviderAccessTokenError>> {
		return callTokenLifecycleRpc(
			this.namespace,
			"twitch-token",
			"twitch",
			"onStreamOffline",
			this.tracer,
		);
	}

	/** Persists a parsed Twitch OAuth token response. */
	async setTokens(
		tokens: TwitchTokenResponse,
	): Promise<ResultType<void, ProviderAccessTokenError>> {
		try {
			const raw: unknown = await this.namespace.getByName("twitch-token").setTokens(tokens);
			const parsed = SetTokensRpcResultSchema.safeParse(raw);
			if (parsed.success && parsed.data.status === "ok") return Result.ok(undefined);
			return Result.err(
				new ProviderAccessTokenError({
					provider: "twitch",
					operation: "setTokens",
					failureTag:
						parsed.success && parsed.data.status === "error"
							? parsed.data.error._tag
							: "DurableObjectRpcProtocolError",
				}),
			);
		} catch (cause) {
			return Result.err(
				new ProviderAccessTokenError({
					provider: "twitch",
					operation: "setTokens",
					failureTag: "DurableObjectUnavailable",
					cause,
				}),
			);
		}
	}
}

interface TokenLifecycleRpcStub extends DurableObjectAgentStub {
	onStreamOnline(): Promise<unknown>;
	onStreamOffline(): Promise<unknown>;
}

type TokenLifecycleNamespace = Readonly<{
	getByName(name: string): TokenLifecycleRpcStub;
}>;

function callTokenLifecycleRpc(
	namespace: TokenLifecycleNamespace,
	name: "spotify-token" | "twitch-token",
	provider: "spotify" | "twitch",
	operation: "onStreamOnline" | "onStreamOffline",
	tracer: Tracer,
): Promise<ResultType<void, ProviderAccessTokenError>> {
	const spanName =
		operation === "onStreamOnline"
			? provider === "spotify"
				? "durable_object.spotify_access_tokens.on_stream_online"
				: "durable_object.twitch_access_tokens.on_stream_online"
			: provider === "spotify"
				? "durable_object.spotify_access_tokens.on_stream_offline"
				: "durable_object.twitch_access_tokens.on_stream_offline";
	return tracer.span(spanName, { provider, operation }, async () => {
		try {
			const stub = await initializeDurableObjectAgentStub(namespace.getByName(name), name);
			const raw: unknown =
				operation === "onStreamOnline" ? await stub.onStreamOnline() : await stub.onStreamOffline();
			const parsed = SetTokensRpcResultSchema.safeParse(raw);
			if (parsed.success && parsed.data.status === "ok") return Result.ok(undefined);
			return Result.err(
				new ProviderAccessTokenError({
					provider,
					operation,
					failureTag:
						parsed.success && parsed.data.status === "error"
							? parsed.data.error._tag
							: "DurableObjectRpcProtocolError",
				}),
			);
		} catch (cause) {
			return Result.err(
				new ProviderAccessTokenError({
					provider,
					operation,
					failureTag: "DurableObjectUnavailable",
					cause,
				}),
			);
		}
	});
}
