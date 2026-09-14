import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Predicate, Schema } from "effect";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter } from "effect/unstable/http";
import { TwitchStatsApi } from "@cf-twitch/contracts/twitch-api";
import { SongQueueError } from "@cf-twitch/contracts/song-queue";
import { ViewerId } from "@cf-twitch/contracts/identity";
import { SongQueue } from "../song-queue/song-queue.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { twitchStatsHandlersLayer } from "./twitch-stats-handlers.ts";
import { HttpResponseCache, httpResponseCacheLayer } from "./http-response-cache.ts";

// A recording Cache API fixture, not a replacement TTL policy. Cache-Control expiry is Cloudflare-owned.
class RecordingWebCache {
  readonly entries = new Map<string, Response>();
  readonly putStarted = Promise.withResolvers<void>();

  constructor(private readonly failure?: "match" | "delete" | "put" | "block-put") {}
  readonly deleted: string[] = [];
  readonly stored: string[] = [];
  readonly key = (request: RequestInfo | URL): string =>
    Predicate.isString(request) ? request : request instanceof URL ? request.href : request.url;
  readonly match = async (request: RequestInfo | URL): Promise<Response | undefined> => {
    if (this.failure === "match") throw new Error("Controlled cache match failure");

    return this.entries.get(this.key(request))?.clone();
  };
  readonly delete = async (request: RequestInfo | URL): Promise<boolean> => {
    if (this.failure === "delete") throw new Error("Controlled cache delete failure");
    this.deleted.push(this.key(request));

    return this.entries.delete(this.key(request));
  };
  readonly put = async (request: RequestInfo | URL, response: Response): Promise<void> => {
    if (this.failure === "put") throw new Error("Controlled cache put failure");

    if (this.failure === "block-put") {
      this.putStarted.resolve();

      return new Promise<void>(() => undefined);
    }

    this.stored.push(this.key(request));
    this.entries.set(this.key(request), response.clone());
  };
}

const statsApi = HttpApi.make("TwitchHttpApi").add(TwitchStatsApi);

describe("HTTP statistics edge cache", () => {
  it.effect(
    "evicts corrupt hits, canonicalizes equivalent limits, and writes only validated success values",
    () =>
      Effect.gen(function* () {
        const cache = new RecordingWebCache();
        const canonicalKey = "https://stats.internal/api/stats/top-requesters?limit=10";
        cache.entries.set(canonicalKey, Response.json({ malformed: true }));
        let loads = 0;

        const api = HttpApiBuilder.layer(statsApi).pipe(
          Layer.provide(twitchStatsHandlersLayer),
          Layer.provide([
            httpResponseCacheLayer(cache),
            cloudflareHttpServerLayer,
            Layer.mock(Raffle, {}),
            Layer.mock(SongQueue, {
              getTopRequesters: () =>
                Effect.sync(() => {
                  loads++;

                  return [];
                }),
            }),
          ]),
        );

        yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(api, { disableLogger: true })),
          ({ handler }) =>
            Effect.gen(function* () {
              for (const path of [
                "/api/stats/top-requesters",
                "/api/stats/top-requesters?limit=10",
                "/api/stats/top-requesters?limit=010",
              ]) {
                const response = yield* Effect.promise(() =>
                  handler(new Request(`https://different-origin.test${path}`)),
                );

                expect(response.status).toBe(200);
                expect(response.headers.get("cache-control")).toBe("public, max-age=60");
                expect(yield* Effect.promise(() => response.json())).toEqual([]);
              }
            }),
          ({ dispose }) => Effect.promise(dispose),
        );
        expect(loads).toBe(1);
        expect(cache.deleted).toEqual([canonicalKey]);
        expect(cache.stored).toEqual([canonicalKey]);
        expect(cache.entries.get(canonicalKey)?.headers.get("vary")).toBe("Accept-Encoding");
      }),
  );

  it.effect("ignores rejected cache operations and still returns the fresh value", () =>
    Effect.gen(function* () {
      const key = "https://stats.internal/api/stats/top-requesters?limit=10";

      for (const operation of ["match", "delete", "put"] as const) {
        const cache = new RecordingWebCache(operation);

        if (operation === "delete") cache.entries.set(key, Response.json({ malformed: true }));

        const value = yield* Effect.gen(function* () {
          const responseCache = yield* HttpResponseCache;

          return yield* responseCache.readThrough({
            key,
            schema: Schema.Array(Schema.String),
            load: Effect.succeed(["fresh"]),
          });
        }).pipe(Effect.provide(httpResponseCacheLayer(cache)));

        expect(value, operation).toEqual(["fresh"]);
      }
    }),
  );

  it.effect("preserves interruption while a cache write is pending", () =>
    Effect.gen(function* () {
      const cache = new RecordingWebCache("block-put");

      const read = Effect.gen(function* () {
        const responseCache = yield* HttpResponseCache;

        return yield* responseCache.readThrough({
          key: "https://stats.internal/api/stats/top-requesters?limit=10",
          schema: Schema.Array(Schema.String),
          load: Effect.succeed(["fresh"]),
        });
      }).pipe(Effect.provide(httpResponseCacheLayer(cache)));

      const fiber = yield* read.pipe(Effect.forkChild);
      yield* Effect.promise(() => cache.putStarted.promise);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }),
  );

  it.effect("does not cache transport failures or malformed fresh response identities", () =>
    Effect.gen(function* () {
      const cache = new RecordingWebCache();
      let loads = 0;

      const api = HttpApiBuilder.layer(statsApi).pipe(
        Layer.provide(twitchStatsHandlersLayer),
        Layer.provide([
          httpResponseCacheLayer(cache),
          cloudflareHttpServerLayer,
          Layer.mock(Raffle, {}),
          Layer.mock(SongQueue, {
            getTopTracks: () =>
              Effect.fail(
                new SongQueueError({ operation: "getTopTracks", reason: "transport_unavailable" }),
              ),
            getTopRequesters: () =>
              Effect.sync(() => {
                loads++;

                return [
                  {
                    userId: Schema.decodeSync(ViewerId)("non-numeric"),
                    displayName: "Viewer",
                    requestCount: 1,
                  },
                ];
              }),
          }),
        ]),
      );

      yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(api, { disableLogger: true })),
        ({ handler }) =>
          Effect.gen(function* () {
            for (const [path, status, error] of [
              ["top-tracks", 503, "Service temporarily unavailable"],
              ["top-requesters", 502, "Invalid service response"],
              ["top-requesters", 502, "Invalid service response"],
            ] as const) {
              const response = yield* Effect.promise(() =>
                handler(new Request(`https://worker.test/api/stats/${path}`)),
              );

              expect(response.status).toBe(status);
              expect(yield* Effect.promise(() => response.json())).toEqual({ error });
              expect(response.headers.get("cache-control")).toBeNull();
            }
          }),
        ({ dispose }) => Effect.promise(dispose),
      );
      expect(loads).toBe(2);
      expect(cache.stored).toEqual([]);
    }),
  );
});
