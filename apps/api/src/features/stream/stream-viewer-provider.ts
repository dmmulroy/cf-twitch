import { Context, Effect, Layer, Option } from "effect";
import type { NonNegativeInt } from "@cf-twitch/contracts/identity";
import { StreamLifecycleError } from "@cf-twitch/contracts/stream";
import {
  TwitchConfiguration,
  twitchConfigurationLayer,
} from "../../runtime/twitch-configuration.ts";
import { TwitchService, twitchServiceLayer } from "../providers/twitch-service.ts";

/** Viewer-count observation used by the Stream Lifecycle viewer polling alarm. */
export interface IStreamViewerProvider {
  /**
   * Returns the broadcaster's current viewer count.
   *
   * @returns The count, none when Twitch reports no live stream, or fails with
   *   `StreamLifecycleError` whose reason is `provider_unavailable` when Twitch cannot be read.
   */
  readonly getViewerCount: () => Effect.Effect<Option.Option<NonNegativeInt>, StreamLifecycleError>;
}

/** Service for the provider-backed viewer-count observation. */
export class StreamViewerProvider extends Context.Service<
  StreamViewerProvider,
  IStreamViewerProvider
>()("@cf-twitch/StreamViewerProvider") {}

/**
 * Creates the viewer provider over the Twitch provider for the configured broadcaster.
 *
 * @returns The viewer provider; `getViewerCount` fails with `StreamLifecycleError` when the Twitch
 *   stream lookup fails.
 */
export const makeStreamViewerProvider = Effect.gen(function* () {
  const twitch = yield* TwitchService;
  const configuration = yield* TwitchConfiguration;

  return StreamViewerProvider.of({
    getViewerCount: Effect.fn("StreamViewerProvider.getViewerCount")(() =>
      twitch.getStreamInfo(configuration.twitch.broadcaster.displayName).pipe(
        Effect.map((stream) => Option.map(stream, (value) => value.viewerCount)),
        Effect.catchTag("ProviderError", () =>
          Effect.fail(
            new StreamLifecycleError({
              operation: "pollViewerCount",
              reason: "provider_unavailable",
            }),
          ),
        ),
      ),
    ),
  });
});

/** Layer that provides the viewer provider, leaving the Twitch provider and configuration visible. */
export const streamViewerProviderLayerWithoutDependencies = Layer.effect(
  StreamViewerProvider,
  makeStreamViewerProvider,
);

/**
 * Layer that provides the viewer provider over the production Twitch provider and configuration.
 *
 * **Gotchas**
 *
 * The `StreamLifecycleDO` server captures Twitch during outer initialization and bridges it into
 * `streamViewerProviderLayerWithoutDependencies` instead, so this Layer is not built at runtime.
 */
export const streamViewerProviderLayer = streamViewerProviderLayerWithoutDependencies.pipe(
  Layer.provide([twitchServiceLayer, twitchConfigurationLayer]),
);

/** Layer that provides a controlled viewer provider observing no live stream. */
export const streamViewerProviderTestLayer = Layer.succeed(
  StreamViewerProvider,
  StreamViewerProvider.of({ getViewerCount: () => Effect.succeed(Option.none()) }),
);
