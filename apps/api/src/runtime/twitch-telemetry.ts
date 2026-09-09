import * as Alchemy from "alchemy";
import { Config, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpMiddleware } from "effect/unstable/http";

/** Disable automatic HTTP payload metadata collection; application spans allowlist safe attributes. */
export const twitchHttpTelemetrySafetyLayer = Layer.mergeAll(
  Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true),
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

const telemetryServiceName = "cf-twitch-api-worker";

/** Bind optional OTLP export during init; Alchemy flushes telemetry in each invocation scope. */
export const twitchTelemetryLayer = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* Config.option(Config.url("CF_TWITCH_OTLP_ENDPOINT"));
    const token = yield* Config.option(Config.redacted("CF_TWITCH_OTLP_TOKEN"));

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
        "Twitch telemetry configuration is invalid. Check the OTLP endpoint and token settings.",
      ),
    ),
  ),
);
