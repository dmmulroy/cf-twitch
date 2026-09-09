import { expect, it } from "@effect/vitest";
import { OAuthError, OAuthRedirectUri, OAuthState } from "@cf-twitch/contracts/oauth";
import { Effect, Redacted, Schema } from "effect";
import { FastCheck } from "effect/testing";
import { providerAuthorizationScopes } from "./oauth-authorization.ts";

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

it.effect("OAuth errors carry no state, authorization code or persistence cause fields", () =>
  Effect.sync(() => {
    const error = new OAuthError({ operation: "consumeAttempt", reason: "persistence" });
    expect(JSON.stringify(error)).toBe(
      '{"_tag":"OAuthError","operation":"consumeAttempt","reason":"persistence"}',
    );
    expect(error.message).toBe("OAuth state operation failed: consumeAttempt (persistence)");
  }),
);
