import { Result } from "better-result";
import { z } from "zod";

import {
	NoRefreshTokenError,
	StreamOfflineNoTokenError,
	TokenAuthorizationRevokedError,
	TokenConfigurationError,
	TokenInputParseError,
	TokenNotConfiguredError,
	TokenRefreshNetworkError,
	TokenRefreshParseError,
	TokenStatePersistenceError,
	TokenUnavailableWhileStreamOfflineError,
	type TokenError,
} from "./errors";

const ProviderSchema = z.enum(["spotify", "twitch"]);
const TokenWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({ _tag: z.literal("NoRefreshTokenError"), message: z.string() }),
	z.object({
		_tag: z.literal("TokenNotConfiguredError"),
		provider: ProviderSchema,
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("TokenUnavailableWhileStreamOfflineError"),
		provider: ProviderSchema,
		message: z.string(),
	}),
	z.object({ _tag: z.literal("StreamOfflineNoTokenError"), message: z.string() }),
	z.object({
		_tag: z.literal("TokenAuthorizationRevokedError"),
		provider: ProviderSchema,
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("TokenConfigurationError"),
		provider: ProviderSchema,
		parseError: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("TokenInputParseError"),
		provider: ProviderSchema,
		parseError: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("TokenStatePersistenceError"),
		provider: ProviderSchema,
		operation: z.enum(["parse", "persist", "schedule", "cancel-schedule"]),
		cause: z.unknown().optional(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("TokenRefreshNetworkError"),
		provider: ProviderSchema,
		status: z.number().int(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("TokenRefreshParseError"),
		provider: ProviderSchema,
		parseError: z.string(),
		message: z.string(),
	}),
]);
type TokenWireError = z.infer<typeof TokenWireErrorSchema>;

const TokenErrorToWireSchema = z
	.custom<TokenError>((value) => typeof value === "object" && value !== null && "_tag" in value)
	.transform((error): TokenWireError => ({ ...error, message: error.message }))
	.pipe(TokenWireErrorSchema);
const TokenErrorFromWireSchema = TokenWireErrorSchema.transform((error): TokenError => {
	switch (error._tag) {
		case "NoRefreshTokenError":
			return new NoRefreshTokenError();
		case "TokenNotConfiguredError":
			return new TokenNotConfiguredError({ provider: error.provider });
		case "TokenUnavailableWhileStreamOfflineError":
			return new TokenUnavailableWhileStreamOfflineError({ provider: error.provider });
		case "StreamOfflineNoTokenError":
			return new StreamOfflineNoTokenError();
		case "TokenAuthorizationRevokedError":
			return new TokenAuthorizationRevokedError({ provider: error.provider });
		case "TokenConfigurationError":
			return new TokenConfigurationError({
				provider: error.provider,
				parseError: error.parseError,
			});
		case "TokenInputParseError":
			return new TokenInputParseError({ provider: error.provider, parseError: error.parseError });
		case "TokenStatePersistenceError":
			return new TokenStatePersistenceError({
				provider: error.provider,
				operation: error.operation,
				cause: error.cause,
			});
		case "TokenRefreshNetworkError":
			return new TokenRefreshNetworkError({
				provider: error.provider,
				status: error.status,
				message: error.message,
			});
		case "TokenRefreshParseError":
			return new TokenRefreshParseError({ provider: error.provider, parseError: error.parseError });
	}
});

function createTokenResultCodec<T>(okSchema: z.ZodType<T>) {
	return Result.codec({
		serialize: { ok: okSchema, err: TokenErrorToWireSchema },
		deserialize: { ok: okSchema, err: TokenErrorFromWireSchema },
	});
}

/** RPC codec for accepting an online Spotify token lifecycle transition. */
export const SpotifyTokenStreamOnlineResultCodec = createTokenResultCodec(z.undefined());
/** RPC codec for accepting an offline Spotify token lifecycle transition. */
export const SpotifyTokenStreamOfflineResultCodec = createTokenResultCodec(z.undefined());
/** RPC codec for reading one valid Spotify access token. */
export const GetValidSpotifyTokenResultCodec = createTokenResultCodec(z.string().min(1));
/** RPC codec for persisting one Spotify OAuth token response. */
export const SetSpotifyTokensResultCodec = createTokenResultCodec(z.undefined());
/** RPC codec for accepting an online Twitch token lifecycle transition. */
export const TwitchTokenStreamOnlineResultCodec = createTokenResultCodec(z.undefined());
/** RPC codec for accepting an offline Twitch token lifecycle transition. */
export const TwitchTokenStreamOfflineResultCodec = createTokenResultCodec(z.undefined());
/** RPC codec for reading one valid Twitch access token. */
export const GetValidTwitchTokenResultCodec = createTokenResultCodec(z.string().min(1));
/** RPC codec for persisting one Twitch OAuth token response. */
export const SetTwitchTokensResultCodec = createTokenResultCodec(z.undefined());
