import { Effect, Schema } from "effect";

/** A staged E2E request could not establish or complete its HTTP response headers. */
export class E2eHttpRequestError extends Schema.TaggedError<E2eHttpRequestError>()(
  "E2eHttpRequestError",
  {
    /** E2E helper that sent the request. */
    operation: Schema.Literals(["fetchE2eResponse", "fetchE2eText"]),
    /** The request could not be sent or its response headers did not arrive. */
    reason: Schema.Literal("RequestFailed"),
    /** HTTP method of the staged request. */
    method: Schema.String,
    /** Local test Worker URL of the staged request. */
    url: Schema.String,
    /** Rejection from `fetch`, kept for diagnosis. */
    cause: Schema.Unknown,
  },
) {
  /** Failure summary naming the request method and URL. */
  override get message(): string {
    return `E2E HTTP ${this.method} request failed for ${this.url} during ${this.operation}. Check that the local test Worker is running, then rerun the suite.`;
  }
}

/** A staged E2E response disconnected or otherwise failed while its body was being read. */
export class E2eHttpResponseBodyError extends Schema.TaggedError<E2eHttpResponseBodyError>()(
  "E2eHttpResponseBodyError",
  {
    /** E2E helper that read the body. */
    operation: Schema.Literal("fetchE2eText"),
    /** The response body failed while being read. */
    reason: Schema.Literal("BodyReadFailed"),
    /** HTTP method of the staged request. */
    method: Schema.String,
    /** Local test Worker URL of the staged request. */
    url: Schema.String,
    /** Rejection from reading the body, kept for diagnosis. */
    cause: Schema.Unknown,
  },
) {
  /** Failure summary naming the request method and URL whose body failed. */
  override get message(): string {
    return `E2E HTTP ${this.method} response body failed for ${this.url} during ${this.operation}. Check the local Worker logs for a dropped connection, then rerun the suite.`;
  }
}

/** A response paired with its fully consumed text body from the same interruptible request. */
export type E2eHttpTextResponse = {
  readonly response: Response;
  readonly body: string;
};

type E2eHttpRequestDescription = {
  readonly method: string;
  readonly url: string;
};

const describeE2eHttpRequest = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): E2eHttpRequestDescription => ({
  method: init?.method ?? (input instanceof Request ? input.method : "GET"),
  url: input instanceof Request ? input.url : String(input),
});

/**
 * Runs one E2E fetch whose AbortSignal is bound to fiber interruption.
 *
 * @returns The response, or fails with `E2eHttpRequestError` when the request cannot be sent or its headers do not arrive.
 */
export const fetchE2eResponse = (
  input: RequestInfo | URL,
  init?: RequestInit,
): Effect.Effect<Response, E2eHttpRequestError> => {
  const request = describeE2eHttpRequest(input, init);

  return Effect.tryPromise({
    try: (signal) => fetch(input, { ...init, signal }),
    catch: (cause) =>
      new E2eHttpRequestError({
        ...request,
        operation: "fetchE2eResponse",
        reason: "RequestFailed",
        cause,
      }),
  });
};

/**
 * Fetches and consumes response text under one AbortSignal, so interruption also cancels body transfer.
 *
 * @returns The response with its text body, or fails with `E2eHttpRequestError` when the request
 * cannot be sent, or `E2eHttpResponseBodyError` when the body fails while being read.
 */
export const fetchE2eText = (
  input: RequestInfo | URL,
  init?: RequestInit,
): Effect.Effect<E2eHttpTextResponse, E2eHttpRequestError | E2eHttpResponseBodyError> => {
  const request = describeE2eHttpRequest(input, init);

  return Effect.tryPromise({
    try: (signal) =>
      fetch(input, { ...init, signal }).then(
        (response) =>
          response.text().then(
            (body) => ({ response, body }),
            (cause) =>
              Promise.reject(
                new E2eHttpResponseBodyError({
                  ...request,
                  operation: "fetchE2eText",
                  reason: "BodyReadFailed",
                  cause,
                }),
              ),
          ),
        (cause) =>
          Promise.reject(
            new E2eHttpRequestError({
              ...request,
              operation: "fetchE2eText",
              reason: "RequestFailed",
              cause,
            }),
          ),
      ),
    // Rejections from fetch and Response are untagged promise failures, classified here as they enter Effect.
    catch: (cause) =>
      cause instanceof E2eHttpRequestError || cause instanceof E2eHttpResponseBodyError
        ? cause
        : new E2eHttpRequestError({
            ...request,
            operation: "fetchE2eText",
            reason: "RequestFailed",
            cause,
          }),
  });
};
