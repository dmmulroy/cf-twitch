import {
  BeginAuthorization,
  ConsumeAuthorizationState,
  ExchangeAuthorizationCode,
  OAuthError,
  type AuthorizationStarted,
  type OAuthStateOutcome,
} from "@cf-twitch/contracts/oauth";
import type { ProviderError, ProviderTokens } from "@cf-twitch/contracts/provider";
import { Clock, Context, Crypto, Effect, Layer, Redacted } from "effect";
import { UrlParams } from "effect/unstable/http";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { ProviderAccessTokens } from "../providers/provider-access-tokens.ts";
import { providerAccessTokensLayer } from "../providers/provider-token-client.ts";
import {
  ProviderTokenExchange,
  providerTokenExchangeLayer,
} from "../providers/provider-token-exchange.ts";
import { OAuthStateClient, oauthStateClientLayer } from "./oauth-state-client.ts";

/** Authorization scopes preserve every baseline playback, redemption, chat and shoutout permission. */
export const providerAuthorizationScopes = {
  spotify: [
    "user-modify-playback-state",
    "user-read-playback-state",
    "user-read-currently-playing",
  ],
  twitch: [
    "channel:read:redemptions",
    "channel:manage:redemptions",
    "user:read:chat",
    "user:write:chat",
    "moderator:manage:shoutouts",
  ],
} as const;

/** HTTP consumes state before inspecting provider denial or absent authorization code. */
export interface IOAuthAuthorization {
  readonly beginAuthorization: (
    input: BeginAuthorization,
  ) => Effect.Effect<AuthorizationStarted, OAuthError>;
  readonly consumeAuthorizationState: (
    input: ConsumeAuthorizationState,
  ) => Effect.Effect<OAuthStateOutcome, OAuthError>;
  readonly exchangeAuthorizationCode: (
    input: ExchangeAuthorizationCode,
  ) => Effect.Effect<ProviderTokens, OAuthError | ProviderError>;
}

/** OAuth authorization owns attempt lifetime, provider scope selection, exchange and durable token acceptance. */
export class OAuthAuthorization extends Context.Service<OAuthAuthorization, IOAuthAuthorization>()(
  "@cf-twitch/OAuthAuthorization",
) {}

/** Construct OAuth orchestration without hiding the one-use state or token persistence requirements. */
export const makeOAuthAuthorization = Effect.gen(function* () {
  const configuration = yield* TwitchConfiguration;
  const crypto = yield* Crypto.Crypto;
  const states = yield* OAuthStateClient;
  const exchange = yield* ProviderTokenExchange;
  const tokens = yield* ProviderAccessTokens;

  const beginAuthorization = Effect.fn("OAuthAuthorization.beginAuthorization")(function* (
    input: BeginAuthorization,
  ) {
    const state = yield* crypto.randomUUIDv4.pipe(
      Effect.map(Redacted.make),
      Effect.mapError(
        () => new OAuthError({ operation: "beginAuthorization", reason: "randomness" }),
      ),
    );

    const now = yield* Clock.currentTimeMillis;
    yield* states.createAttempt({
      provider: input.provider,
      redirectUri: input.redirectUri,
      state,
      createdAtMs: now,
      expiresAtMs: now + 600_000,
    });

    const authorizationEndpoint =
      input.provider === "spotify"
        ? "https://accounts.spotify.com/authorize"
        : "https://id.twitch.tv/oauth2/authorize";

    const query = UrlParams.toString({
      client_id: configuration[input.provider].clientId,
      response_type: "code",
      redirect_uri: input.redirectUri,
      scope: providerAuthorizationScopes[input.provider].join(" "),
      state: Redacted.value(state),
    });

    return {
      state,
      authorizationUrl: Redacted.make(`${authorizationEndpoint}?${query}`),
    };
  });

  const consumeAuthorizationState = Effect.fn("OAuthAuthorization.consumeAuthorizationState")(
    (input: ConsumeAuthorizationState) => states.consumeAttempt(input),
  );

  const exchangeAuthorizationCode = Effect.fn("OAuthAuthorization.exchangeAuthorizationCode")(
    function* (input: ExchangeAuthorizationCode) {
      const received = yield* exchange.exchangeAuthorizationCode(input);
      yield* tokens.setTokens({ provider: input.provider, tokens: received });

      return received;
    },
  );

  return OAuthAuthorization.of({
    beginAuthorization,
    consumeAuthorizationState,
    exchangeAuthorizationCode,
  });
});

/** OAuth orchestration with state, tokens, provider exchange and configuration requirements visible. */
export const oauthAuthorizationLayerWithoutDependencies = Layer.effect(
  OAuthAuthorization,
  makeOAuthAuthorization,
);

/** OAuth orchestration selects HTTP-only durable clients and real provider token exchange. */
export const oauthAuthorizationLayer = oauthAuthorizationLayerWithoutDependencies.pipe(
  Layer.provide([oauthStateClientLayer, providerAccessTokensLayer, providerTokenExchangeLayer]),
);
