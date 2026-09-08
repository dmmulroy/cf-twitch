import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { SongQueueError } from "@cf-twitch/contracts/song-queue";
import { RaffleError } from "@cf-twitch/contracts/raffle";
import { TwitchStatsApi } from "@cf-twitch/contracts/twitch-api";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { httpTestConfiguration as configuration } from "./http-test-fixtures.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { Achievements } from "../achievements/achievements-service.ts";
import { Commands } from "../commands/commands.ts";
import { EventBusAdministration } from "../events/event-bus-service.ts";
import { StreamLifecycleClient } from "../stream/stream-lifecycle.ts";
import { OAuthAuthorization } from "../oauth/oauth-authorization.ts";
import { TwitchService } from "../providers/twitch-service.ts";
import { EventSubReceipts } from "../eventsub/eventsub-receipts.ts";
import { HttpResponseCache } from "./http-response-cache.ts";
import { twitchHttpApiLayer } from "./twitch-http-api.ts";
import { twitchStatsHandlersLayer } from "./twitch-stats-handlers.ts";
import { httpValidationGoldenCases } from "./http-validation-golden.ts";

const adminHeaders = { authorization: "Bearer admin-secret" };
const testLayers = (settings = configuration) =>
  Layer.mergeAll(
    Layer.succeed(TwitchConfiguration, settings),
    Layer.mock(SongQueue, {
      getCurrentlyPlaying: () => Effect.succeed({ track: Option.none(), position: 0 }),
      getSongQueue: () => Effect.succeed({ tracks: [], totalCount: 0 }),
      getRequestHistory: () => Effect.succeed({ requests: [], totalCount: 0 }),
      getTopTracks: () => Effect.succeed([]),
      getTopTracksByUser: () => Effect.succeed([]),
      getTopRequesters: () => Effect.succeed([]),
      getUserRequestCountByDisplayName: () => Effect.succeed(0),
    }),
    Layer.mock(Raffle, {
      getLeaderboard: () => Effect.succeed([]),
      getUserStats: () => Effect.succeed(Option.none()),
      getUserStatsByDisplayName: () => Effect.succeed(Option.none()),
    }),
    Layer.mock(Achievements, {
      getDefinitions: () => Effect.succeed([]),
      getLeaderboard: () => Effect.succeed([]),
      getUserAchievements: () => Effect.succeed([]),
      getUnlockedAchievements: () => Effect.succeed([]),
    }),
    Layer.mock(Commands, { getAllCommands: () => Effect.succeed([]) }),
    Layer.mock(EventBusAdministration, {
      listPending: ({ limit, offset }) =>
        Effect.succeed({ items: [], totalCount: 0, limit, offset }),
      listDeadLetters: ({ limit, offset }) =>
        Effect.succeed({ items: [], totalCount: 0, limit, offset }),
    }),
    Layer.mock(StreamLifecycleClient, {
      getState: () =>
        Effect.succeed({
          isLive: false,
          startedAt: Option.none(),
          endedAt: Option.none(),
          peakViewerCount: 0,
        }),
    }),
    Layer.mock(OAuthAuthorization, {}),
    Layer.mock(TwitchService, {
      getStreamInfo: () => Effect.succeed(Option.none()),
      listEventSubSubscriptions: () => Effect.succeed([]),
    }),
    Layer.mock(EventSubReceipts, {}),
    Layer.mock(HttpResponseCache, { readThrough: ({ load }) => load }),
  );
const withHttp = <A, E, R>(
  test: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
  settings = configuration,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        twitchHttpApiLayer.pipe(
          Layer.provide(testLayers(settings)),
          Layer.provide(cloudflareHttpServerLayer),
        ),
        { disableLogger: true },
      ),
    ),
    ({ handler }) => test(handler),
    ({ dispose }) => Effect.promise(dispose),
  );

const request = (path: string, init?: RequestInit) =>
  new Request(`https://worker.test${path}`, init);

