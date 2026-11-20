import { ErrorReporter, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { TwitchHttpApi } from "@cf-twitch/contracts/twitch-api";
import { twitchHttpCorrelationLayer } from "./http-request-correlation.ts";
import { twitchPublicHandlersLayer } from "./twitch-public-handlers.ts";
import { twitchStatsHandlersLayer } from "./twitch-stats-handlers.ts";
import { twitchAdminHandlersLayer } from "./twitch-admin-handlers.ts";
import { twitchDebugHandlersLayer } from "./twitch-debug-handlers.ts";
import { twitchOAuthHandlersLayer } from "./twitch-oauth-handlers.ts";
import { twitchEventSubHandlersLayer } from "./twitch-eventsub-handlers.ts";
import { twitchOverlayHandlersLayer } from "./twitch-overlay-handlers.ts";

/** Layer that merges every public handler group; service providers are chosen only by the Worker root. */
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

/**
 * Layer that registers the complete public API with `HttpRouter`, behind request correlation.
 *
 * **Details**
 *
 * The correlation middleware assigns `x-request-id` and `x-trace-id`, renders unmatched routes and
 * defects as public error bodies, and reports failures with redacted causes. Handler groups use
 * empty error reporters so only the outer boundary reports.
 */
export const twitchHttpApiLayer = HttpApiBuilder.layer(TwitchHttpApi).pipe(
  Layer.provide(twitchGeneratedHandlersLayer),
  Layer.provide(twitchHttpCorrelationLayer),
);
