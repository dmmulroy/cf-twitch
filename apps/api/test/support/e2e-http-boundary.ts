import { Effect, Schema } from "effect";

/** A staged E2E request could not establish or complete its HTTP response headers. */
export class E2eHttpRequestError extends Schema.TaggedError<E2eHttpRequestError>()(
  "E2eHttpRequestError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return `E2E HTTP ${this.method} request failed for ${this.url}`;
  }
}

/** A staged E2E response disconnected or otherwise failed while its body was being read. */
export class E2eHttpResponseBodyError extends Schema.TaggedError<E2eHttpResponseBodyError>()(
  "E2eHttpResponseBodyError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return `E2E HTTP ${this.method} response body failed for ${this.url}`;
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

/** Run one E2E fetch with a typed request failure and interruption-bound AbortSignal. */
export const fetchE2eResponse = (
  input: RequestInfo | URL,
  init?: RequestInit,
): Effect.Effect<Response, E2eHttpRequestError> => {
  const request = describeE2eHttpRequest(input, init);

  return Effect.tryPromise({
    try: (signal) => fetch(input, { ...init, signal }),
    catch: (cause) => new E2eHttpRequestError({ ...request, cause }),
  });
};

/** Fetch and consume text under one AbortSignal so interruption also cancels body transfer. */
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
            (cause) => Promise.reject(new E2eHttpResponseBodyError({ ...request, cause })),
          ),
        (cause) => Promise.reject(new E2eHttpRequestError({ ...request, cause })),
      ),
    catch: (cause) =>
      cause instanceof E2eHttpRequestError || cause instanceof E2eHttpResponseBodyError
        ? cause
        : new E2eHttpRequestError({ ...request, cause }),
  });
};
