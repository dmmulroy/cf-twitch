import { expect, it } from "@effect/vitest";
import { OAuthError, OAuthRedirectUri, OAuthState } from "@cf-twitch/contracts/oauth";
import { Crypto, Effect, Layer, Redacted, Schema } from "effect";
import { FastCheck } from "effect/testing";
import { ProviderAccessTokens } from "../providers/provider-access-tokens.ts";
import { providerLocalConfigurationLayer } from "../providers/provider-local-sql.test-support.ts";
import { ProviderTokenExchange } from "../providers/provider-token-exchange.ts";
import {
  OAuthAuthorization,
  oauthAuthorizationLayerWithoutDependencies,
  providerAuthorizationScopes,
} from "./oauth-authorization.ts";
import { OAuthStateClient } from "./oauth-state-client.ts";

const parseState = Schema.decodeSync(OAuthState);

const encodeState = Schema.encodeSync(OAuthState);

const parseRedirect = Schema.decodeOption(OAuthRedirectUri);

it.effect(
  "OAuth UUID state roundtrips only at the explicit wire boundary and remains redacted in diagnostics",
  () =>
    Effect.sync(() => {
      FastCheck.assert(
        FastCheck.property(FastCheck.uuid(), (value) => {
          const state = parseState(value);
          expect(encodeState(state)).toBe(value);
          expect(Redacted.value(state)).toBe(value);
          expect(JSON.stringify({ state })).not.toContain(value);
        }),
        { numRuns: 100 },
      );
    }),
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
    expect(providerAuthorizationScopes.spotify).toEqual([
      "user-modify-playback-state",
      "user-read-playback-state",
      "user-read-currently-playing",
    ]);
    expect(providerAuthorizationScopes.twitch).toEqual([
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
    const cryptoLayer = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, bytes) => Effect.succeed(bytes),
      }),
    );

    const layer = oauthAuthorizationLayerWithoutDependencies.pipe(
      Layer.provide([
        providerLocalConfigurationLayer,
        cryptoLayer,
        Layer.mock(OAuthStateClient, { createAttempt: () => Effect.void }),
        Layer.mock(ProviderTokenExchange, {}),
        Layer.mock(ProviderAccessTokens, {}),
      ]),
    );

    const redirectUri = OAuthRedirectUri.make(
      "https://example.test/oauth/callback?from=setup&label=a+b",
    );

    const expectedState = "00000000-0000-4000-8000-000000000000";

    yield* Effect.gen(function* () {
      const authorization = yield* OAuthAuthorization;

      for (const provider of ["spotify", "twitch"] as const) {
        const started = yield* authorization.beginAuthorization({ provider, redirectUri });

        const endpoint =
          provider === "spotify"
            ? "https://accounts.spotify.com/authorize"
            : "https://id.twitch.tv/oauth2/authorize";

        const expectedScope = providerAuthorizationScopes[provider].join("+");
        const expectedUrl = `${endpoint}?client_id=${provider}-client&response_type=code&redirect_uri=https%3A%2F%2Fexample.test%2Foauth%2Fcallback%3Ffrom%3Dsetup%26label%3Da%2Bb&scope=${expectedScope.replaceAll(":", "%3A")}&state=${expectedState}`;

        expect(Redacted.value(started.state)).toBe(expectedState);
        expect(Redacted.value(started.authorizationUrl)).toBe(expectedUrl);
        expect(JSON.stringify(started)).not.toContain(expectedState);
        expect(JSON.stringify(started)).not.toContain("oauth/callback");
      }
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("OAuth errors carry no state, authorization code or persistence cause fields", () =>
  Effect.sync(() => {
    const error = new OAuthError({ operation: "consumeAttempt", reason: "persistence" });
    expect(JSON.stringify(error)).toBe(
      '{"_tag":"OAuthError","operation":"consumeAttempt","reason":"persistence"}',
    );
    expect(error.message).toBe("OAuth state operation failed: consumeAttempt (persistence)");
  }),
);
