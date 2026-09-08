import { Cause, Clock, Data, Effect, ErrorReporter, Redacted } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpRequestCorrelation } from "./http-boundary.ts";

class HttpTraceFailure
  extends Data.TaggedError("HttpTraceFailure")<{
    readonly classification: "defect" | "expected_http_failure";
    readonly redactedCause: Redacted.Redacted<Cause.Cause<unknown>>;
    readonly requestId: string;
    readonly response: HttpServerResponse.HttpServerResponse;
    readonly traceId: string;
  }>
  implements HttpServerRespondable.Respondable
{
  override readonly [ErrorReporter.ignore] = this.classification === "expected_http_failure";
  override readonly [ErrorReporter.severity] = "Error" as const;
  override readonly [ErrorReporter.attributes] = {
    "http.failure.classification": this.classification,
    "http.response.status_code": this.response.status,
    request_id: this.requestId,
    trace_id: this.traceId,
  };

  override get message(): string {
    return "HTTP request failed";
  }

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(this.response);
  }
}

/** Safe server tracing omits header values, full URLs, query values and response Location credentials. */
export const twitchHttpCorrelationLayer = HttpRouter.middleware<{
  provides: HttpRequestCorrelation;
  handles: HttpServerError.HttpServerError;
}>()(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.originalUrl, "https://http.internal");
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* Effect.gen(function* () {
        const span = yield* Effect.currentSpan.pipe(Effect.orDie);
        const requestId = yield* Effect.sync(() => crypto.randomUUID());
        const correlation = { requestId, traceId: span.traceId };
        const annotations = { request_id: requestId, "cf_twitch.runtime.component": "api-worker" };
        yield* Effect.annotateCurrentSpan(annotations);
        yield* Effect.logInfo("HTTP request received").pipe(
          Effect.annotateLogs({
            event: "http.request.received",
            request_id: requestId,
            trace_id: span.traceId,
            method: request.method,
            path: url.pathname,
            query_keys: [...url.searchParams.keys()].sort(),
          }),
        );
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(
            HttpServerResponse.setHeaders(response, {
              "x-request-id": requestId,
              "x-trace-id": span.traceId,
            }),
          ),
        );
        const completeRequest = (status: number) =>
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan("http.response.status_code", status);
            const completedAt = yield* Clock.currentTimeMillis;
            yield* Effect.logInfo("HTTP request completed").pipe(
              Effect.annotateLogs({
                event: "http.request.completed",
                status_code: status,
                duration_ms: completedAt - startedAt,
              }),
            );
          });
        const failHttpTrace = <E>(
          response: HttpServerResponse.HttpServerResponse,
          classification: "defect" | "expected_http_failure",
          cause: Cause.Cause<E>,
        ) => {
          const failure = new HttpTraceFailure({
            classification,
            redactedCause: Redacted.make(cause),
            requestId,
            response,
            traceId: span.traceId,
          });
          const safeCause = Cause.fromReasons([
            Cause.makeFailReason(failure),
            ...cause.reasons.filter(Cause.isInterruptReason),
          ]);
          return Effect.annotateCurrentSpan("http.failure.classification", classification).pipe(
            Effect.andThen(completeRequest(response.status)),
            Effect.andThen(Effect.failCause(safeCause)),
          );
        };
        return yield* httpEffect.pipe(
          Effect.provideService(HttpRequestCorrelation, correlation),
          Effect.catchCauseIf(Cause.hasDies, (cause) =>
            failHttpTrace(
              HttpServerResponse.jsonUnsafe({ error: "Internal server error" }, { status: 500 }),
              "defect",
              cause,
            ),
          ),
          Effect.catchTag("HttpServerError", (error) => {
            const cause = Cause.fail(error);
            return HttpServerError.causeResponse(cause).pipe(
              Effect.flatMap(([response]) =>
                failHttpTrace(response, "expected_http_failure", cause),
              ),
            );
          }),
          Effect.tap((response) => completeRequest(response.status)),
          Effect.annotateSpans(annotations),
          Effect.annotateLogs({ request_id: requestId, trace_id: span.traceId }),
        );
      }).pipe(
        Effect.withSpan("HTTP request", {
          kind: "server",
          attributes: { "http.request.method": request.method, "url.path": url.pathname },
        }),
        Effect.withErrorReporting,
        Effect.catchTag("HttpTraceFailure", (failure) => {
          const interrupts = Redacted.value(failure.redactedCause).reasons.filter(
            Cause.isInterruptReason,
          );
          return interrupts.length > 0
            ? Effect.failCause(
                Cause.fromReasons<never>([Cause.makeDieReason(failure), ...interrupts]),
              )
            : Effect.succeed(failure.response);
        }),
      );
    }),
  { global: true },
);
