import { Effect, Option, Redacted, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { TwitchHttpApi } from "@cf-twitch/contracts/twitch-api";
import { OAuthRedirectUri, OAuthState } from "@cf-twitch/contracts/oauth";
import type { OAuthProvider } from "@cf-twitch/contracts/provider";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { OAuthAuthorization } from "../oauth/oauth-authorization.ts";
import { HttpBoundaryError, compareHttpSecret, handleHttpBoundary } from "./http-boundary.ts";

const providerName = (provider: OAuthProvider) => (provider === "spotify" ? "Spotify" : "Twitch");

const parseOAuthRedirectUri = Schema.decodeEffect(OAuthRedirectUri);

const parseOAuthState = Schema.decodeOption(OAuthState);

const callbackUri = Effect.fn("Http.oauthCallbackUri")(function* (
  request: HttpServerRequest.HttpServerRequest,
  provider: OAuthProvider,
) {
  const url = new URL(request.originalUrl);
  // Preserve trusted reverse-proxy protocol handling used by cloudflared development.
  const protocol = request.headers["x-forwarded-proto"] ?? url.protocol.slice(0, -1);

  return yield* parseOAuthRedirectUri(`${protocol}://${url.host}/oauth/${provider}/callback`).pipe(
    Effect.mapError(
      () => new HttpBoundaryError({ status: 400, error: "Invalid OAuth callback URL" }),
    ),
  );
});

/** OAuth state is durable, provider-bound and consumed even on denial or missing-code callbacks. */
export const twitchOAuthHandlersLayer = HttpApiBuilder.group(TwitchHttpApi, "oauth", (handlers) =>
  Effect.gen(function* () {
    const configuration = yield* TwitchConfiguration;
    const authorization = yield* OAuthAuthorization;

    const authorize = Effect.fn("Http.oauthAuthorize")(function* (provider: OAuthProvider) {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (Redacted.value(configuration.oauthSetupSecret).length === 0)
        return yield* Effect.fail(
          new HttpBoundaryError({ status: 500, error: "OAuth setup not configured" }),
        );
      const supplied = request.headers["x-setup-secret"];

      if (
        !supplied ||
        !(yield* compareHttpSecret(Redacted.make(supplied), configuration.oauthSetupSecret))
      )
        return yield* Effect.fail(new HttpBoundaryError({ status: 401, error: "Unauthorized" }));

      const started = yield* authorization
        .beginAuthorization({ provider, redirectUri: yield* callbackUri(request, provider) })
        .pipe(
          Effect.mapError(
            () =>
              new HttpBoundaryError({
                status: 503,
                error: `Unable to start ${providerName(provider)} authorization`,
              }),
          ),
        );

      return HttpServerResponse.empty({
        status: 302,
        headers: { location: Redacted.value(started.authorizationUrl) },
      });
    }, handleHttpBoundary);

    const callback = Effect.fn("Http.oauthCallback")(function* (provider: OAuthProvider) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const query = new URL(request.originalUrl).searchParams;
      const stateValue = query.get("state");
      const state = stateValue === null ? Option.none() : parseOAuthState(stateValue);

      if (Option.isNone(state))
        return yield* Effect.fail(
          new HttpBoundaryError({
            status: 400,
            error: "Invalid or expired OAuth state",
            code: "invalid",
          }),
        );
      const redirectUri = yield* callbackUri(request, provider);

      const outcome = yield* authorization
        .consumeAuthorizationState({ provider, redirectUri, state: state.value })
        .pipe(
          Effect.mapError(
            () =>
              new HttpBoundaryError({ status: 503, error: "OAuth state validation unavailable" }),
          ),
        );

      if (outcome !== "ok")
        return yield* Effect.fail(
          new HttpBoundaryError({
            status: 400,
            error: "Invalid or expired OAuth state",
            code: outcome,
          }),
        );

      if (query.has("error"))
        return yield* Effect.fail(
          new HttpBoundaryError({
            status: 400,
            error: "Authorization failed",
            code: "provider_denied",
            details: `${providerName(provider)} authorization was not approved`,
          }),
        );
      const code = query.get("code");

      if (!code)
        return yield* Effect.fail(
          new HttpBoundaryError({ status: 400, error: "No authorization code received" }),
        );

      const tokens = yield* authorization
        .exchangeAuthorizationCode({ provider, redirectUri, code: Redacted.make(code) })
        .pipe(
          Effect.mapError(
            (failure) =>
              new HttpBoundaryError({
                status:
                  failure._tag === "ProviderError" && failure.kind === "persistence" ? 503 : 500,
                error:
                  failure._tag === "ProviderError" && failure.kind === "persistence"
                    ? `${providerName(provider)} tokens could not be stored`
                    : failure.message,
                code:
                  failure._tag === "ProviderError"
                    ? failure.kind === "invalid-response"
                      ? `${providerName(provider)}ParseError`
                      : failure.kind === "persistence"
                        ? "ProviderAccessTokenError"
                        : `${providerName(provider)}TokenExchangeError`
                    : failure._tag,
              }),
          ),
        );

      return HttpServerResponse.jsonUnsafe({
        success: true,
        message: `${providerName(provider)} authorization complete`,
        scopes: provider === "spotify" ? tokens.scopes.join(" ") : tokens.scopes,
      });
    }, handleHttpBoundary);

    return handlers
      .handleRaw("spotifyAuthorize", () => authorize("spotify"))
      .handleRaw("twitchAuthorize", () => authorize("twitch"))
      .handleRaw("spotifyCallback", () => callback("spotify"))
      .handleRaw("twitchCallback", () => callback("twitch"));
  }),
);
