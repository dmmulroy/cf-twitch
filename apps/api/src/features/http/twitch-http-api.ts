import { ErrorReporter, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { TwitchHttpApi } from "@cf-twitch/contracts/twitch-api";
import { twitchHttpCorrelationLayer } from "./http-request-correlation.ts";
import { twitchPublicHandlersLayer } from "./twitch-public-handlers.ts";
import { twitchStatsHandlersLayer } from "./twitch-stats-handlers.ts";
import { twitchAdminHandlersLayer } from "./twitch-admin-handlers.ts";
import { twitchDebugHandlersLayer } from "./twitch-debug-handlers.ts";
import { twitchOAuthHandlersLayer } from "./twitch-oauth-handlers.ts";
import { twitchEventSubHandlersLayer } from "./twitch-eventsub-handlers.ts";
import { twitchOverlayHandlersLayer } from "./twitch-overlay-handlers.ts";

/** All external handler groups; service providers are deliberately chosen only by the Worker root. */
export const twitchHttpHandlersLayer = Layer.mergeAll(
  twitchPublicHandlersLayer,
  twitchStatsHandlersLayer,
  twitchAdminHandlersLayer,
  twitchDebugHandlersLayer,
  twitchOAuthHandlersLayer,
  twitchEventSubHandlersLayer,
  twitchOverlayHandlersLayer,
);

const twitchGeneratedHandlersLayer = twitchHttpHandlersLayer.pipe(
  Layer.provide(ErrorReporter.layer([] satisfies readonly [])),
);

/** Register the complete compatibility API with HttpRouter; no legacy router or provider is hidden here. */
export const twitchHttpApiLayer = HttpApiBuilder.layer(TwitchHttpApi).pipe(
  Layer.provide(twitchGeneratedHandlersLayer),
  Layer.provide(twitchHttpCorrelationLayer),
);
