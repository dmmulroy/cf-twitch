import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { executeProviderRequest } from "./provider-http.ts";

const executeRateLimitedRequest = (retryAfter: string | undefined) => {
  const request = HttpClientRequest.get("https://provider.invalid/rate-limit");

  const client = HttpClient.make((outgoing) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        outgoing,
        Response.json(
          { error: "rate-limited" },
          {
            status: 429,
            headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
          },
        ),
      ),
    ),
  );

  return executeProviderRequest(client, {
    provider: "spotify",
    operation: "testRateLimit",
    request,
    mutation: false,
    notFound: "not-found",
  }).pipe(Effect.result);
};

it.effect("provider Retry-After accepts seconds and bounds invalid numeric values", () =>
  Effect.gen(function* () {
    for (const [header, expected] of [
      ["12", 12_000],
      ["0.001", 1],
      ["0", 1000],
      ["-2", 1000],
      ["1000000", 900_000],
    ] as const) {
      const result = yield* executeRateLimitedRequest(header);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind: "rate-limited", retryAfterMs: Option.some(expected) },
      });
    }
  }),
);

it.effect("provider Retry-After accepts HTTP dates with deterministic bounds", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);

    for (const [header, expected] of [
      ["Thu, 01 Jan 1970 00:10:00 GMT", 600_000],
      ["Thu, 01 Jan 1970 00:00:00 GMT", 1000],
      ["Thu, 01 Jan 1970 01:00:00 GMT", 900_000],
      ["not-a-date", 1000],
      [undefined, 1000],
    ] as const) {
      const result = yield* executeRateLimitedRequest(header);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind: "rate-limited", retryAfterMs: Option.some(expected) },
      });
    }
  }),
);
