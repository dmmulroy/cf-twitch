import { Effect, Option, Redacted, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { TwitchHttpApi } from "@cf-twitch/contracts/twitch-api";
import { OAuthRedirectUri, OAuthState } from "@cf-twitch/contracts/oauth";
import type { OAuthProvider } from "@cf-twitch/contracts/provider";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { OAuthAuthorization } from "../oauth/oauth-authorization.ts";
import { HttpBoundaryError, compareHttpSecret, handleHttpBoundary } from "./http-boundary.ts";
import { oauthExchangeHttpFailure, oauthStateHttpFailure } from "./http-service-failures.ts";

const providerName = (provider: OAuthProvider) => (provider === "spotify" ? "Spotify" : "Twitch");

const decodeOAuthRedirectUri = Schema.decodeEffect(OAuthRedirectUri);

const decodeOAuthState = Schema.decodeOption(OAuthState);

/**
 * Resolves the provider callback URI from the request origin, honoring the trusted forwarded protocol.
 *
 * @returns The redirect URI, or fails with `HttpBoundaryError` (`InvalidCallbackUrl`, 400) when the origin does not form a valid URI.
 */
const resolveOAuthCallbackUri = Effect.fn("Http.oauthCallbackUri")(function* (
  request: HttpServerRequest.HttpServerRequest,
  provider: OAuthProvider,
) {
  const url = new URL(request.originalUrl);

  // Preserve trusted reverse-proxy protocol handling used by cloudflared development.
  const protocol = Option.getOrElse(
    Option.fromNullishOr(request.headers["x-forwarded-proto"]),
    () => url.protocol.slice(0, -1),
  );

  return yield* decodeOAuthRedirectUri(`${protocol}://${url.host}/oauth/${provider}/callback`).pipe(
    Effect.mapError(
      () =>
        new HttpBoundaryError({
          operation: "resolveCallback",
          status: 400,
          failure: {
            code: "InvalidCallbackUrl",
            message: `Invalid OAuth callback URL: the request origin and "x-forwarded-proto" header do not form a valid ${providerName(provider)} callback URI. Fix the forwarded protocol header and try again.`,
            details: { provider },
            retryable: false,
          },
        }),
    ),
  );
});

/**
 * Layer that serves Spotify and Twitch OAuth authorization and callback endpoints.
 *
 * **Details**
 *
 * Authorization requires the exact `x-setup-secret` header, never a query value. Callback state is
 * durable, provider-bound and consumed before provider denial or a missing code is inspected, so
 * no callback failure is retryable: each directs the caller to start authorization again.
 */
export const twitchOAuthHandlersLayer = HttpApiBuilder.group(TwitchHttpApi, "oauth", (handlers) =>
  Effect.gen(function* () {
    const configuration = yield* TwitchConfiguration;
    const authorization = yield* OAuthAuthorization;

    const authorize = Effect.fn("Http.oauthAuthorize")(function* (provider: OAuthProvider) {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (Redacted.value(configuration.oauthSetupSecret).length === 0)
        return yield* Effect.fail(
          new HttpBoundaryError({
            operation: "authenticate",
            status: 503,
            failure: {
              code: "AuthenticationNotConfigured",
              message:
                "Authentication not configured for OAuth setup: no setup secret is set. Contact the operator to configure the OAuth setup secret.",
              details: { audience: "OAuth setup" },
              retryable: false,
            },
          }),
        );
      const supplied = Option.fromNullishOr(request.headers["x-setup-secret"]);

      const accepted = yield* Option.match(supplied, {
        onNone: () => Effect.succeed(false),
        onSome: (secret) =>
          compareHttpSecret(Redacted.make(secret), configuration.oauthSetupSecret, "OAuth setup"),
      });

      if (!accepted)
        return yield* Effect.fail(
          new HttpBoundaryError({
            operation: "authenticate",
            status: 401,
            failure: {
              code: "CredentialRejected",
              message:
                'Credential rejected for OAuth setup: the "x-setup-secret" header is missing or wrong. Send the configured setup secret in that header and try again.',
              details: { audience: "OAuth setup" },
              retryable: false,
            },
          }),
        );

      const redirectUri = yield* resolveOAuthCallbackUri(request, provider);

      const started = yield* authorization.beginAuthorization({ provider, redirectUri }).pipe(
        Effect.catchTag("OAuthError", (error) =>
          Effect.fail(
            oauthStateHttpFailure(error, {
              kind: "repeatable",
            }),
          ),
        ),
      );

      return HttpServerResponse.empty({
        status: 302,
        headers: { location: Redacted.value(started.authorizationUrl) },
      });
    });

    const callback = Effect.fn("Http.oauthCallback")(function* (provider: OAuthProvider) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const query = new URL(request.originalUrl).searchParams;
      const restart = `Start authorization again at /oauth/${provider}/authorize.`;

      const rejectedState = (outcome: "invalid" | "expired" | "consumed" | "mismatch") =>
        new HttpBoundaryError({
          operation: "callService",
          status: 400,
          failure: {
            code: outcome,
            message: `OAuth state rejected (${outcome}): the callback state is not a pending ${providerName(provider)} authorization for this redirect URI. ${restart}`,
            details: { provider },
            retryable: false,
          },
        });

      const state = Option.flatMap(Option.fromNullishOr(query.get("state")), decodeOAuthState);

      if (Option.isNone(state)) return yield* Effect.fail(rejectedState("invalid"));
      const redirectUri = yield* resolveOAuthCallbackUri(request, provider);

      const outcome = yield* authorization
        .consumeAuthorizationState({ provider, redirectUri, state: state.value })
        .pipe(
          Effect.catchTag("OAuthError", (error) =>
            Effect.fail(
              oauthStateHttpFailure(error, {
                kind: "change",
                reconcile: restart,
              }),
            ),
          ),
        );

      if (outcome !== "ok") return yield* Effect.fail(rejectedState(outcome));

      if (query.has("error"))
        return yield* Effect.fail(
          new HttpBoundaryError({
            operation: "callService",
            status: 400,
            failure: {
              code: "provider_denied",
              message: `Authorization denied: ${providerName(provider)} authorization was not approved. ${restart}`,
              details: { provider },
              retryable: false,
            },
          }),
        );

      const code = Option.fromNullishOr(query.get("code")).pipe(
        Option.filter((value) => value.length > 0),
      );

      if (Option.isNone(code))
        return yield* Effect.fail(
          new HttpBoundaryError({
            operation: "parseQuery",
            status: 400,
            failure: {
              code: "AuthorizationCodeMissing",
              message: `Authorization code missing: the ${providerName(provider)} callback has no "code" query parameter. ${restart}`,
              details: { provider },
              retryable: false,
            },
          }),
        );

      const tokens = yield* authorization
        .exchangeAuthorizationCode({ provider, redirectUri, code: Redacted.make(code.value) })
        .pipe(
          Effect.catchTag("ProviderError", (error) =>
            Effect.fail(oauthExchangeHttpFailure(error, provider)),
          ),
        );

      return HttpServerResponse.jsonUnsafe({
        success: true,
        message: `${providerName(provider)} authorization complete`,
        scopes: provider === "spotify" ? tokens.scopes.join(" ") : tokens.scopes,
      });
    });

    return handlers
      .handleRaw("spotifyAuthorize", () =>
        authorize("spotify").pipe(handleHttpBoundary("spotifyAuthorize")),
      )
      .handleRaw("twitchAuthorize", () =>
        authorize("twitch").pipe(handleHttpBoundary("twitchAuthorize")),
      )
      .handleRaw("spotifyCallback", () =>
        callback("spotify").pipe(handleHttpBoundary("spotifyCallback")),
      )
      .handleRaw("twitchCallback", () =>
        callback("twitch").pipe(handleHttpBoundary("twitchCallback")),
      );
  }),
);
