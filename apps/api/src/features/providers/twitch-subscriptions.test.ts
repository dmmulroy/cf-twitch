import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  providerLocalAccessTokensLayer,
  providerLocalConfigurationLayer,
} from "./provider-local-sql.test-support.ts";
import { providerTokenExchangeLayer } from "./provider-token-exchange.ts";
import { TwitchService, twitchServiceLayerWithoutDependencies } from "./twitch-service.ts";

const dependencies = twitchServiceLayerWithoutDependencies.pipe(
  Layer.provide(providerLocalAccessTokensLayer),
  Layer.provide(providerTokenExchangeLayer),
  Layer.provide(providerLocalConfigurationLayer),
);

const subscription = (id: string) => ({
  id,
  status: "webhook_callback_verification_pending",
  type: "stream.online",
  version: "1",
  condition: { broadcaster_user_id: "123" },
  transport: { method: "webhook", callback: "https://local.test/webhooks/twitch" },
});

it.effect(
  "Twitch EventSub paginates all pages with one app token and complete matching evidence",
  () =>
    Effect.gen(function* () {
      const pages: string[] = [];
      let appTokenRequests = 0;

      const transport = HttpClient.make((request, url) => {
        if (url.hostname === "id.twitch.tv") {
          appTokenRequests++;

          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: "synthetic-app-token",
                token_type: "Bearer",
                expires_in: 3600,
              }),
            ),
          );
        }

        expect(request.headers["authorization"]).toBe("Bearer synthetic-app-token");
        expect(request.headers["client-id"]).toBe("twitch-client");
        const cursor = url.searchParams.get("after");
        pages.push(cursor ?? "first");

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [subscription(cursor === null ? "first" : "second")],
              pagination: cursor === null ? { cursor: "next-page" } : {},
            }),
          ),
        );
      });

      const subscriptions = yield* Effect.gen(function* () {
        const twitch = yield* TwitchService;

        return yield* twitch.listEventSubSubscriptions();
      }).pipe(
        Effect.provide(
          dependencies.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))),
        ),
      );

      expect(subscriptions.map((item) => item.id)).toEqual(["first", "second"]);
      expect(subscriptions.map((item) => item.status)).toEqual([
        "webhook_callback_verification_pending",
        "webhook_callback_verification_pending",
      ]);
      expect(pages).toEqual(["first", "next-page"]);
      expect(appTokenRequests).toBe(1);
    }),
);

it.effect(
  "Twitch pagination fails closed at one hundred pages rather than returning incomplete evidence",
  () =>
    Effect.gen(function* () {
      let pages = 0;

      const transport = HttpClient.make((request, url) => {
        if (url.hostname === "id.twitch.tv")
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: "app", token_type: "Bearer", expires_in: 3600 }),
            ),
          );
        pages++;

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ data: [subscription("loop")], pagination: { cursor: "never-ending" } }),
          ),
        );
      });

      const result = yield* Effect.gen(function* () {
        const twitch = yield* TwitchService;

        return yield* twitch.listEventSubSubscriptions();
      }).pipe(
        Effect.provide(
          dependencies.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))),
        ),
        Effect.result,
      );

      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "invalid-response" } });
      expect(pages).toBe(100);
    }),
);

it.effect(
  "Twitch EventSub deletion rejects an undocumented successful response status as outcome unknown",
  () =>
    Effect.gen(function* () {
      const transport = HttpClient.make((request, url) => {
        if (url.hostname === "id.twitch.tv")
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: "app", token_type: "Bearer", expires_in: 3600 }),
            ),
          );
        expect(request.method).toBe("DELETE");

        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
        );
      });

      const result = yield* Effect.gen(function* () {
        const twitch = yield* TwitchService;

        return yield* twitch.deleteEventSubSubscription("subscription-to-delete");
      }).pipe(
        Effect.provide(
          dependencies.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))),
        ),
        Effect.result,
      );

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind: "outcome-unknown", status: 200 },
      });
    }),
);

it.effect(
  "Twitch partial pagination failure does not return an apparently complete first page",
  () =>
    Effect.gen(function* () {
      const transport = HttpClient.make((request, url) => {
        if (url.hostname === "id.twitch.tv")
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: "app", token_type: "Bearer", expires_in: 3600 }),
            ),
          );

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            url.searchParams.has("after")
              ? Response.json({ secret: "do-not-leak" }, { status: 503 })
              : Response.json({ data: [subscription("first")], pagination: { cursor: "next" } }),
          ),
        );
      });

      const result = yield* Effect.gen(function* () {
        const twitch = yield* TwitchService;

        return yield* twitch.listEventSubSubscriptions();
      }).pipe(
        Effect.provide(
          dependencies.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))),
        ),
        Effect.result,
      );

      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "network" } });
      expect(JSON.stringify(result)).not.toContain("do-not-leak");
    }),
);