describe("Worker HTTP compatibility boundary", () => {
  for (const [index, golden] of httpValidationGoldenCases.entries()) {
    it.effect(`preserves baseline validation JSON ${index}: ${golden.method} ${golden.path}`, () =>
      withHttp((fetch) =>
        Effect.gen(function* () {
          const init: RequestInit = {
            method: golden.method,
            headers: { ...adminHeaders, "content-type": "application/json" },
          };
          if (golden.method !== "GET") init.body = JSON.stringify(golden.body);
          const response = yield* Effect.promise(() => fetch(request(golden.path, init)));
          expect(response.status).toBe(400);
          expect(yield* Effect.promise(() => response.json())).toEqual({
            error: golden.error,
            details: golden.details,
          });
        }),
      ),
    );
  }

  it.effect("fails closed when administrator or setup authentication is unconfigured", () =>
    withHttp(
      (fetch) =>
        Effect.gen(function* () {
          for (const path of ["/api/admin/commands", "/api/debug/stream-state", "/eventsub/list"]) {
            const response = yield* Effect.promise(() =>
              fetch(request(path, { headers: adminHeaders })),
            );
            expect(response.status, path).toBe(503);
          }
          const oauth = yield* Effect.promise(() =>
            fetch(
              request("/oauth/twitch/authorize", { headers: { "x-setup-secret": "setup-secret" } }),
            ),
          );
          expect(oauth.status).toBe(500);
        }),
      {
        ...configuration,
        administratorSecret: Redacted.make(""),
        oauthSetupSecret: Redacted.make(""),
      },
    ),
  );

  it.effect(
    "serves health, server-owned correlation and safe overlay HTML without adding CORS grants",
    () =>
      withHttp((fetch) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            fetch(
              request("/health", {
                headers: { "x-request-id": "spoof", origin: "https://other.test" },
              }),
            ),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toEqual({ status: "ok" });
          expect(response.headers.get("x-request-id")).toMatch(/^[a-f\d-]{36}$/u);
          expect(response.headers.get("x-request-id")).not.toBe("spoof");
          expect(response.headers.get("access-control-allow-origin")).toBeNull();
          expect(response.headers.get("x-trace-id")).toMatch(/^[a-f\d]{32}$/u);
          const missingRoute = yield* Effect.promise(() => fetch(request("/missing")));
          expect(missingRoute.status).toBe(404);
          expect(missingRoute.headers.get("x-request-id")).toMatch(/^[a-f\d-]{36}$/u);
          expect(missingRoute.headers.get("x-trace-id")).toMatch(/^[a-f\d]{32}$/u);
          const overlay = yield* Effect.promise(() => fetch(request("/overlay/now-playing")));
          expect(overlay.headers.get("content-type")).toBe("text/html; charset=UTF-8");
          const html = yield* Effect.promise(() => overlay.text());
          expect(html).toContain("const REQUEST_TIMEOUT_MS = 4000");
          expect(html).toContain("if (pollInFlight) return");
          expect(html).toContain("parseQueueResponse");
          expect(html).toContain("nameEl.textContent = track.name");
        }),
      ),
  );

  it.effect("preserves public empty envelopes and cache headers", () =>
    withHttp((fetch) =>
      Effect.gen(function* () {
        for (const [path, expected] of [
          ["/api/now-playing", { track: null, position: 0 }],
          ["/api/queue", { tracks: [], totalCount: 0 }],
          ["/api/song-requests/history", { requests: [], totalCount: 0 }],
          ["/api/achievements/definitions", []],
          ["/api/achievements/leaderboard", []],
          ["/api/achievements/Viewer", []],
          ["/api/achievements/Viewer/unlocked", []],
        ] as const) {
          const response = yield* Effect.promise(() => fetch(request(path)));
          expect(response.status, path).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toEqual(expected);
        }
        for (const path of [
          "/api/stats/top-tracks",
          "/api/stats/top-tracks/123",
          "/api/stats/top-requesters",
          "/api/stats/raffle/leaderboard",
        ]) {
          const response = yield* Effect.promise(() => fetch(request(path)));
          expect(response.status, path).toBe(200);
          expect(response.headers.get("cache-control")).toBe("public, max-age=60");
          expect(yield* Effect.promise(() => response.json())).toEqual([]);
        }
        const missing = yield* Effect.promise(() => fetch(request("/api/stats/raffle/user/123")));
        expect(missing.status).toBe(404);
        expect(yield* Effect.promise(() => missing.json())).toEqual({ error: "User not found" });
      }),
    ),
  );

  it.effect("distinguishes invalid DO statistics responses from transport outages", () =>
    Effect.gen(function* () {
      for (const [reason, status, error] of [
        ["invalid_response", 502, "Invalid service response"],
        ["transport_unavailable", 503, "Service temporarily unavailable"],
      ] as const) {
        const api = HttpApiBuilder.layer(HttpApi.make("TwitchHttpApi").add(TwitchStatsApi)).pipe(
          Layer.provide(twitchStatsHandlersLayer),
          Layer.provide([
            cloudflareHttpServerLayer,
            Layer.mock(SongQueue, {
              getTopTracks: () =>
                Effect.fail(new SongQueueError({ operation: "getTopTracks", reason })),
            }),
            Layer.mock(Raffle, {
              getLeaderboard: () =>
                Effect.fail(new RaffleError({ operation: "getLeaderboard", reason })),
            }),
            Layer.mock(HttpResponseCache, { readThrough: ({ load }) => load }),
          ]),
        );
        yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(api, { disableLogger: true })),
          ({ handler }) =>
            Effect.gen(function* () {
              for (const path of ["/api/stats/top-tracks", "/api/stats/raffle/leaderboard"]) {
                const response = yield* Effect.promise(() => handler(request(path)));
                expect(response.status, `${path}: ${reason}`).toBe(status);
                expect(yield* Effect.promise(() => response.json())).toEqual({ error });
                expect(response.headers.get("cache-control")).toBeNull();
              }
            }),
          ({ dispose }) => Effect.promise(dispose),
        );
      }
    }),
  );

  it.effect("rejects duplicate, unknown and out-of-range public query values", () =>
    withHttp((fetch) =>
      Effect.gen(function* () {
        for (const path of [
          "/api/queue?limit=101",
          "/api/queue?limit=1.5",
          "/api/queue?limit=1&limit=2",
          "/api/queue?unknown=true",
          "/api/song-requests/history?offset=1",
          "/api/song-requests/history?limit=NaN",
          "/api/achievements/leaderboard?limit=-1",
          "/api/stats/top-tracks?nonce=1",
          "/api/stats/raffle/leaderboard?sortBy=other",
          "/api/stats/raffle/user/123?limit=1",
          "/api/stats/top-tracks/not-a-viewer",
        ]) {
          const response = yield* Effect.promise(() => fetch(request(path)));
          expect(response.status, path).toBe(400);
        }
      }),
    ),
  );

  it.effect(
    "authenticates admin, debug and EventSub management before parsing request bodies",
    () =>
      withHttp((fetch) =>
        Effect.gen(function* () {
          for (const path of ["/api/admin/commands", "/api/debug/stream-state", "/eventsub/list"]) {
            for (const [authorization, status] of [
              [undefined, 401],
              ["admin-secret", 401],
              ["Bearer wrong", 403],
              ["Bearer admin-secret trailing", 401],
            ] as const) {
              const response = yield* Effect.promise(() =>
                fetch(
                  request(path, { headers: authorization === undefined ? {} : { authorization } }),
                ),
              );
              expect(response.status, `${path}: ${authorization}`).toBe(
                authorization === "Bearer admin-secret trailing" && path !== "/eventsub/list"
                  ? 200
                  : status,
              );
            }
            const accepted = yield* Effect.promise(() =>
              fetch(request(path, { headers: adminHeaders })),
            );
            expect(accepted.status, path).toBe(200);
          }
          const body = yield* Effect.promise(() =>
            fetch(
              request("/api/admin/commands", {
                method: "POST",
                body: "{",
                headers: { "content-type": "application/json" },
              }),
            ),
          );
          expect(body.status).toBe(401);
          const authorizedBody = yield* Effect.promise(() =>
            fetch(
              request("/api/admin/commands", {
                method: "POST",
                body: "{",
                headers: { ...adminHeaders, "content-type": "application/json" },
              }),
            ),
          );
          expect(authorizedBody.status).toBe(400);
          expect(yield* Effect.promise(() => authorizedBody.json())).toEqual({
            error: "Invalid JSON body",
          });
        }),
      ),
  );

  it.effect(
    "preserves permissive admin pagination and guards empty achievement reset selectors",
    () =>
      withHttp((fetch) =>
        Effect.gen(function* () {
          const page = yield* Effect.promise(() =>
            fetch(request("/api/admin/dlq?limit=7&limit=8&nonce=1", { headers: adminHeaders })),
          );
          expect(page.status).toBe(200);
          expect(yield* Effect.promise(() => page.json())).toEqual({
            items: [],
            totalCount: 0,
            limit: 7,
            offset: 0,
          });
          const reset = yield* Effect.promise(() =>
            fetch(
              request("/api/admin/achievements/reset-one-time?user=", {
                method: "POST",
                headers: adminHeaders,
              }),
            ),
          );
          expect(reset.status).toBe(400);
          expect(yield* Effect.promise(() => reset.json())).toEqual({
            error: "Viewer display name must not be empty",
          });
        }),
      ),
  );

  it.effect("never accepts OAuth setup secrets from query parameters", () =>
    withHttp((fetch) =>
      Effect.gen(function* () {
        const authorize = yield* Effect.promise(() =>
          fetch(request("/oauth/spotify/authorize?setup_secret=setup-secret")),
        );
        expect(authorize.status).toBe(401);
        const callback = yield* Effect.promise(() =>
          fetch(request("/oauth/twitch/callback?code=uncorrelated")),
        );
        expect(callback.status).toBe(400);
        expect(yield* Effect.promise(() => callback.json())).toEqual({
          error: "Invalid or expired OAuth state",
          code: "invalid",
        });
      }),
    ),
  );
});
