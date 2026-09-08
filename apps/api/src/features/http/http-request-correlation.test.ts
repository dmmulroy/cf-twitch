import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  ErrorReporter,
  Exit,
  Layer,
  Option,
  Predicate,
  Redacted,
  Tracer,
} from "effect";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter } from "effect/unstable/http";
import { TwitchOAuthApi } from "@cf-twitch/contracts/twitch-api";
import { OAuthAuthorization } from "../oauth/oauth-authorization.ts";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { twitchHttpTelemetrySafetyLayer } from "../../runtime/twitch-telemetry.ts";
import { twitchOAuthHandlersLayer } from "./twitch-oauth-handlers.ts";
import { twitchHttpCorrelationLayer } from "./http-request-correlation.ts";
import { httpTestConfiguration } from "./http-test-fixtures.ts";

const oauthApi = HttpApi.make("TwitchHttpApi").add(TwitchOAuthApi);

const findResponseSpan = (spans: readonly Tracer.NativeSpan[], response: Response | undefined) =>
  spans.find((span) => span.traceId === response?.headers.get("x-trace-id"));

const readSpanInterruptors = (span: Tracer.NativeSpan | undefined) =>
  span?.status._tag === "Ended" && Exit.isFailure(span.status.exit)
    ? [...Cause.interruptors(span.status.exit.cause)]
    : [];

const readExportedFailureExits = (spans: readonly Tracer.NativeSpan[]) =>
  spans.flatMap((span) =>
    span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
      ? Cause.prettyErrors(span.status.exit.cause, { includeCauseInStack: true }).map((error) => ({
          name: error.name,
          message: error.message,
          stack: error.stack,
        }))
      : [],
  );

const expectResponseCorrelations = (
  serverSpans: readonly Tracer.NativeSpan[],
  responses: readonly Response[],
) => {
  for (const response of responses) {
    const matching = findResponseSpan(serverSpans, response);
    expect(matching?.name).toBe("HTTP request");
    expect(matching?.status._tag).toBe("Ended");
    expect(matching?.attributes.get("request_id")).toBe(response.headers.get("x-request-id"));
    expect(matching?.attributes.get("cf_twitch.runtime.component")).toBe("api-worker");
    expect(matching?.attributes.get("http.response.status_code")).toBe(response.status);
  }
};

const expectSafeErrorReports = (reports: readonly Error[], responses: readonly Response[]) => {
  expect(reports.map((report) => report.message)).toEqual([
    "HTTP request failed",
    "HTTP request failed",
  ]);
  for (const [index, report] of reports.entries()) {
    expect(ErrorReporter.getAttributes(report)).toMatchObject({
      "http.failure.classification": "defect",
      "http.response.status_code": 500,
      request_id: responses[index + 3]?.headers.get("x-request-id"),
      trace_id: responses[index + 3]?.headers.get("x-trace-id"),
    });
    expect(Predicate.hasProperty(report, "redactedCause")).toBe(true);
    if (Predicate.hasProperty(report, "redactedCause"))
      expect(Redacted.isRedacted(report.redactedCause)).toBe(true);
  }
};

