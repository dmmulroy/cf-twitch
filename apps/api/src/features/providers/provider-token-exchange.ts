import {
  ProviderError,
  type OAuthProvider,
  type ProviderOperation,
  type ProviderTokens,
} from "@cf-twitch/contracts/provider";
import type { ExchangeAuthorizationCode } from "@cf-twitch/contracts/oauth";
import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { decodeProviderResponse, executeProviderRequest } from "./provider-http.ts";

/** Input for refreshing one provider's user access token. */
export interface ProviderTokenExchangeRefresh {
  /** Provider whose token endpoint is called. */
  readonly provider: OAuthProvider;
  /** Stored refresh credential; a provider may rotate it in the response. */
  readonly refreshToken: Redacted.Redacted<string>;
}

/**
 * Provider OAuth token endpoint capability, independent of durable token state.
 *
 * **Details**
 *
 * Keeping exchange separate from stream-aware user-token access avoids a refresh dependency cycle.
 */
export interface IProviderTokenExchange {
  /**
   * Exchanges an authorization code for user tokens.
   *
   * @returns The tokens, or fails with `ProviderError` operation `exchangeAuthorizationCode` when the provider is unreachable, refuses the code or returns a malformed response.
   */
  readonly exchangeAuthorizationCode: (
    input: ExchangeAuthorizationCode,
  ) => Effect.Effect<ProviderTokens, ProviderError>;
  /**
   * Refreshes a user access token with its refresh credential.
   *
   * @returns The new tokens, or fails with `ProviderError` operation `refreshAccessToken`; a 4xx refusal other than 429 has reason `reauthorization-required`.
   */
  readonly refreshAccessToken: (
    input: ProviderTokenExchangeRefresh,
  ) => Effect.Effect<ProviderTokens, ProviderError>;
  /**
   * Obtains a Twitch app access token with client credentials.
   *
   * @returns The app token, or fails with `ProviderError` operation `getTwitchAppToken` when the provider is unreachable, refuses the credentials or returns a malformed response.
   */
  readonly getTwitchAppToken: () => Effect.Effect<ProviderTokens, ProviderError>;
}

/** Service that owns the provider OAuth token endpoints, keeping refresh cycles out of user-token clients. */
export class ProviderTokenExchange extends Context.Service<
  ProviderTokenExchange,
  IProviderTokenExchange
>()("@cf-twitch/ProviderTokenExchange") {}

type ProviderTokenGrant =
  | {
      readonly grant_type: "authorization_code";
      readonly code: string;
      readonly redirect_uri: string;
    }
  | { readonly grant_type: "refresh_token"; readonly refresh_token: string }
  | { readonly grant_type: "client_credentials" };

const TokenResponseFields = {
  access_token: Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1))),
  refresh_token: Schema.OptionFromOptionalKey(
    Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1))),
  ),
  token_type: Schema.Trim.check(Schema.isMinLength(1)),
  expires_in: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(31_536_000)),
};

const SpotifyTokenResponse = Schema.Struct({
  ...TokenResponseFields,
  scope: Schema.OptionFromOptionalKey(Schema.String),
});

const TwitchTokenResponse = Schema.Struct({
  ...TokenResponseFields,
  scope: Schema.OptionFromOptionalKey(Schema.Array(Schema.String)),
});

