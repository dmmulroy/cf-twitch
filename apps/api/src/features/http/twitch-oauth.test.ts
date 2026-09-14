import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter } from "effect/unstable/http";
import { TwitchOAuthApi } from "@cf-twitch/contracts/twitch-api";
import { OAuthError, type OAuthStateOutcome } from "@cf-twitch/contracts/oauth";
import { ProviderError } from "@cf-twitch/contracts/provider";
import { OAuthAuthorization, type IOAuthAuthorization } from "../oauth/oauth-authorization.ts";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { twitchOAuthHandlersLayer } from "./twitch-oauth-handlers.ts";
import { httpTestConfiguration } from "./http-test-fixtures.ts";

const state = "11111111-1111-4111-8111-111111111111";

const oauthApi = HttpApi.make("TwitchHttpApi").add(TwitchOAuthApi);

const withOAuth = <A, E, R>(
  authorization: IOAuthAuthorization,
  test: (fetch: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
) => {
  const api = HttpApiBuilder.layer(oauthApi).pipe(
    Layer.provide(twitchOAuthHandlersLayer),
    Layer.provide([
      Layer.succeed(TwitchConfiguration, httpTestConfiguration),
      Layer.succeed(OAuthAuthorization, authorization),
      cloudflareHttpServerLayer,
    ]),
  );

  return Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(api, { disableLogger: true })),
    ({ handler }) => test(handler),
    ({ dispose }) => Effect.promise(dispose),
  );
};

const fixtureAuthorization = (outcome: OAuthStateOutcome = "ok"): IOAuthAuthorization => ({
  beginAuthorization: () =>
    Effect.succeed({
      state: Redacted.make(state),
      authorizationUrl: Redacted.make(`https://accounts.spotify.com/authorize?state=${state}`),
    }),
  consumeAuthorizationState: () => Effect.succeed(outcome),
  exchangeAuthorizationCode: () =>
    Effect.succeed({
      accessToken: Redacted.make("never-render-access"),
      refreshToken: Option.some(Redacted.make("never-render-refresh")),
      tokenType: "bearer",
      expiresIn: 3600,
      scopes: ["first-scope", "second-scope"],
    }),
});

const oauthRequest = (path: string, headers?: HeadersInit) =>
  new Request(`https://worker.test/oauth${path}`, headers === undefined ? {} : { headers });

