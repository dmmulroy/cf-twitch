import { ProviderError, type OAuthProvider } from "@cf-twitch/contracts/provider";
import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/** Provider HTTP status and transport classification never retains secret requests or response bodies. */
export const executeProviderRequest = Effect.fn("ProviderHttp.executeProviderRequest")(function* (
  client: HttpClient.HttpClient,
  input: {
    readonly provider: OAuthProvider;
    readonly operation: string;
    readonly request: HttpClientRequest.HttpClientRequest;
    readonly mutation: boolean;
    readonly notFound: "not-found" | "no-active-device";
  },
) {
  yield* Effect.annotateCurrentSpan({ provider: input.provider, operation: input.operation });
  const response = yield* client.execute(input.request).pipe(
    // Default HTTP spans collect full URLs and every header, including client-token.
    // Keep the safe named operation span while preventing sensitive transport collection.
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.timeout("30 seconds"),
    Effect.mapError(
      () =>
        new ProviderError({
          provider: input.provider,
          operation: input.operation,
          kind: input.mutation ? "outcome-unknown" : "network",
          status: 0,
          retryAfterMs: Option.none(),
        }),
    ),
  );
  if (response.status >= 200 && response.status < 300) return response;
  const seconds = Number(response.headers["retry-after"]);
  const retryAfterMs =
    Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds * 1000), 900_000) : 1000;
  return yield* Effect.fail(
    new ProviderError({
      provider: input.provider,
      operation: input.operation,
      status: response.status,
      kind: HttpClientResponse.matchStatus(response, {
        429: () => "rate-limited" as const,
        401: () => "unauthorized" as const,
        404: () => input.notFound,
        orElse: (response): ProviderError["kind"] => {
          if (response.status >= 500) return input.mutation ? "outcome-unknown" : "network";

          return "rejected";
        },
      }),
      retryAfterMs: response.status === 429 ? Option.some(retryAfterMs) : Option.none(),
    }),
  );
});

/** Confirm the documented success statuses before acknowledging a bodyless provider mutation. */
export const confirmProviderMutationStatus = (
  response: HttpClientResponse.HttpClientResponse,
  input: {
    readonly provider: OAuthProvider;
    readonly operation: string;
    readonly statuses: readonly number[];
  },
): Effect.Effect<void, ProviderError> =>
  input.statuses.includes(response.status)
    ? Effect.void
    : Effect.fail(
        new ProviderError({
          provider: input.provider,
          operation: input.operation,
          status: response.status,
          kind: "outcome-unknown",
          retryAfterMs: Option.none(),
        }),
      );

/** Decode provider success evidence without including raw malformed payloads in failures. */
export const decodeProviderResponse = <A, I>(
  schema: Schema.Codec<A, I>,
  input: {
    readonly provider: OAuthProvider;
    readonly operation: string;
    readonly mutation: boolean;
  },
) => {
  const decode = HttpClientResponse.schemaBodyJson(schema);
  return (response: HttpClientResponse.HttpClientResponse): Effect.Effect<A, ProviderError> =>
    decode(response).pipe(
      Effect.mapError(
        () =>
          new ProviderError({
            provider: input.provider,
            operation: input.operation,
            kind: input.mutation ? "outcome-unknown" : "invalid-response",
            status: response.status,
            retryAfterMs: Option.none(),
          }),
      ),
    );
};
