import { Effect, FileSystem, Layer, Path } from "effect";
import { Etag, HttpPlatform } from "effect/http";

const cloudflareHttpPlatformLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: () =>
      Effect.die(
        "CF Twitch HTTP compression is not supported by the Cloudflare platform layer. Return the response uncompressed and let Cloudflare compress it.",
      ),
  },
  fileResponse: () =>
    Effect.die(
      "CF Twitch HTTP filesystem responses are not supported on Cloudflare Workers. Return the file body from storage as an ordinary response.",
    ),
  fileWebResponse: () =>
    Effect.die(
      "CF Twitch HTTP web file responses are not supported on Cloudflare Workers. Return the file body as an ordinary response.",
    ),
});

/**
 * Layer of Cloudflare HTTP facilities for Worker and Durable Object APIs, without filesystem serving.
 *
 * **Gotchas**
 *
 * Response compression and file responses are unsupported.
 *
 * @throws A defect when a handler requests response compression or a file response.
 */
export const cloudflareHttpServerLayer = Layer.mergeAll(
  Etag.layer,
  FileSystem.layerNoop({}),
  cloudflareHttpPlatformLayer,
  Path.layer,
);
