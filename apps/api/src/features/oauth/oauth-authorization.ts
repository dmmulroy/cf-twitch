import {
  BeginAuthorization,
  ConsumeAuthorizationState,
  ExchangeAuthorizationCode,
  OAuthError,
  type AuthorizationStarted,
  type OAuthStateOutcome,
} from "@cf-twitch/contracts/oauth";
import type { ProviderError, ProviderTokens } from "@cf-twitch/contracts/provider";
import { Cause, Clock, Context, Effect, Layer, Option, Redacted } from "effect";
import { SecureRandom } from "effect/crypto";
import { UrlParams } from "effect/http";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import {
  ProviderAccessTokens,
  providerAccessTokensLayer,
  providerAccessTokensTestLayer,
} from "../providers/provider-access-tokens.ts";
import {
  ProviderTokenExchange,
  providerTokenExchangeLayer,
  providerTokenExchangeTestLayer,
} from "../providers/provider-token-exchange.ts";
import {
  OAuthStateClient,
  oauthStateClientLayer,
  oauthStateClientTestLayer,
} from "./oauth-state-client.ts";

/** Provider scopes requested by OAuth authorization, preserving every baseline playback, redemption, chat and shoutout permission. */
export const oauthAuthorizationScopes = {
  /** Spotify scopes for queue control and playback observation. */
  spotify: [
    "user-modify-playback-state",
    "user-read-playback-state",
    "user-read-currently-playing",
  ],
  /** Twitch scopes for channel point redemptions, chat and shoutouts. */
  twitch: [
    "channel:read:redemptions",
    "channel:manage:redemptions",
    "user:read:chat",
    "user:write:chat",
    "moderator:manage:shoutouts",
  ],
} as const;

/** Lifetime of one authorization attempt before its state expires. */
const oauthAuthorizationAttemptLifetimeMs = 600_000;

/**
 * OAuth authorization capability for Spotify and Twitch token setup.
 *
 * **Details**
 *
 * HTTP consumes state before inspecting provider denial or an absent authorization code.
 */
export interface IOAuthAuthorization {
  /**
   * Creates a one-use authorization state and returns the provider authorization URL.
   *
   * @returns The redacted state and authorization URL, or fails with `OAuthError` reason `randomness` when secure randomness is unavailable, or another `OAuthError` reason when the attempt cannot be stored.
   */
  readonly beginAuthorization: (
    input: BeginAuthorization,
  ) => Effect.Effect<AuthorizationStarted, OAuthError>;
  /**
   * Consumes a callback's authorization state once.
   *
   * @returns The consumption outcome, or fails with `OAuthError` when state storage fails or is unreachable.
   */
  readonly consumeAuthorizationState: (
    input: ConsumeAuthorizationState,
  ) => Effect.Effect<OAuthStateOutcome, OAuthError>;
  /**
   * Exchanges an authorization code for provider tokens and stores them durably.
   *
   * @returns The received tokens, or fails with `ProviderError` when the provider exchange fails or the tokens cannot be stored.
   */
  readonly exchangeAuthorizationCode: (
    input: ExchangeAuthorizationCode,
  ) => Effect.Effect<ProviderTokens, ProviderError>;
}

/** Service that owns OAuth attempt lifetime, provider scope selection, code exchange and durable token acceptance. */
export class OAuthAuthorization extends Context.Service<OAuthAuthorization, IOAuthAuthorization>()(
  "@cf-twitch/OAuthAuthorization",
) {}

/** Creates OAuth authorization over one-use state, provider token exchange and durable token storage. */
export const makeOAuthAuthorization = Effect.gen(function* () {
  const configuration = yield* TwitchConfiguration;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const states = yield* OAuthStateClient;
  const exchange = yield* ProviderTokenExchange;
  const tokens = yield* ProviderAccessTokens;

  const beginAuthorization = Effect.fn("OAuthAuthorization.beginAuthorization")(function* (
    input: BeginAuthorization,
  ) {
    // Effect 4.1 SecureRandom reports randomness failure as a defect, not a typed failure.
    const state = yield* secureRandom.uuidV4().pipe(
      Effect.map(Redacted.make),
      Effect.catchCauseIf(
        (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
        () =>
          Effect.fail(
            new OAuthError({
              operation: "beginAuthorization",
              reason: "randomness",
              provider: Option.some(input.provider),
            }),
          ),
      ),
    );

    const now = yield* Clock.currentTimeMillis;
    yield* states.createAttempt({
      provider: input.provider,
      redirectUri: input.redirectUri,
      state,
      createdAtMs: now,
      expiresAtMs: now + oauthAuthorizationAttemptLifetimeMs,
    });

    const authorizationEndpoint =
      input.provider === "spotify"
        ? "https://accounts.spotify.com/authorize"
        : "https://id.twitch.tv/oauth2/authorize";

    const query = UrlParams.toString({
      client_id: configuration[input.provider].clientId,
      response_type: "code",
      redirect_uri: input.redirectUri,
      scope: oauthAuthorizationScopes[input.provider].join(" "),
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

/** Layer that provides OAuth authorization with state, token, exchange, configuration and randomness requirements visible. */
export const oauthAuthorizationLayerWithoutDependencies = Layer.effect(
  OAuthAuthorization,
  makeOAuthAuthorization,
);

/** Production OAuth authorization Layer that selects HTTP-only durable clients and real provider token exchange. */
export const oauthAuthorizationLayer = oauthAuthorizationLayerWithoutDependencies.pipe(
  Layer.provide([oauthStateClientLayer, providerAccessTokensLayer, providerTokenExchangeLayer]),
);

/**
 * Layer that provides OAuth authorization over in-memory state, token storage and provider exchange.
 *
 * **Details**
 *
 * Leaves `TwitchConfiguration` and `SecureRandom` required so tests choose the client IDs and state values.
 */
export const oauthAuthorizationTestLayer = oauthAuthorizationLayerWithoutDependencies.pipe(
  Layer.provide([
    oauthStateClientTestLayer,
    providerAccessTokensTestLayer,
    providerTokenExchangeTestLayer,
  ]),
);
