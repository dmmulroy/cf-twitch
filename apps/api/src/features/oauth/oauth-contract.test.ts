import { expect, it } from "@effect/vitest";
import { OAuthError, OAuthRedirectUri, OAuthState } from "@cf-twitch/contracts/oauth";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { TestClock } from "effect/testing";
import {
  ProviderAccessTokens,
  providerAccessTokensTestLayer,
} from "../providers/provider-access-tokens.ts";
import { providerLocalConfigurationLayer } from "../providers/provider-local-sql.test-support.ts";
import { providerTokenExchangeTestLayer } from "../providers/provider-token-exchange.ts";
import {
  OAuthAuthorization,
  oauthAuthorizationLayerWithoutDependencies,
  oauthAuthorizationScopes,
} from "./oauth-authorization.ts";
import { oauthStateClientTestLayer } from "./oauth-state-client.ts";

const parseState = Schema.decodeSync(OAuthState);

const encodeState = Schema.encodeSync(OAuthState);

const parseRedirect = Schema.decodeOption(OAuthRedirectUri);

const redirectUri = OAuthRedirectUri.make(
  "https://example.test/oauth/callback?from=setup&label=a+b",
);

// Deterministic secure randomness: each request yields distinct bytes, so each attempt gets its own state.
const sequentialSecureRandomLayer = Layer.effect(
  SecureRandom.SecureRandom,
  Effect.sync(() => {
    let calls = 0;

    return SecureRandom.make((size) => {
      calls += 1;

      return new Uint8Array(size).fill(calls);
    });
  }),
);

const oauthLayer = oauthAuthorizationLayerWithoutDependencies.pipe(
  Layer.provide([
    oauthStateClientTestLayer,
    providerAccessTokensTestLayer,
    providerTokenExchangeTestLayer,
    providerLocalConfigurationLayer,
    sequentialSecureRandomLayer,
  ]),
);

it.prop(
  "OAuth UUID state roundtrips only at the explicit wire boundary and remains redacted in diagnostics",
  [Schema.String.check(Schema.isUUID())],
  ([value]) => {
    const state = parseState(value);
    expect(encodeState(state)).toBe(value);
    expect(Redacted.value(state)).toBe(value);
    expect(JSON.stringify({ state })).not.toContain(value);
  },
  { arbitrary: { runs: 100 } },
);

it.effect("OAuth redirect URI parser rejects malformed absolute URLs and non-HTTP schemes", () =>
  Effect.sync(() => {
    for (const value of [
      "https:///",
      "/oauth/callback",
      "javascript:alert(1)",
      "https://",
      "https://bad host/callback",
    ])
      expect(parseRedirect(value)._tag).toBe("None");

    for (const value of [
      "https://localhost/oauth/callback",
      "http://127.0.0.1:8787/oauth/callback",
      "https://example.test/oauth/callback?setup=1",
    ])
      expect(parseRedirect(value)._tag).toBe("Some");
  }),
);

it.effect("OAuth token setup retains all baseline provider scopes", () =>
  Effect.sync(() => {
    expect(oauthAuthorizationScopes.spotify).toEqual([
      "user-modify-playback-state",
      "user-read-playback-state",
      "user-read-currently-playing",
    ]);
    expect(oauthAuthorizationScopes.twitch).toEqual([
      "channel:read:redemptions",
      "channel:manage:redemptions",
      "user:read:chat",
      "user:write:chat",
      "moderator:manage:shoutouts",
    ]);
  }),
);