/** Creates provider token exchange over redacted configuration and an Effect HTTP transport. */
export const makeProviderTokenExchange = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const configuration = yield* TwitchConfiguration;

  const exchange = Effect.fn("ProviderTokenExchange.exchange")(function* (
    provider: OAuthProvider,
    operation: ProviderOperation,
    grant: ProviderTokenGrant,
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
      operation,
      request: outgoing,
      mutation: false,
      notFound: "not-found",
    });

    const decodeContext = { provider, operation, mutation: false };

    const token =
      provider === "spotify"
        ? yield* decodeProviderResponse(
            SpotifyTokenResponse,
            decodeContext,
          )(response).pipe(
            Effect.map((received) => ({
              ...received,
              scope: Option.map(received.scope, (scope) => scope.split(" ").filter(Boolean)),
            })),
          )
        : yield* decodeProviderResponse(TwitchTokenResponse, decodeContext)(response);

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type,
      expiresIn: token.expires_in,
      scopes: Option.getOrElse(token.scope, (): ReadonlyArray<string> => []),
    };
  });

  return ProviderTokenExchange.of({
    exchangeAuthorizationCode: Effect.fn("ProviderTokenExchange.exchangeAuthorizationCode")(
      (input) =>
        exchange(input.provider, "exchangeAuthorizationCode", {
          grant_type: "authorization_code",
          code: Redacted.value(input.code),
          redirect_uri: input.redirectUri,
        }),
    ),
    refreshAccessToken: Effect.fn("ProviderTokenExchange.refreshAccessToken")((input) =>
      exchange(input.provider, "refreshAccessToken", {
        grant_type: "refresh_token",
        refresh_token: Redacted.value(input.refreshToken),
      }).pipe(
        Effect.catchTag("ProviderError", (error) =>
          Effect.fail(
            Option.exists(error.status, (status) => status >= 400 && status < 500 && status !== 429)
              ? new ProviderError({
                  provider: error.provider,
                  operation: error.operation,
                  reason: "reauthorization-required",
                  status: error.status,
                  retryAfterMs: error.retryAfterMs,
                })
              : error,
          ),
        ),
      ),
    ),
    getTwitchAppToken: Effect.fn("ProviderTokenExchange.getTwitchAppToken")(() =>
      exchange("twitch", "getTwitchAppToken", { grant_type: "client_credentials" }),
    ),
  });
});

/** Layer that provides provider token exchange with HTTP transport and runtime configuration requirements visible. */
export const providerTokenExchangeLayerWithoutDependencies = Layer.effect(
  ProviderTokenExchange,
  makeProviderTokenExchange,
);

/** Production provider token exchange Layer; it has no application dependencies beyond runtime HTTP and configuration. */
export const providerTokenExchangeLayer = providerTokenExchangeLayerWithoutDependencies;

/** Lifetime in seconds of tokens issued by the in-memory exchange. */
const providerTokenExchangeTestLifetimeSeconds = 3600;

/**
 * Layer that provides an in-memory provider OAuth server issuing deterministic tokens.
 *
 * **Details**
 *
 * Every authorization code is accepted. Refresh rotates the refresh token and refuses unknown or already-rotated refresh tokens with reason `reauthorization-required`, as a provider does.
 */
export const providerTokenExchangeTestLayer = Layer.effect(
  ProviderTokenExchange,
  Effect.gen(function* () {
    const issuedCount = yield* Ref.make(0);
    const activeRefreshTokens = yield* Ref.make(new Set<string>());

    const issue = Effect.fn("ProviderTokenExchangeTest.issue")(function* (
      provider: OAuthProvider,
      withRefreshToken: boolean,
    ) {
      const issued = yield* Ref.updateAndGet(issuedCount, (count) => count + 1);
      const refreshToken = `${provider}-refresh-${issued}`;

      if (withRefreshToken)
        yield* Ref.update(activeRefreshTokens, (active) => new Set(active).add(refreshToken));

      return {
        accessToken: Redacted.make(`${provider}-access-${issued}`),
        refreshToken: withRefreshToken ? Option.some(Redacted.make(refreshToken)) : Option.none(),
        tokenType: "bearer",
        expiresIn: providerTokenExchangeTestLifetimeSeconds,
        scopes: [],
      } satisfies ProviderTokens;
    });

    return ProviderTokenExchange.of({
      exchangeAuthorizationCode: Effect.fn("ProviderTokenExchangeTest.exchangeAuthorizationCode")(
        (input) => issue(input.provider, true),
      ),
      refreshAccessToken: Effect.fn("ProviderTokenExchangeTest.refreshAccessToken")(
        function* (input) {
          const presented = Redacted.value(input.refreshToken);

          const accepted = yield* Ref.modify(activeRefreshTokens, (active) => {
            if (!active.has(presented)) return [false, active];
            const remaining = new Set(active);
            remaining.delete(presented);

            return [true, remaining];
          });

          if (!accepted)
            return yield* Effect.fail(
              new ProviderError({
                provider: input.provider,
                operation: "refreshAccessToken",
                reason: "reauthorization-required",
                status: Option.some(400),
                retryAfterMs: Option.none(),
              }),
            );

          return yield* issue(input.provider, true);
        },
      ),
      getTwitchAppToken: Effect.fn("ProviderTokenExchangeTest.getTwitchAppToken")(() =>
        issue("twitch", false),
      ),
    });
  }),
);
