import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
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

it.effect("Twitch EventSub continues after an empty page and preserves later page order", () =>
  Effect.gen(function* () {
    const pages: string[] = [];
    let appTokenRequests = 0;

    const transport = HttpClient.make((request, url) => {
      if (url.hostname === "id.twitch.tv") {
        appTokenRequests++;

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ access_token: "app", token_type: "Bearer", expires_in: 3600 }),
          ),
        );
      }

      const cursor = url.searchParams.get("after");
      pages.push(cursor ?? "first");

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            cursor === null
              ? { data: [], pagination: { cursor: "after-empty" } }
              : { data: [subscription("after-empty")], pagination: {} },
          ),
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

    expect(subscriptions.map((item) => item.id)).toEqual(["after-empty"]);
    expect(pages).toEqual(["first", "after-empty"]);
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

it.effect("Twitch app token cache coalesces concurrent lookup within one execution", () =>
  Effect.gen(function* () {
    const tokenStarted = yield* Deferred.make<void>();
    const releaseToken = yield* Deferred.make<void>();
    let appTokenRequests = 0;

    const transport = HttpClient.make((request, url) => {
      if (url.hostname === "id.twitch.tv")
        return Effect.gen(function* () {
          appTokenRequests++;
          yield* Deferred.succeed(tokenStarted, undefined);
          yield* Deferred.await(releaseToken);

          return HttpClientResponse.fromWeb(
            request,
            Response.json({ access_token: "app", token_type: "Bearer", expires_in: 3600 }),
          );
        });

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            data: [
              {
                id: "stream",
                viewer_count: 1,
                started_at: "2026-01-01T00:00:00Z",
                game_name: "Test",
                title: "Test",
              },
            ],
          }),
        ),
      );
    });

    yield* Effect.gen(function* () {
      const twitch = yield* TwitchService;

      const calls = yield* Effect.all(
        [twitch.getStreamInfo("first"), twitch.getStreamInfo("second")],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped);

      yield* Deferred.await(tokenStarted);
      yield* Deferred.succeed(releaseToken, undefined);
      yield* Fiber.join(calls);
    }).pipe(
      Effect.provide(
        dependencies.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))),
      ),
    );

    expect(appTokenRequests).toBe(1);
  }),
);

it.effect("Twitch app token cache expires at its five-minute safety buffer", () =>
  Effect.gen(function* () {
    let appTokenRequests = 0;

    const transport = HttpClient.make((request, url) => {
      if (url.hostname === "id.twitch.tv") {
        appTokenRequests++;

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: `app-${appTokenRequests}`,
              token_type: "Bearer",
              expires_in: 301,
            }),
          ),
        );
      }

      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: [] })));
    });

    yield* Effect.gen(function* () {
      const twitch = yield* TwitchService;
      yield* twitch.getStreamInfo("first");
      yield* TestClock.adjust("999 millis");
      yield* twitch.getStreamInfo("second");
      expect(appTokenRequests).toBe(1);
      yield* TestClock.adjust("2 millis");
      yield* twitch.getStreamInfo("third");
    }).pipe(
      Effect.provide(
        dependencies.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))),
      ),
    );

    expect(appTokenRequests).toBe(2);
  }),
);

it.effect(
  "Twitch app token failures are not cached and unauthorized responses invalidate reuse",
  () =>
    Effect.gen(function* () {
      let appTokenRequests = 0;
      let providerRequests = 0;

      const transport = HttpClient.make((request, url) => {
        if (url.hostname === "id.twitch.tv") {
          appTokenRequests++;

          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              appTokenRequests === 1
                ? Response.json({ error: "temporary" }, { status: 503 })
                : Response.json({
                    access_token: `app-${appTokenRequests}`,
                    token_type: "Bearer",
                    expires_in: 3600,
                  }),
            ),
          );
        }

        providerRequests++;

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            providerRequests === 1
              ? Response.json({ error: "revoked" }, { status: 401 })
              : Response.json({ data: [] }),
          ),
        );
      });

      yield* Effect.gen(function* () {
        const twitch = yield* TwitchService;
        expect(yield* twitch.getStreamInfo("failure").pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { kind: "network" },
        });
        expect(yield* twitch.getStreamInfo("revoked").pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { kind: "unauthorized" },
        });
        yield* twitch.getStreamInfo("recovered");
      }).pipe(
        Effect.provide(
          dependencies.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))),
        ),
      );

      expect(appTokenRequests).toBe(3);
    }),
);

it.effect("Twitch pagination invalidates a revoked app token without retrying its page", () =>
  Effect.gen(function* () {
    let appTokenRequests = 0;
    const authorizationHeaders: string[] = [];

    const transport = HttpClient.make((request, url) => {
      if (url.hostname === "id.twitch.tv") {
        appTokenRequests++;

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: `app-${appTokenRequests}`,
              token_type: "Bearer",
              expires_in: 3600,
            }),
          ),
        );
      }

      authorizationHeaders.push(request.headers["authorization"] ?? "missing");

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.includes("eventsub/subscriptions")
            ? Response.json({ error: "revoked" }, { status: 401 })
            : Response.json({ data: [] }),
        ),
      );
    });

    yield* Effect.gen(function* () {
      const twitch = yield* TwitchService;
      expect(yield* twitch.listEventSubSubscriptions().pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { kind: "unauthorized" },
      });
      yield* twitch.getStreamInfo("after-revocation");
    }).pipe(
      Effect.provide(
        dependencies.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))),
      ),
    );

    expect(appTokenRequests).toBe(2);
    expect(authorizationHeaders).toEqual(["Bearer app-1", "Bearer app-2"]);
  }),
);

it.effect("Twitch app token in-flight work is isolated between execution scopes", () =>
  Effect.gen(function* () {
    let appTokenRequests = 0;

    const transport = HttpClient.make((request, url) => {
      if (url.hostname === "id.twitch.tv") {
        appTokenRequests++;

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ access_token: "app", token_type: "Bearer", expires_in: 3600 }),
          ),
        );
      }

      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: [] })));
    });

    yield* Effect.gen(function* () {
      const twitch = yield* TwitchService;
      yield* Effect.scoped(twitch.getStreamInfo("first"));
      yield* Effect.scoped(twitch.getStreamInfo("second"));
    }).pipe(
      Effect.provide(
        dependencies.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))),
      ),
    );

    expect(appTokenRequests).toBe(2);
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
