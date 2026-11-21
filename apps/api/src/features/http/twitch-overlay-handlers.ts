import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerResponse } from "effect/http";
import { TwitchHttpApi } from "@cf-twitch/contracts/twitch-api";
import { nowPlayingOverlayHtml } from "./now-playing-overlay.ts";

/** Layer that serves the static OBS overlay HTML; provider metadata enters the DOM only via `textContent`. */
export const twitchOverlayHandlersLayer = HttpApiBuilder.group(
  TwitchHttpApi,
  "overlay",
  (handlers) =>
    handlers.handleRaw("nowPlayingOverlay", () =>
      Effect.succeed(
        HttpServerResponse.text(nowPlayingOverlayHtml, { contentType: "text/html; charset=UTF-8" }),
      ),
    ),
);
