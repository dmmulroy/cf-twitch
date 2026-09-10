import {
  ProviderError,
  type OAuthProvider,
  type ProviderTokens,
} from "@cf-twitch/contracts/provider";
import type { ExchangeAuthorizationCode } from "@cf-twitch/contracts/oauth";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { decodeProviderResponse, executeProviderRequest } from "./provider-http.ts";

/** OAuth exchange owns provider protocol translation, never durable token state. */
export interface IProviderTokenExchange {
  readonly exchangeAuthorizationCode: (
    input: ExchangeAuthorizationCode,
  ) => Effect.Effect<ProviderTokens, ProviderError>;
  readonly refreshAccessToken: (input: {
    readonly provider: OAuthProvider;
    readonly refreshToken: Redacted.Redacted<string>;
  }) => Effect.Effect<ProviderTokens, ProviderError>;
  readonly getTwitchAppToken: () => Effect.Effect<ProviderTokens, ProviderError>;
}

/** OAuth provider endpoint authority keeps refresh cycles out of user-token clients. */
export class ProviderTokenExchange extends Context.Service<
  ProviderTokenExchange,
  IProviderTokenExchange
>()("@cf-twitch/ProviderTokenExchange") {}

const TokenResponseFields = {
  access_token: Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1))),
  refresh_token: Schema.OptionFromOptionalKey(
    Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1))),
  ),
  token_type: Schema.Trim.check(Schema.isMinLength(1)),
  expires_in: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(31_536_000)),
};

const spotifyDecode = decodeProviderResponse(
  Schema.Struct({ ...TokenResponseFields, scope: Schema.optionalKey(Schema.String) }),
  { provider: "spotify", operation: "tokenExchange", mutation: false },
);

const twitchDecode = decodeProviderResponse(
  Schema.Struct({ ...TokenResponseFields, scope: Schema.optionalKey(Schema.Array(Schema.String)) }),
  { provider: "twitch", operation: "tokenExchange", mutation: false },
);

/** Construct provider token exchange with redacted configuration and an Effect HTTP transport. */
export const makeProviderTokenExchange = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const configuration = yield* TwitchConfiguration;

  const exchange = Effect.fn("ProviderTokenExchange.exchange")(function* (
    provider: OAuthProvider,
    grant: Readonly<Record<string, string>>,
  ) {
    const credentials = configuration[provider];

    const outgoing =
      provider === "spotify"
        ? HttpClientRequest.post("https://accounts.spotify.com/api/token").pipe(
            HttpClientRequest.basicAuth(credentials.clientId, credentials.clientSecret),
            HttpClientRequest.bodyUrlParams(grant),
          )
        : HttpClientRequest.post("https://id.twitch.tv/oauth2/token").pipe(
            HttpClientRequest.bodyUrlParams({
              ...grant,
              client_id: credentials.clientId,
              client_secret: Redacted.value(credentials.clientSecret),
            }),
          );

    const response = yield* executeProviderRequest(client, {
      provider,
      operation: "tokenExchange",
      request: outgoing,
      mutation: false,
      notFound: "not-found",
    });

    const token = yield* provider === "spotify"
      ? spotifyDecode(response).pipe(
          Effect.map((received) => ({
            ...received,
            scope: received.scope?.split(" ").filter(Boolean) ?? [],
          })),
        )
      : twitchDecode(response);

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type,
      expiresIn: token.expires_in,
      scopes: token.scope ?? [],
    };
  });

  return ProviderTokenExchange.of({
    exchangeAuthorizationCode: Effect.fn("ProviderTokenExchange.exchangeAuthorizationCode")(
      (input) =>
        exchange(input.provider, {
          grant_type: "authorization_code",
          code: Redacted.value(input.code),
          redirect_uri: input.redirectUri,
        }),
    ),
    refreshAccessToken: Effect.fn("ProviderTokenExchange.refreshAccessToken")((input) =>
      exchange(input.provider, {
        grant_type: "refresh_token",
        refresh_token: Redacted.value(input.refreshToken),
      }).pipe(
        Effect.mapError((error) =>
          error.status >= 400 && error.status < 500 && error.status !== 429
            ? new ProviderError({
                provider: error.provider,
                operation: error.operation,
                status: error.status,
                retryAfterMs: error.retryAfterMs,
                kind: "reauthorization-required",
              })
            : error,
        ),
      ),
    ),
    getTwitchAppToken: Effect.fn("ProviderTokenExchange.getTwitchAppToken")(() =>
      exchange("twitch", { grant_type: "client_credentials" }),
    ),
  });
});

/** Token exchange leaves HTTP transport and runtime configuration visible. */
export const providerTokenExchangeLayerWithoutDependencies = Layer.effect(
  ProviderTokenExchange,
  makeProviderTokenExchange,
);

/** Token exchange has no infrastructure dependencies beyond runtime HTTP and configuration. */
export const providerTokenExchangeLayer = providerTokenExchangeLayerWithoutDependencies;
