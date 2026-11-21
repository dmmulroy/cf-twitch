import { Data, Effect, Option, Redacted, Result, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { NonNegativeInt, PageSize } from "@cf-twitch/contracts/identity";
import { SongQueueLimit } from "@cf-twitch/contracts/song-queue";
import {
  TwitchHttpErrorBody,
  type TwitchHttpAuthenticationAudience,
  type TwitchHttpErrorCode,
  type TwitchHttpErrorStatus,
  type TwitchHttpOperation,
  type TwitchHttpService,
  type TwitchHttpValidationIssue,
} from "@cf-twitch/contracts/twitch-api";
import { HttpRequestCorrelation } from "./http-request-correlation.ts";
import {
  formatHttpEnumIssue,
  formatHttpNumberIssues,
  formatHttpUnknownKeys,
} from "./http-validation-issues.ts";

/** Boundary step that rejected a request, recorded on {@link HttpBoundaryError} for logs and traces. */
export type HttpBoundaryOperation =
  | "authenticate"
  | "parseQuery"
  | "parsePath"
  | "readBody"
  | "parseBody"
  | "callService"
  | "encodeResponse"
  | "readCache"
  | "resolveCallback"
  | "verifyWebhook"
  | "acceptWebhook";

/**
 * Public error body content known where a failure is classified.
 *
 * **Details**
 *
 * The renderer adds the endpoint `operation`, the request's `requestId`, and the compatibility
 * `error` field, which repeats `message`.
 */
export type TwitchHttpFailure = TwitchHttpErrorBody extends infer Body
  ? Body extends TwitchHttpErrorBody
    ? Omit<Body, "error" | "operation" | "requestId">
    : never
  : never;

/**
 * Expected HTTP rejection whose public body is already classified and safe to render.
 *
 * **Details**
 *
 * `failure` is typed by the public error contract, so its `code` and `details` agree by
 * construction. The error is never serialized; credentials, provider bodies and causes are
 * excluded before construction.
 */
export class HttpBoundaryError extends Data.TaggedError("HttpBoundaryError")<{
  /** Boundary step that rejected the request. */
  readonly operation: HttpBoundaryOperation;
  /** Status chosen for what the failure means to the caller. */
  readonly status: TwitchHttpErrorStatus;
  /** Safe public body content, without the endpoint operation and request ID. */
  readonly failure: TwitchHttpFailure;
}> {
  /** Classified reason, identical to the public error code. */
  get reason(): TwitchHttpErrorCode {
    return this.failure.code;
  }

  /** Public explanation of the failure, ending with one way forward. */
  override get message(): string {
    return this.failure.message;
  }
}

const encodeTwitchHttpErrorResponse = HttpServerResponse.schemaJson(TwitchHttpErrorBody);

/**
 * Renders an expected boundary failure as the public error envelope for one endpoint.
 *
 * **Details**
 *
 * Encodes through the public error schema, so Option-valued details render as their wire form.
 *
 * @returns The JSON error response with the request's server-owned `requestId`; it has no typed failure.
 * @throws {SchemaError} As a defect when the failure violates the public error schema, which the middleware renders as `InternalFailure`.
 */
export const renderHttpBoundaryError = Effect.fnUntraced(function* (
  operation: TwitchHttpOperation,
  error: HttpBoundaryError,
) {
  const { requestId } = yield* HttpRequestCorrelation;

  const body: TwitchHttpErrorBody = {
    ...error.failure,
    error: error.failure.message,
    operation,
    requestId,
  };

  return yield* encodeTwitchHttpErrorResponse(body, { status: error.status }).pipe(Effect.orDie);
});

/**
 * Returns a transform that renders expected boundary failures for one endpoint.
 *
 * **Details**
 *
 * Defects and interruption stay visible to the request middleware, which renders them as
 * `InternalFailure` while reporting the redacted cause.
 *
 * @returns An Effect that cannot fail with `HttpBoundaryError`; it requires the request's correlation.
 */
export const handleHttpBoundary =
  (operation: TwitchHttpOperation) =>
  <R>(
    effect: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBoundaryError, R>,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R | HttpRequestCorrelation> =>
    effect.pipe(
      Effect.catchTag("HttpBoundaryError", (error) => renderHttpBoundaryError(operation, error)),
    );

const authenticationUnavailable = (audience: TwitchHttpAuthenticationAudience) =>
  new HttpBoundaryError({
    operation: "authenticate",
    status: 503,
    failure: {
      code: "AuthenticationUnavailable",
      message: `Authentication unavailable for the ${audience}: the credential could not be verified. Retry the request in a few seconds.`,
      details: { audience },
      retryable: true,
    },
  });

/**
 * Compares a supplied secret with the configured secret using Web Crypto's constant-time HMAC verification.
 *
 * @returns Whether the secrets match, or fails with `HttpBoundaryError` (`AuthenticationUnavailable`) when Web Crypto rejects.
 */
export const compareHttpSecret = Effect.fn("Http.compareSecret")(function* (
  provided: Redacted.Redacted<string>,
  expected: Redacted.Redacted<string>,
  audience: TwitchHttpAuthenticationAudience,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder();
      const algorithm = { name: "HMAC", hash: "SHA-256" };

      const candidateKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(Redacted.value(provided)),
        algorithm,
        false,
        ["sign"],
      );

      const expectedKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(Redacted.value(expected)),
        algorithm,
        false,
        ["verify"],
      );

      const message = encoder.encode("CF Twitch HTTP credential verification");
      const signature = await crypto.subtle.sign("HMAC", candidateKey, message);

      return crypto.subtle.verify("HMAC", expectedKey, signature, message);
    },
    catch: () => authenticationUnavailable(audience),
  });
});