it.effect("OAuth authorization URLs preserve exact query encoding and remain redacted", () =>
  Effect.gen(function* () {
    const authorization = yield* OAuthAuthorization;

    for (const provider of ["spotify", "twitch"] as const) {
      const started = yield* authorization.beginAuthorization({ provider, redirectUri });
      const state = Redacted.value(started.state);

      const endpoint =
        provider === "spotify"
          ? "https://accounts.spotify.com/authorize"
          : "https://id.twitch.tv/oauth2/authorize";

      const expectedScope = oauthAuthorizationScopes[provider].join("+");
      const expectedUrl = `${endpoint}?client_id=${provider}-client&response_type=code&redirect_uri=https%3A%2F%2Fexample.test%2Foauth%2Fcallback%3Ffrom%3Dsetup%26label%3Da%2Bb&scope=${expectedScope.replaceAll(":", "%3A")}&state=${state}`;

      expect(Schema.is(Schema.String.check(Schema.isUUID()))(state)).toBe(true);
      expect(Redacted.value(started.authorizationUrl)).toBe(expectedUrl);
      expect(JSON.stringify(started)).not.toContain(state);
      expect(JSON.stringify(started)).not.toContain("oauth/callback");
    }
  }).pipe(Effect.provide(oauthLayer)),
);

it.effect(
  "OAuth state is consumed once, only with its exact provider and redirect URI, and expires after ten minutes",
  () =>
    Effect.gen(function* () {
      const authorization = yield* OAuthAuthorization;
      const started = yield* authorization.beginAuthorization({ provider: "twitch", redirectUri });
      const callback = { provider: "twitch" as const, redirectUri, state: started.state };

      expect(
        yield* authorization.consumeAuthorizationState({ ...callback, provider: "spotify" }),
      ).toBe("mismatch");
      expect(yield* authorization.consumeAuthorizationState(callback)).toBe("ok");
      expect(yield* authorization.consumeAuthorizationState(callback)).toBe("consumed");

      const unknown = parseState("00000000-0000-4000-8000-000000000000");

      expect(yield* authorization.consumeAuthorizationState({ ...callback, state: unknown })).toBe(
        "invalid",
      );

      const expiring = yield* authorization.beginAuthorization({ provider: "twitch", redirectUri });
      yield* TestClock.adjust("10 minutes");

      expect(
        yield* authorization.consumeAuthorizationState({ ...callback, state: expiring.state }),
      ).toBe("expired");
    }).pipe(Effect.provide(oauthLayer)),
);

it.effect(
  "OAuth code exchange stores tokens durably and their refresh token renews access while the stream is live",
  () =>
    Effect.gen(function* () {
      const authorization = yield* OAuthAuthorization;
      const tokens = yield* ProviderAccessTokens;

      const received = yield* authorization.exchangeAuthorizationCode({
        provider: "spotify",
        redirectUri,
        code: Redacted.make("authorization-code"),
      });

      const stored = yield* tokens.getValidAccessToken("spotify");
      expect(Redacted.value(stored)).toBe(Redacted.value(received.accessToken));

      yield* tokens.onStreamOnline("spotify");
      yield* TestClock.adjust(`${received.expiresIn} seconds`);

      const refreshed = yield* tokens.getValidAccessToken("spotify");
      expect(Redacted.value(refreshed)).not.toBe(Redacted.value(received.accessToken));
      expect(Redacted.value(yield* tokens.getValidAccessToken("spotify"))).toBe(
        Redacted.value(refreshed),
      );
    }).pipe(
      Effect.provide(
        oauthAuthorizationLayerWithoutDependencies.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              oauthStateClientTestLayer,
              providerAccessTokensTestLayer,
              providerTokenExchangeTestLayer,
            ),
          ),
          Layer.provide([providerLocalConfigurationLayer, sequentialSecureRandomLayer]),
        ),
      ),
    ),
);

it.effect("OAuth errors carry no state, authorization code or persistence cause fields", () =>
  Effect.sync(() => {
    const error = new OAuthError({
      operation: "consumeAttempt",
      reason: "persistence",
      provider: Option.some("twitch"),
    });

    const encoded = Schema.encodeSync(OAuthError)(error);

    expect(Object.keys(encoded).sort()).toEqual(["_tag", "operation", "provider", "reason"]);
    expect(encoded).toHaveProperty("provider", "twitch");
    expect(error.message).toBe(
      "OAuth state storage failed during consumeAttempt for twitch. Start authorization again from the setup link.",
    );
  }),
);