describe("OAuth HTTP protocol", () => {
  it.effect(
    "binds authorize and callback to exact reverse-proxy redirect URI and renders provider-specific scopes",
    () => {
      const observations: string[] = [];
      const defaults = fixtureAuthorization();

      return withOAuth(
        {
          ...defaults,
          beginAuthorization: (input) => {
            observations.push(`${input.provider}:${input.redirectUri}`);

            return defaults.beginAuthorization(input);
          },
          consumeAuthorizationState: (input) => {
            observations.push(`consume:${input.redirectUri}:${Redacted.value(input.state)}`);

            return defaults.consumeAuthorizationState(input);
          },
          exchangeAuthorizationCode: (input) => {
            observations.push(`exchange:${input.redirectUri}:${Redacted.value(input.code)}`);

            return defaults.exchangeAuthorizationCode(input);
          },
        },
        (fetch) =>
          Effect.gen(function* () {
            const started = yield* Effect.promise(() =>
              fetch(
                new Request("http://worker.test/oauth/spotify/authorize", {
                  headers: { "x-setup-secret": "setup-secret", "x-forwarded-proto": "https" },
                }),
              ),
            );

            expect(started.status).toBe(302);
            expect(started.headers.get("location")).toBe(
              `https://accounts.spotify.com/authorize?state=${state}`,
            );
            expect(started.headers.get("set-cookie")).toBeNull();
            expect(observations).toEqual(["spotify:https://worker.test/oauth/spotify/callback"]);

            for (const provider of ["spotify", "twitch"] as const) {
              const callback = yield* Effect.promise(() =>
                fetch(oauthRequest(`/${provider}/callback?state=${state}&code=opaque-code`)),
              );

              expect(callback.status).toBe(200);
              const body = yield* Effect.promise(() => callback.text());
              expect(JSON.parse(body)).toEqual({
                success: true,
                message:
                  provider === "spotify"
                    ? "Spotify authorization complete"
                    : "Twitch authorization complete",
                scopes:
                  provider === "spotify"
                    ? "first-scope second-scope"
                    : ["first-scope", "second-scope"],
              });
              expect(body).not.toContain("never-render");
            }

            expect(observations.slice(1)).toEqual([
              `consume:https://worker.test/oauth/spotify/callback:${state}`,
              "exchange:https://worker.test/oauth/spotify/callback:opaque-code",
              `consume:https://worker.test/oauth/twitch/callback:${state}`,
              "exchange:https://worker.test/oauth/twitch/callback:opaque-code",
            ]);
          }),
      );
    },
  );

  it.effect(
    "rejects malformed state and consumes valid state before denial or absent-code responses",
    () => {
      const operations: string[] = [];
      const defaults = fixtureAuthorization();

      return withOAuth(
        {
          ...defaults,
          consumeAuthorizationState: () => {
            operations.push("consumed");

            return Effect.succeed("ok");
          },
          exchangeAuthorizationCode: (input) => {
            operations.push("exchanged");

            return defaults.exchangeAuthorizationCode(input);
          },
        },
        (fetch) =>
          Effect.gen(function* () {
            const malformedState = yield* Effect.promise(() =>
              fetch(oauthRequest("/twitch/callback?state=not-a-uuid&code=opaque-code")),
            );

            expect(malformedState.status).toBe(400);
            expect(yield* Effect.promise(() => malformedState.json())).toEqual({
              error: "Invalid or expired OAuth state",
              code: "invalid",
            });

            const denied = yield* Effect.promise(() =>
              fetch(
                oauthRequest(
                  `/twitch/callback?state=${state}&error=access_denied&error_description=Declined`,
                ),
              ),
            );

            expect(denied.status).toBe(400);
            const deniedBody = yield* Effect.promise(() => denied.text());
            expect(JSON.parse(deniedBody)).toEqual({
              error: "Authorization failed",
              code: "provider_denied",
              details: "Twitch authorization was not approved",
            });
            expect(deniedBody).not.toContain("Declined");

            const noCode = yield* Effect.promise(() =>
              fetch(oauthRequest(`/spotify/callback?state=${state}`)),
            );

            expect(noCode.status).toBe(400);
            expect(yield* Effect.promise(() => noCode.json())).toEqual({
              error: "No authorization code received",
            });
            expect(operations).toEqual(["consumed", "consumed"]);
          }),
      );
    },
  );

  for (const outcome of ["invalid", "expired", "consumed", "mismatch"] as const) {
    it.effect(`renders durable state outcome ${outcome} without exchange`, () =>
      withOAuth(
        {
          ...fixtureAuthorization(outcome),
          exchangeAuthorizationCode: () =>
            Effect.die("OAuth HTTP must not exchange rejected state"),
        },
        (fetch) =>
          Effect.gen(function* () {
            const response = yield* Effect.promise(() =>
              fetch(oauthRequest(`/spotify/callback?state=${state}&code=secret`)),
            );

            expect(response.status).toBe(400);
            expect(yield* Effect.promise(() => response.json())).toEqual({
              error: "Invalid or expired OAuth state",
              code: outcome,
            });
          }),
      ),
    );
  }

  it.effect(
    "renders state persistence outage as retryable and provider response corruption as a parse error",
    () =>
      Effect.gen(function* () {
        yield* withOAuth(
          {
            ...fixtureAuthorization(),
            consumeAuthorizationState: () =>
              Effect.fail(new OAuthError({ operation: "consume", reason: "persistence" })),
          },
          (fetch) =>
            Effect.gen(function* () {
              const response = yield* Effect.promise(() =>
                fetch(oauthRequest(`/spotify/callback?state=${state}&code=secret`)),
              );

              expect(response.status).toBe(503);
              expect(yield* Effect.promise(() => response.json())).toEqual({
                error: "OAuth state validation unavailable",
              });
            }),
        );
        yield* withOAuth(
          {
            ...fixtureAuthorization(),
            exchangeAuthorizationCode: () =>
              Effect.fail(
                new ProviderError({
                  provider: "spotify",
                  operation: "exchange",
                  kind: "invalid-response",
                  status: 200,
                  retryAfterMs: Option.none(),
                }),
              ),
          },
          (fetch) =>
            Effect.gen(function* () {
              const response = yield* Effect.promise(() =>
                fetch(oauthRequest(`/spotify/callback?state=${state}&code=secret`)),
              );

              expect(response.status).toBe(500);
              expect(yield* Effect.promise(() => response.json())).toMatchObject({
                code: "SpotifyParseError",
              });
            }),
        );
      }),
  );
});