/**
 * Authenticates an administrator bearer token before any privileged input is parsed.
 *
 * **Details**
 *
 * An empty configured secret always fails closed. EventSub management also rejects trailing
 * tokens after the bearer value.
 *
 * @returns Nothing on success, or fails with `HttpBoundaryError`: `AuthenticationNotConfigured` (503)
 * when no secret is configured, `AuthorizationMissing` or `AuthorizationMalformed` (401) for an
 * absent or malformed header, `CredentialRejected` (401) for a wrong token, and
 * `AuthenticationUnavailable` (503) when the comparison cannot run.
 */
export const requireHttpAdministrator = Effect.fn("Http.requireAdministrator")(function* (
  secret: Redacted.Redacted<string>,
  audience: "Admin API" | "Debug API" | "EventSub management",
) {
  if (Redacted.value(secret).length === 0)
    return yield* Effect.fail(
      new HttpBoundaryError({
        operation: "authenticate",
        status: 503,
        failure: {
          code: "AuthenticationNotConfigured",
          message: `Authentication not configured for the ${audience}: no administrator secret is set. Contact the operator to configure the administrator secret.`,
          details: { audience },
          retryable: false,
        },
      }),
    );
  const request = yield* HttpServerRequest.HttpServerRequest;
  const authorization = Option.fromNullishOr(request.headers["authorization"]);

  if (Option.isNone(authorization))
    return yield* Effect.fail(
      new HttpBoundaryError({
        operation: "authenticate",
        status: 401,
        failure: {
          code: "AuthorizationMissing",
          message: `Authorization header missing for the ${audience}. Send "Authorization: Bearer <token>" and try again.`,
          details: { audience },
          retryable: false,
        },
      }),
    );
  const [scheme, token, extra] = authorization.value.split(" ");

  if (scheme !== "Bearer" || !token || (audience === "EventSub management" && extra !== undefined))
    return yield* Effect.fail(
      new HttpBoundaryError({
        operation: "authenticate",
        status: 401,
        failure: {
          code: "AuthorizationMalformed",
          message: `Authorization header malformed for the ${audience}: expected "Bearer <token>". Fix the header and try again.`,
          details: { audience },
          retryable: false,
        },
      }),
    );

  if (!(yield* compareHttpSecret(Redacted.make(token), secret, audience)))
    return yield* Effect.fail(
      new HttpBoundaryError({
        operation: "authenticate",
        status: 401,
        failure: {
          code: "CredentialRejected",
          message: `Credential rejected for the ${audience}: the bearer token does not match. Send the configured administrator token and try again.`,
          details: { audience },
          retryable: false,
        },
      }),
    );
});

