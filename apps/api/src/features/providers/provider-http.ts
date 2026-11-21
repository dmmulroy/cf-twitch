import {
  ProviderError,
  type OAuthProvider,
  type ProviderFailureReason,
  type ProviderOperation,
} from "@cf-twitch/contracts/provider";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** Provider request whose response is classified into success or a `ProviderError`. */
export interface ProviderHttpRequest {
  /** Provider that receives the request. */
  readonly provider: OAuthProvider;
  /** Provider operation reported in spans and failures. */
  readonly operation: ProviderOperation;
  /** Fully built outgoing request, including credentials. */
  readonly request: HttpClientRequest.HttpClientRequest;
  /** Whether the request changes provider state, which turns lost or 5xx responses into `outcome-unknown`. */
  readonly mutation: boolean;
  /** Reason reported for HTTP 404, which Spotify player endpoints use for a missing active device. */
  readonly notFound: "not-found" | "no-active-device";
}

/**
 * Executes a provider request and classifies its HTTP status without retaining secret requests or response bodies.
 *
 * **Details**
 *
 * Default HTTP tracing is disabled so authorization headers and URLs are never collected. Requests time out after 30 seconds.
 *
 * @returns The 2xx response, or fails with `ProviderError`: `network` (or `outcome-unknown` for a mutation) when the transport fails or times out, `rate-limited` for 429 with its retry delay, `unauthorized` for 401, `input.notFound` for 404, `network`/`outcome-unknown` for 5xx, and `rejected` otherwise.
 */
export const executeProviderRequest = Effect.fn("ProviderHttp.executeProviderRequest")(function* (
  client: HttpClient.HttpClient,
  input: ProviderHttpRequest,
) {
  yield* Effect.annotateCurrentSpan({ provider: input.provider, operation: input.operation });

  const response = yield* client.execute(input.request).pipe(
    // Default HTTP spans collect full URLs and every header, including client-token.
    // Keep the safe named operation span while preventing sensitive transport collection.
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.timeout("30 seconds"),
    Effect.catchTags({
      HttpClientError: () => Effect.fail(providerTransportFailure(input)),
      TimeoutError: () => Effect.fail(providerTransportFailure(input)),
    }),
  );

  if (response.status >= 200 && response.status < 300) return response;

  const retryAfterMs =
    response.status === 429
      ? yield* parseProviderRetryAfter(Option.fromUndefinedOr(response.headers["retry-after"]))
      : Option.none<number>();

  return yield* Effect.fail(
    new ProviderError({
      provider: input.provider,
      operation: input.operation,
      status: Option.some(response.status),
      reason: HttpClientResponse.matchStatus(response, {
        429: (): ProviderFailureReason => "rate-limited",
        401: (): ProviderFailureReason => "unauthorized",
        404: (): ProviderFailureReason => input.notFound,
        orElse: (response): ProviderFailureReason => {
          if (response.status >= 500) return input.mutation ? "outcome-unknown" : "network";

          return "rejected";
        },
      }),
      retryAfterMs,
    }),
  );
});

const providerTransportFailure = (input: ProviderHttpRequest) =>
  new ProviderError({
    provider: input.provider,
    operation: input.operation,
    reason: input.mutation ? "outcome-unknown" : "network",
    status: Option.none(),
    retryAfterMs: Option.none(),
  });

/** Parses a `Retry-After` header given in seconds or as an HTTP date into a bounded delay of 1 second to 15 minutes. */
const parseProviderRetryAfter = Effect.fn("ProviderHttp.parseProviderRetryAfter")(function* (
  header: Option.Option<string>,
) {
  if (Option.isNone(header)) return Option.some(1000);
  const seconds = Number(header.value);

  if (Number.isFinite(seconds))
    return Option.some(seconds > 0 ? Math.min(Math.ceil(seconds * 1000), 900_000) : 1000);

  const retryAt = DateTime.make(header.value);

  if (Option.isNone(retryAt)) return Option.some(1000);
  const now = yield* Clock.currentTimeMillis;

  return Option.some(
    Math.min(Math.max(Math.ceil(DateTime.toEpochMillis(retryAt.value) - now), 1000), 900_000),
  );
});

/**
 * Confirms that a bodyless provider mutation response has one of its documented success statuses.
 *
 * @returns Nothing, or fails with `ProviderError` reason `outcome-unknown` when the status is undocumented, because the mutation may or may not have happened.
 */
export const confirmProviderMutationStatus = (
  response: HttpClientResponse.HttpClientResponse,
  input: {
    readonly provider: OAuthProvider;
    readonly operation: ProviderOperation;
    readonly statuses: readonly number[];
  },
): Effect.Effect<void, ProviderError> =>
  input.statuses.includes(response.status)
    ? Effect.void
    : Effect.fail(
        new ProviderError({
          provider: input.provider,
          operation: input.operation,
          status: Option.some(response.status),
          reason: "outcome-unknown",
          retryAfterMs: Option.none(),
        }),
      );

/**
 * Creates a decoder of provider success JSON that never includes the raw malformed payload in failures.
 *
 * @returns A decoder whose result is the parsed body, or fails with `ProviderError` reason `invalid-response` (or `outcome-unknown` for a mutation) when the body does not match the schema.
 */
export const decodeProviderResponse = <A, I>(
  schema: Schema.Codec<A, I>,
  input: {
    readonly provider: OAuthProvider;
    readonly operation: ProviderOperation;
    readonly mutation: boolean;
  },
) => {
  const decode = HttpClientResponse.schemaBodyJson(schema);

  return (response: HttpClientResponse.HttpClientResponse): Effect.Effect<A, ProviderError> =>
    decode(response).pipe(
      Effect.catchTags({
        HttpClientError: () => Effect.fail(providerDecodeFailure(input, response)),
        SchemaError: () => Effect.fail(providerDecodeFailure(input, response)),
      }),
    );
};

const providerDecodeFailure = (
  input: {
    readonly provider: OAuthProvider;
    readonly operation: ProviderOperation;
    readonly mutation: boolean;
  },
  response: HttpClientResponse.HttpClientResponse,
) =>
  new ProviderError({
    provider: input.provider,
    operation: input.operation,
    reason: input.mutation ? "outcome-unknown" : "invalid-response",
    status: Option.some(response.status),
    retryAfterMs: Option.none(),
  });