describe("safe HTTP trace export", () => {
  it.effect(
    "correlates responses and sanitizes RouteNotFound and defect exits before OTLP serialization",
    () =>
      Effect.gen(function* () {
        const spans: Tracer.NativeSpan[] = [];
        const reports: Error[] = [];
        const reporter = ErrorReporter.make(({ error }) => reports.push(error));
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const state = "11111111-1111-4111-8111-111111111111";
        const location = `https://accounts.spotify.com/authorize?state=${state}&sensitive-location=never-collect-location`;
        const api = HttpApiBuilder.layer(oauthApi).pipe(
          Layer.provide(
            twitchOAuthHandlersLayer.pipe(
              Layer.provide(ErrorReporter.layer([] satisfies readonly [])),
            ),
          ),
          Layer.provide(twitchHttpCorrelationLayer),
          Layer.provide([
            cloudflareHttpServerLayer,
            Layer.succeed(TwitchConfiguration, httpTestConfiguration),
            Layer.mock(OAuthAuthorization, {
              beginAuthorization: (input) => {
                if (input.provider !== "twitch")
                  return Effect.succeed({
                    state: Redacted.make(state),
                    authorizationUrl: Redacted.make(location),
                  });
                if (input.redirectUri.startsWith("http://"))
                  return Effect.failCause(
                    Cause.fromReasons([
                      Cause.makeDieReason("never-collect-mixed-defect-secret"),
                      Cause.makeInterruptReason(777),
                    ]),
                  );
                return input.redirectUri.startsWith("https://interrupted.")
                  ? Effect.failCause(Cause.interrupt(888))
                  : Effect.die("never-collect-defect-secret");
              },
              consumeAuthorizationState: () => Effect.succeed("ok"),
              exchangeAuthorizationCode: () =>
                Effect.succeed({
                  accessToken: Redacted.make("never-collect-token"),
                  refreshToken: Option.none(),
                  tokenType: "bearer",
                  expiresIn: 3600,
                  scopes: [],
                }),
            }),
          ]),
          // Expose these references to toWebHandler itself, not just the user route body.
          Layer.provideMerge(twitchHttpTelemetrySafetyLayer),
          Layer.provideMerge(ErrorReporter.layer([reporter])),
          Layer.provideMerge(Layer.succeed(Tracer.Tracer, tracer)),
        );
        const responses: Response[] = [];
        yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(api, { disableLogger: true })),
          ({ handler }) =>
            Effect.gen(function* () {
              responses.push(
                yield* Effect.promise(() =>
                  handler(
                    new Request(
                      "https://worker.test/oauth/spotify/authorize?setup_secret=never-collect-query-secret",
                      {
                        headers: {
                          "x-setup-secret": "setup-secret",
                          "user-agent": "never-collect-user-agent",
                          "x-private": "never-collect-private-header",
                        },
                      },
                    ),
                  ),
                ),
              );
              responses.push(
                yield* Effect.promise(() =>
                  handler(
                    new Request(
                      `https://worker.test/oauth/spotify/callback?state=${state}&code=never-collect-code`,
                    ),
                  ),
                ),
              );
              responses.push(
                yield* Effect.promise(() =>
                  handler(
                    new Request(
                      "https://worker.test/not-found?private=never-collect-not-found-query",
                    ),
                  ),
                ),
              );
              responses.push(
                yield* Effect.promise(() =>
                  handler(
                    new Request("https://worker.test/oauth/twitch/authorize", {
                      headers: { "x-setup-secret": "setup-secret" },
                    }),
                  ),
                ),
              );
              responses.push(
                yield* Effect.promise(() =>
                  handler(
                    new Request("http://worker.test/oauth/twitch/authorize", {
                      headers: { "x-setup-secret": "setup-secret" },
                    }),
                  ),
                ),
              );
              responses.push(
                yield* Effect.promise(() =>
                  handler(
                    new Request("https://interrupted.worker.test/oauth/twitch/authorize", {
                      headers: { "x-setup-secret": "setup-secret" },
                    }),
                  ),
                ),
              );
            }),
          ({ dispose }) => Effect.promise(dispose),
        );
        expect(responses.map((response) => response.status)).toEqual([
          302, 200, 404, 500, 500, 503,
        ]);
        expect(responses[0]?.headers.get("location")).toBe(location);
        const serverSpans = spans.filter((span) => span.kind === "server");
        expect(serverSpans).toHaveLength(6);
        expectResponseCorrelations(serverSpans, responses.slice(0, 5));
        expect(serverSpans[2]?.attributes.get("http.failure.classification")).toBe(
          "expected_http_failure",
        );
        expect(serverSpans[3]?.attributes.get("http.failure.classification")).toBe("defect");
        expect(serverSpans[4]?.attributes.get("http.failure.classification")).toBe("defect");
        const exportedFailureExits = readExportedFailureExits(serverSpans.slice(0, 5));
        expect(exportedFailureExits).toHaveLength(3);
        expect(exportedFailureExits.every((error) => error.message === "HTTP request failed")).toBe(
          true,
        );
        const mixedFailureSpan = findResponseSpan(serverSpans, responses[4]);
        expect(readSpanInterruptors(mixedFailureSpan)).toEqual([777]);
        const interruptedSpan = findResponseSpan(serverSpans, responses[5]);
        expect(
          interruptedSpan?.status._tag === "Ended" && Exit.isFailure(interruptedSpan.status.exit)
            ? Cause.hasInterruptsOnly(interruptedSpan.status.exit.cause)
            : false,
        ).toBe(true);
        expect(readSpanInterruptors(interruptedSpan)).toEqual([888]);
        expectSafeErrorReports(reports, responses);
        const collected = JSON.stringify({
          reports,
          spans: spans.map((span) => ({
            name: span.name,
            attributes: Array.from(span.attributes),
            events: span.events.map(([name, , attributes]) => ({ name, attributes })),
          })),
          exportedFailureExits,
        });
        for (const secret of [
          state,
          "setup-secret",
          "never-collect",
          "never-collect-defect-secret",
          "never-collect-mixed-defect-secret",
          "url.full",
          "url.query",
          "http.request.header",
          "http.response.header",
        ])
          expect(collected).not.toContain(secret);
      }),
  );
});