/**
 * Builds the failure for a service value that its own public response schema rejects.
 *
 * @returns An `InvalidServiceResponse` (500) failure; a corrupt value is never returned as success.
 */
export const invalidHttpServiceResponse = (
  operation: "encodeResponse" | "readCache",
  service: TwitchHttpService,
) =>
  new HttpBoundaryError({
    operation,
    status: 500,
    failure: {
      code: "InvalidServiceResponse",
      message:
        "Invalid service response: the result did not match the published response schema. Contact support with the request ID in this response.",
      details: { service },
      retryable: false,
    },
  });

/**
 * Encodes a service value through its owning response schema.
 *
 * **Details**
 *
 * `service` names the capability that produced the value in any failure.
 *
 * @returns The JSON response, or fails with `HttpBoundaryError` (`InvalidServiceResponse`, 500) when the value violates the schema.
 */
export const encodeHttpResponse = <A>(
  service: TwitchHttpService,
  schema: Schema.ConstraintCodec<A, unknown, unknown, never>,
  value: A,
  status = 200,
): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBoundaryError> =>
  HttpServerResponse.schemaJson(schema)(value, { status }).pipe(
    Effect.mapError(() => invalidHttpServiceResponse("encodeResponse", service)),
  );

const decodePageSize = Schema.decodeEffect(PageSize);

const decodeSongQueueLimit = Schema.decodeEffect(SongQueueLimit);

const decodeOffset = Schema.decodeEffect(NonNegativeInt);

const leaderboardSortValues = ["rolls", "wins", "closest"] as const;

const decodeSort = Schema.decodeEffect(
  Schema.String.pipe(Schema.decodeTo(Schema.Literals(leaderboardSortValues))),
);

const readHttpSearchParams = Effect.fn("Http.readSearchParams")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  return new URL(request.originalUrl, "https://http.internal").searchParams;
});

const readPublicLimitValue = (query: URLSearchParams): number =>
  query.getAll("limit").length > 1
    ? Number.NaN
    : query.has("limit")
      ? Number(query.get("limit"))
      : 10;

const findUnknownQueryKeys = (
  query: URLSearchParams,
  allowed: readonly string[],
): readonly string[] => [...new Set(query.keys())].filter((key) => !allowed.includes(key));

const invalidQueryParameters = (details: readonly TwitchHttpValidationIssue[]) =>
  new HttpBoundaryError({
    operation: "parseQuery",
    status: 400,
    failure: {
      code: "InvalidQueryParameters",
      message:
        "Invalid query parameters: one or more values are missing, repeated, unknown, or out of range. Fix the query parameters listed in details and send the request again.",
      details,
      retryable: false,
    },
  });

const decodeHttpLimit = <A>(
  decode: (input: number) => Effect.Effect<A, Schema.SchemaError>,
  value: number,
  unknownKeys: readonly string[],
): Effect.Effect<A, HttpBoundaryError> =>
  decode(value).pipe(
    Effect.mapError(() =>
      invalidQueryParameters([
        ...formatHttpNumberIssues(value, ["limit"], 1, 100),
        ...(unknownKeys.length > 0 ? [formatHttpUnknownKeys(unknownKeys)] : []),
      ]),
    ),
    Effect.filterOrFail(
      () => unknownKeys.length === 0,
      () => invalidQueryParameters([formatHttpUnknownKeys(unknownKeys)]),
    ),
  );

/**
 * Parses the sole public `limit` query parameter into a branded page size.
 *
 * @returns The page size (default 10), or fails with `HttpBoundaryError` (`InvalidQueryParameters`, 400) for a repeated, non-integer, out-of-range or unknown key.
 */
export const parseHttpLimitQuery = Effect.fn("Http.parseLimitQuery")(function* () {
  const query = yield* readHttpSearchParams();

  return yield* decodeHttpLimit(
    decodePageSize,
    readPublicLimitValue(query),
    findUnknownQueryKeys(query, ["limit"]),
  );
});

