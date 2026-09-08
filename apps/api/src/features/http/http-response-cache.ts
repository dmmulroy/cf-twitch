import { Context, Effect, Layer, Option, Schema } from "effect";
import { HttpBoundaryError } from "./http-boundary.ts";

/** Validated read-through cache: corrupt hits are evicted and failures are never cached. */
export interface IHttpResponseCache {
  readonly readThrough: <A, E, R>(input: {
    readonly key: string;
    readonly schema: Schema.ConstraintCodec<A, unknown, never, never>;
    readonly load: Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E | HttpBoundaryError, R>;
}

/** Cloudflare edge response cache authority; the Worker supplies its runtime Cache handle. */
export class HttpResponseCache extends Context.Service<HttpResponseCache, IHttpResponseCache>()(
  "@cf-twitch/HttpResponseCache",
) {}

const cacheFailure = () =>
  new HttpBoundaryError({ status: 502, error: "Invalid service response" });
const ignoreCacheFailure = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.catch(() => Effect.void));

/** Cache binding is acquired by the root, not read from ambient globals inside handlers. */
export const httpResponseCacheLayer = (
  cache: Pick<Cache, "match" | "put" | "delete">,
): Layer.Layer<HttpResponseCache> =>
  Layer.succeed(
    HttpResponseCache,
    HttpResponseCache.of({
      readThrough: Effect.fn("HttpResponseCache.readThrough")(function* <A, E, R>(input: {
        readonly key: string;
        readonly schema: Schema.ConstraintCodec<A, unknown, never, never>;
        readonly load: Effect.Effect<A, E, R>;
      }) {
        const request = new Request(input.key);
        const cached = yield* Effect.tryPromise({
          try: () => cache.match(request),
          catch: cacheFailure,
        }).pipe(Effect.option);
        if (Option.isSome(cached) && cached.value !== undefined) {
          const response = cached.value;
          const decoded = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: cacheFailure,
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(input.schema, { onExcessProperty: "error" })),
            Effect.option,
          );
          if (Option.isSome(decoded)) return decoded.value;
          yield* ignoreCacheFailure(
            Effect.tryPromise({ try: () => cache.delete(request), catch: cacheFailure }),
          );
        }
        const value = yield* input.load;
        const encoded = yield* Schema.encodeEffect(input.schema)(value).pipe(
          Effect.mapError(cacheFailure),
        );
        // Await the bounded Cache API write so it survives request completion without a detached fiber.
        yield* ignoreCacheFailure(
          Effect.tryPromise({
            try: () =>
              cache.put(
                request,
                Response.json(encoded, {
                  headers: { "Cache-Control": "public, max-age=60", Vary: "Accept-Encoding" },
                }),
              ),
            catch: cacheFailure,
          }),
        );
        return value;
      }),
    }),
  );
