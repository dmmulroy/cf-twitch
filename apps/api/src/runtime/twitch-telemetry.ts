import * as Alchemy from "alchemy";
import { Config, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpMiddleware } from "effect/http";

/** Layer that disables automatic HTTP payload metadata collection so application spans allowlist safe attributes. */
export const twitchHttpTelemetrySafetyLayer = Layer.mergeAll(
  Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true),
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

const telemetryServiceName = "cf-twitch-api-worker";

/**
 * Layer that binds optional OTLP export during init; Alchemy flushes telemetry in each invocation scope.
 *
 * **Details**
 *
 * Reads `CF_TWITCH_OTLP_ENDPOINT` and optional `CF_TWITCH_OTLP_TOKEN`; without an endpoint it uses
 * Alchemy's default OTLP destination.
 *
 * @throws A defect when `CF_TWITCH_OTLP_ENDPOINT` is not a URL or a setting cannot be read.
 */
export const twitchTelemetryLayer = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* Config.option(Config.URL("CF_TWITCH_OTLP_ENDPOINT"));
    const token = yield* Config.option(Config.Redacted("CF_TWITCH_OTLP_TOKEN"));

    if (Option.isNone(endpoint)) {
      return Alchemy.Telemetry.layerOtlp({ serviceName: telemetryServiceName });
    }

    if (Option.isNone(token)) {
      return Alchemy.Telemetry.layerOtlp({
        serviceName: telemetryServiceName,
        url: endpoint.value.href,
      });
    }

    return Alchemy.Telemetry.layerOtlp({
      serviceName: telemetryServiceName,
      url: endpoint.value.href,
      headers: { Authorization: Redacted.make(`Bearer ${Redacted.value(token.value)}`) },
    });
  }).pipe(
    Effect.catchTag("ConfigError", () =>
      Effect.die(
        "Twitch telemetry configuration is invalid because CF_TWITCH_OTLP_ENDPOINT is not a URL or the OTLP settings cannot be read. Set CF_TWITCH_OTLP_ENDPOINT to an absolute URL and restart the Worker.",
      ),
    ),
  ),
);
