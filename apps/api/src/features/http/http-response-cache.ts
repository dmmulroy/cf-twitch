import { Context, Effect, Layer, Option, Schema } from "effect";
import type { TwitchHttpService } from "@cf-twitch/contracts/twitch-api";
import { type HttpBoundaryError, invalidHttpServiceResponse } from "./http-boundary.ts";

/** Validated read-through cache for public statistics responses. */
export interface IHttpResponseCache {
  /**
   * Returns the cached value for `key` when it decodes with `schema`, otherwise loads, caches and returns a fresh value.
   *
   * **Details**
   *
   * Corrupt or unreadable hits are evicted best effort and replaced only from `load`. Failed loads
   * are never cached, and cache I/O failures never fail the request.
   *
   * @param input - Canonical cache `key`, the `service` named if the loaded value is invalid, the
   * response `schema` that validates hits and encodes stored values, and the `load` effect for misses.
   * @returns The value, the failure of `load`, or `HttpBoundaryError` (`InvalidServiceResponse`, 500) when the loaded value violates `schema`.
   */
  readonly readThrough: <A, E, R>(input: {
    readonly key: string;
    readonly service: TwitchHttpService;
    readonly schema: Schema.ConstraintCodec<A, unknown, never, never>;
    readonly load: Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E | HttpBoundaryError, R>;
}

/** Read-through cache for public statistics, shared across origins through canonical keys. */
export class HttpResponseCache extends Context.Service<HttpResponseCache, IHttpResponseCache>()(
  "@cf-twitch/HttpResponseCache",
) {}

/** Cloudflare Cache API operations the response cache uses; exempt from service layout as a Workers runtime binding. */
export class HttpResponseCacheStorage extends Context.Service<
  HttpResponseCacheStorage,
  Pick<Cache, "match" | "put" | "delete">
>()("@cf-twitch/HttpResponseCacheStorage") {}

/** Creates the read-through response cache over the Cache API storage in context. */
export const makeHttpResponseCache = Effect.gen(function* () {
  const storage = yield* HttpResponseCacheStorage;

  return HttpResponseCache.of({
    readThrough: Effect.fn("HttpResponseCache.readThrough")(function* <A, E, R>(input: {
      readonly key: string;
      readonly service: TwitchHttpService;
      readonly schema: Schema.ConstraintCodec<A, unknown, never, never>;
      readonly load: Effect.Effect<A, E, R>;
    }) {
      const request = new Request(input.key);

      const cached = yield* Effect.tryPromise(() => storage.match(request)).pipe(
        Effect.map(Option.fromNullishOr),
        Effect.orElseSucceed(() => Option.none<Response>()),
      );

      if (Option.isSome(cached)) {
        const decoded = yield* Effect.tryPromise(() => cached.value.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(input.schema, { onExcessProperty: "error" })),
          Effect.option,
        );

        if (Option.isSome(decoded)) return decoded.value;
        yield* Effect.tryPromise(() => storage.delete(request)).pipe(Effect.ignore);
      }

      const value = yield* input.load;

      const encoded = yield* Schema.encodeEffect(input.schema)(value).pipe(
        Effect.mapError(() => invalidHttpServiceResponse("readCache", input.service)),
      );

      // Await the bounded Cache API write so it survives request completion without a detached fiber.
      yield* Effect.tryPromise(() =>
        storage.put(
          request,
          Response.json(encoded, {
            headers: { "Cache-Control": "public, max-age=60", Vary: "Accept-Encoding" },
          }),
        ),
      ).pipe(Effect.ignore);

      return value;
    }),
  });
});

/** Layer that builds the response cache and leaves its Cache API storage selectable by the root. */
export const httpResponseCacheLayerWithoutDependencies = Layer.effect(
  HttpResponseCache,
  makeHttpResponseCache,
);

/** Cache API storage over the Worker's named cache, opened lazily during request I/O, never during planning. */
const cloudflareHttpResponseCacheStorageLayer = Layer.succeed(
  HttpResponseCacheStorage,
  HttpResponseCacheStorage.of({
    match: (request, options) =>
      caches.open("cf-twitch-http").then((cache) => cache.match(request, options)),
    put: (request, response) =>
      caches.open("cf-twitch-http").then((cache) => cache.put(request, response)),
    delete: (request, options) =>
      caches.open("cf-twitch-http").then((cache) => cache.delete(request, options)),
  }),
);

/** Production response cache Layer over the Worker's `cf-twitch-http` Cache API cache. */
export const httpResponseCacheLayer = httpResponseCacheLayerWithoutDependencies.pipe(
  Layer.provide(cloudflareHttpResponseCacheStorageLayer),
);

const readCacheKey = (request: RequestInfo | URL): string =>
  request instanceof Request ? request.url : request instanceof URL ? request.href : request;

/** Creates in-memory Cache API storage that stores, clones, and deletes real `Response` values. */
const makeMemoryHttpResponseCacheStorage = () => {
  const entries = new Map<string, Response>();

  return HttpResponseCacheStorage.of({
    match: async (request) => entries.get(readCacheKey(request))?.clone(),
    put: async (request, response) => {
      entries.set(readCacheKey(request), response.clone());
    },
    delete: async (request) => entries.delete(readCacheKey(request)),
  });
};

/** Response cache Layer over fresh in-memory Cache API storage, crossing the same read-through behavior as production. */
export const httpResponseCacheTestLayer = httpResponseCacheLayerWithoutDependencies.pipe(
  Layer.provide(Layer.sync(HttpResponseCacheStorage, makeMemoryHttpResponseCacheStorage)),
);
