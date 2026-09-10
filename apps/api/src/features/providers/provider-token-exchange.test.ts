import { it, expect } from "@effect/vitest";
import { BroadcasterId, RewardId } from "@cf-twitch/contracts/identity";
import { OAuthRedirectUri } from "@cf-twitch/contracts/oauth";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import {
  ProviderTokenExchange,
  providerTokenExchangeLayerWithoutDependencies,
} from "./provider-token-exchange.ts";

const configurationLayer = Layer.succeed(TwitchConfiguration, {
  twitch: {
    clientId: "twitch-client",
    clientSecret: Redacted.make("twitch-secret"),
    broadcaster: { id: BroadcasterId.make("123"), displayName: "Test" },
  },
  spotify: { clientId: "spotify-client", clientSecret: Redacted.make("spotify-secret") },
  eventSubSecret: Redacted.make("eventsub-secret"),
  oauthSetupSecret: Redacted.make("setup-secret"),
  administratorSecret: Redacted.make("admin-secret"),
  rewardRouting: {
    songRequestRewardId: RewardId.make("song"),
    keyboardRaffleRewardId: RewardId.make("raffle"),
  },
});

const tokenBody = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "user-read-playback-state user-modify-playback-state",
};

it.effect(
  "exchanges Spotify authorization through controlled HTTP with Basic auth and normalized redacted tokens",
  () =>
    Effect.gen(function* () {
      const transport = HttpClient.make((request) => {
        expect(request.url).toBe("https://accounts.spotify.com/api/token");
        expect(request.method).toBe("POST");
        expect(request.headers["authorization"]).toBe(
          `Basic ${btoa("spotify-client:spotify-secret")}`,
        );
        expect(request.headers["content-type"]).toContain("application/x-www-form-urlencoded");

        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(tokenBody)));
      });

      const result = yield* Effect.gen(function* () {
        const exchange = yield* ProviderTokenExchange;

        return yield* exchange.exchangeAuthorizationCode({
          provider: "spotify",
          code: Redacted.make("synthetic-code"),
          redirectUri: OAuthRedirectUri.make("https://localhost/oauth/spotify/callback"),
        });
      }).pipe(
        Effect.provide(
          providerTokenExchangeLayerWithoutDependencies.pipe(
            Layer.provide([configurationLayer, Layer.succeed(HttpClient.HttpClient, transport)]),
          ),
        ),
      );

      expect(Redacted.value(result.accessToken)).toBe("synthetic-access");
      expect(Option.map(result.refreshToken, Redacted.value)).toEqual(
        Option.some("synthetic-refresh"),
      );
      expect(result.scopes).toEqual(["user-read-playback-state", "user-modify-playback-state"]);
      expect(JSON.stringify(result)).not.toContain("synthetic-access");
    }),
);

it.effect("Twitch app tokens use client credentials without a user refresh token", () =>
  Effect.gen(function* () {
    const transport = HttpClient.make((request) => {
      expect(request.url).toBe("https://id.twitch.tv/oauth2/token");
      expect(request.headers["authorization"]).toBeUndefined();

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ access_token: "app-only", token_type: "bearer", expires_in: 3600 }),
        ),
      );
    });

    const result = yield* Effect.gen(function* () {
      const exchange = yield* ProviderTokenExchange;

      return yield* exchange.getTwitchAppToken();
    }).pipe(
      Effect.provide(
        providerTokenExchangeLayerWithoutDependencies.pipe(
          Layer.provide([configurationLayer, Layer.succeed(HttpClient.HttpClient, transport)]),
        ),
      ),
    );

    expect(Redacted.value(result.accessToken)).toBe("app-only");
    expect(result.expiresIn).toBe(3600);
    expect(Option.isNone(result.refreshToken)).toBe(true);
  }),
);

for (const provider of ["spotify", "twitch"] as const) {
  for (const status of [400, 401, 403, 429, 503]) {
    it.effect(
      `${provider} refresh classifies HTTP ${status} without retaining secret provider bodies`,
      () =>
        Effect.gen(function* () {
          const transport = HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  {
                    error: "invalid_grant",
                    error_description: "synthetic-refresh synthetic-code synthetic-secret",
                  },
                  { status, headers: { "retry-after": "12" } },
                ),
              ),
            ),
          );

          const result = yield* Effect.gen(function* () {
            const exchange = yield* ProviderTokenExchange;

            return yield* exchange.refreshAccessToken({
              provider,
              refreshToken: Redacted.make("synthetic-refresh"),
            });
          }).pipe(
            Effect.provide(
              providerTokenExchangeLayerWithoutDependencies.pipe(
                Layer.provide([
                  configurationLayer,
                  Layer.succeed(HttpClient.HttpClient, transport),
                ]),
              ),
            ),
            Effect.result,
          );

          expect(result._tag).toBe("Failure");

          if (result._tag === "Failure") {
            expect(result.failure.kind).toBe(
              status === 429
                ? "rate-limited"
                : status >= 500
                  ? "network"
                  : "reauthorization-required",
            );
            expect(JSON.stringify(result.failure)).not.toContain("synthetic-");
            expect(result.failure.message).not.toContain("synthetic-");
          }
        }),
    );
  }

  it.effect(
    `${provider} omitted rotated refresh token remains explicit absence for lifecycle retention`,
    () =>
      Effect.gen(function* () {
        const transport = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: "next-access",
                token_type: "Bearer",
                expires_in: 3600,
              }),
            ),
          ),
        );

        const result = yield* Effect.gen(function* () {
          const exchange = yield* ProviderTokenExchange;

          return yield* exchange.refreshAccessToken({
            provider,
            refreshToken: Redacted.make("previous-refresh"),
          });
        }).pipe(
          Effect.provide(
            providerTokenExchangeLayerWithoutDependencies.pipe(
              Layer.provide([configurationLayer, Layer.succeed(HttpClient.HttpClient, transport)]),
            ),
          ),
        );

        expect(Option.isNone(result.refreshToken)).toBe(true);
      }),
  );

  for (const body of [
    { access_token: "leaked-invalid", expires_in: 0 },
    { ...tokenBody, expires_in: 31_536_001 },
    { ...tokenBody, access_token: "" },
  ]) {
    it.effect(
      `${provider} rejects malformed successful token response without leaking decoder input`,
      () =>
        Effect.gen(function* () {
          const transport = HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body))),
          );

          const result = yield* Effect.gen(function* () {
            const exchange = yield* ProviderTokenExchange;

            return yield* exchange.refreshAccessToken({
              provider,
              refreshToken: Redacted.make("refresh"),
            });
          }).pipe(
            Effect.provide(
              providerTokenExchangeLayerWithoutDependencies.pipe(
                Layer.provide([
                  configurationLayer,
                  Layer.succeed(HttpClient.HttpClient, transport),
                ]),
              ),
            ),
            Effect.result,
          );

          expect(result._tag).toBe("Failure");

          if (result._tag === "Failure") {
            expect(result.failure.kind).toBe("invalid-response");
            expect(JSON.stringify(result.failure)).not.toContain("leaked-invalid");
          }
        }),
    );
  }
}