/**
 * Parses public leaderboard `limit` and `sortBy` query parameters.
 *
 * @returns The limit (default 10) and ordering (default `closest`), or fails with `HttpBoundaryError` (`InvalidQueryParameters`, 400) listing every invalid parameter.
 */
export const parseHttpLeaderboardQuery = Effect.fn("Http.parseLeaderboardQuery")(function* () {
  const query = yield* readHttpSearchParams();
  const limitValue = readPublicLimitValue(query);
  const sortValue = Option.getOrElse(Option.fromNullishOr(query.get("sortBy")), () => "closest");
  const unknownKeys = findUnknownQueryKeys(query, ["limit", "sortBy"]);

  const [limitResult, sortResult] = yield* Effect.all([
    decodePageSize(limitValue).pipe(Effect.result),
    decodeSort(sortValue).pipe(Effect.result),
  ]);

  const issues = [
    ...(Result.isFailure(sortResult) || query.getAll("sortBy").length > 1
      ? [formatHttpEnumIssue(leaderboardSortValues, ["sortBy"])]
      : []),
    ...(Result.isFailure(limitResult) ? formatHttpNumberIssues(limitValue, ["limit"], 1, 100) : []),
    ...(unknownKeys.length > 0 ? [formatHttpUnknownKeys(unknownKeys)] : []),
  ];

  if (Result.isFailure(limitResult) || Result.isFailure(sortResult) || issues.length > 0)
    return yield* Effect.fail(invalidQueryParameters(issues));

  return { limit: limitResult.success, sortBy: sortResult.success };
});

/**
 * Parses administrator pagination while ignoring unknown keys for compatibility.
 *
 * @returns The limit (default 50) and offset (default 0), or fails with `HttpBoundaryError` (`InvalidQueryParameters`, 400) for an out-of-range value.
 */
export const parseHttpAdminPageQuery = Effect.fn("Http.parseAdminPageQuery")(function* () {
  const query = yield* readHttpSearchParams();
  const limitValue = query.has("limit") ? Number(query.get("limit")) : 50;
  const offsetValue = query.has("offset") ? Number(query.get("offset")) : 0;

  const [limitResult, offsetResult] = yield* Effect.all([
    decodePageSize(limitValue).pipe(Effect.result),
    decodeOffset(offsetValue).pipe(Effect.result),
  ]);

  const issues = [
    ...(Result.isFailure(limitResult) ? formatHttpNumberIssues(limitValue, ["limit"], 1, 100) : []),
    ...(Result.isFailure(offsetResult)
      ? formatHttpNumberIssues(offsetValue, ["offset"], 0, Number.MAX_SAFE_INTEGER)
      : []),
  ];

  if (Result.isFailure(limitResult) || Result.isFailure(offsetResult))
    return yield* Effect.fail(invalidQueryParameters(issues));

  return { limit: limitResult.success, offset: offsetResult.success };
});

/**
 * Rejects every query parameter on endpoints whose contract accepts no query.
 *
 * @returns Nothing, or fails with `HttpBoundaryError` (`InvalidQueryParameters`, 400) naming the unknown keys.
 */
export const rejectHttpQueryParameters = Effect.fn("Http.rejectQueryParameters")(function* () {
  const query = yield* readHttpSearchParams();
  const unknownKeys = findUnknownQueryKeys(query, []);

  if (unknownKeys.length > 0)
    return yield* Effect.fail(invalidQueryParameters([formatHttpUnknownKeys(unknownKeys)]));
});

/**
 * Parses a public song queue `limit` directly into its nominal service type.
 *
 * @returns The song queue limit (default 10), or fails with `HttpBoundaryError` (`InvalidQueryParameters`, 400) for a repeated, non-integer, out-of-range or unknown key.
 */
export const parseHttpSongQueueQuery = Effect.fn("Http.parseSongQueueQuery")(function* () {
  const query = yield* readHttpSearchParams();

  return yield* decodeHttpLimit(
    decodeSongQueueLimit,
    readPublicLimitValue(query),
    findUnknownQueryKeys(query, ["limit"]),
  );
});
