import { expect, it } from "@effect/vitest";
import { OAuthRedirectUri } from "@cf-twitch/contracts/oauth";
import { Effect, Layer, Redacted, Tracer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { providerLocalConfigurationLayer } from "./provider-local-sql.test-support.ts";
import {
  ProviderTokenExchange,
  providerTokenExchangeLayerWithoutDependencies,
} from "./provider-token-exchange.ts";

it.effect(
  "provider tracing collects safe operation metadata but no authorization headers, codes or provider response secrets",
  () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = [];

      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);

          return span;
        },
      });

      const transport = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              { malformed: "response-private-secret" },
              { headers: { "set-cookie": "provider-private-cookie" } },
            ),
          ),
        ),
      );

      const outcome = yield* Effect.gen(function* () {
        const exchange = yield* ProviderTokenExchange;

        return yield* exchange.exchangeAuthorizationCode({
          provider: "spotify",
          code: Redacted.make("private-code"),
          redirectUri: OAuthRedirectUri.make("https://local.test/oauth/callback"),
        });
      }).pipe(
        Effect.provide(
          providerTokenExchangeLayerWithoutDependencies.pipe(
            Layer.provide([
              providerLocalConfigurationLayer,
              Layer.succeed(HttpClient.HttpClient, transport),
            ]),
          ),
        ),
        Effect.result,
        Effect.withTracer(tracer),
        Effect.withTracerEnabled(true),
      );

      expect(outcome).toMatchObject({ _tag: "Failure", failure: { kind: "invalid-response" } });

      const recorded = JSON.stringify(
        spans.map((span) => ({
          name: span.name,
          attributes: [...span.attributes],
          events: span.events,
        })),
      );

      for (const secret of [
        "private-code",
        "response-private-secret",
        "provider-private-cookie",
        "spotify-secret",
        btoa("spotify-client:spotify-secret"),
      ])
        expect(recorded).not.toContain(secret);
      expect(spans.some((span) => span.name === "ProviderHttp.executeProviderRequest")).toBe(true);
      expect(spans.some((span) => span.name.startsWith("http.client"))).toBe(false);
    }).pipe(Effect.withTracerEnabled(true)),
);
