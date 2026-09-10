import { Effect, FileSystem, Layer, Path } from "effect";
import { Etag, HttpPlatform } from "effect/unstable/http";

const cloudflareHttpPlatformLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: () =>
      Effect.die("CF Twitch HTTP compression is not supported by this platform"),
  },
  fileResponse: () => Effect.die("CF Twitch HTTP filesystem responses are not supported"),
  fileWebResponse: () => Effect.die("CF Twitch HTTP web file responses are not supported"),
});

/** Cloudflare HTTP facilities for Worker and Durable Object APIs; no filesystem serving. */
export const cloudflareHttpServerLayer = Layer.mergeAll(
  Etag.layer,
  FileSystem.layerNoop({}),
  cloudflareHttpPlatformLayer,
  Path.layer,
);
