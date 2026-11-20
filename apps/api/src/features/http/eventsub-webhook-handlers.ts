import { Cause, Clock, Effect, Predicate, Redacted, Schema, Stream } from "effect";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import { EventSubHeaders } from "@cf-twitch/contracts/eventsub";
import { IsoTimestamp } from "@cf-twitch/contracts/identity";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { EventSubReceipts } from "../eventsub/eventsub-receipts.ts";
import { parseEventSubMessage } from "../eventsub/eventsub-message.ts";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { HttpBoundaryError, handleHttpBoundary } from "./http-boundary.ts";
import { HttpRequestCorrelation } from "./http-request-correlation.ts";

/** Maximum authenticated EventSub body size, measured in bytes rather than UTF-16 characters. */
export const maximumEventSubBodyBytes = 1_048_576;

const decodeEventSubHeaders = Schema.decodeUnknownEffect(EventSubHeaders);

const decodeIsoTimestamp = Schema.decodeEffect(IsoTimestamp);

const decodeJsonText = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

/** Builds a 400 rejection for EventSub input that is malformed rather than unauthenticated. */
const invalidEventSubInput = (
  code:
    | "InvalidEventSubHeaders"
    | "InvalidEventSubBody"
    | "InvalidEventSubJson"
    | "InvalidEventSubPayload",
  operation: "parseBody" | "readBody" | "verifyWebhook",
): HttpBoundaryError => {
  switch (code) {
    case "InvalidEventSubHeaders":
      return new HttpBoundaryError({
        operation,
        status: 400,
        failure: {
          code,
          error: "Invalid EventSub headers",
          message:
            "Invalid EventSub headers: a required Twitch-Eventsub-* header is missing or malformed. Send every EventSub header with its documented format.",
          details: {},
          retryable: false,
        },
      });
    case "InvalidEventSubBody":
      return new HttpBoundaryError({
        operation,
        status: 400,
        failure: {
          code,
          error: "Invalid EventSub body",
          message:
            "Invalid EventSub body: the body could not be read as UTF-8 text. Send the notification body as UTF-8 JSON.",
          details: {},
          retryable: false,
        },
      });
    case "InvalidEventSubJson":
      return new HttpBoundaryError({
        operation,
        status: 400,
        failure: {
          code,
          error: "Invalid EventSub JSON body",
          message:
            "Invalid EventSub JSON body: the signed body is not valid JSON. Send the notification body as JSON.",
          details: {},
          retryable: false,
        },
      });
    case "InvalidEventSubPayload":
      return new HttpBoundaryError({
        operation,
        status: 400,
        failure: {
          code,
          error: "Invalid EventSub payload",
          message:
            "Invalid EventSub payload: the JSON does not match the EventSub message schema or disagrees with the subscription headers. Fix the payload and send it again.",
          details: {},
          retryable: false,
        },
      });
  }
};

const readEventSubBytes = Effect.fn("Http.readEventSubBytes")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const declaredSize = Number(request.headers["content-length"]);

  const tooLarge = () =>
    new HttpBoundaryError({
      operation: "readBody",
      status: 400,
      failure: {
        code: "EventSubBodyTooLarge",
        error: "EventSub body too large",
        message: `EventSub body too large: the body exceeds ${maximumEventSubBodyBytes} bytes. Send a body of at most ${maximumEventSubBodyBytes} bytes.`,
        details: { maximumBytes: maximumEventSubBodyBytes },
        retryable: false,
      },
    });

  if (Number.isFinite(declaredSize) && declaredSize > maximumEventSubBodyBytes)
    return yield* Effect.fail(tooLarge());
  // Fixed allocation avoids quadratic chunk copying and bounds overhead for adversarial tiny chunks.
  const bytes = new Uint8Array(maximumEventSubBodyBytes);

  const length = yield* request.stream.pipe(
    Stream.runFoldEffect(
      () => 0,
      (offset, chunk) => {
        if (offset + chunk.byteLength > maximumEventSubBodyBytes) return Effect.fail(tooLarge());
        bytes.set(chunk, offset);

        return Effect.succeed(offset + chunk.byteLength);
      },
    ),
    Effect.catchTag("HttpServerError", () =>
      Effect.fail(invalidEventSubInput("InvalidEventSubBody", "readBody")),
    ),
  );

  return bytes.slice(0, length);
});

/**
 * Authenticates an EventSub webhook's exact signed bytes and freshness, then durably accepts it.
 *
 * **Details**
 *
 * Order is part of the contract: headers, timestamp window, bounded body, UTF-8, HMAC, JSON, then
 * message schema. A challenge is answered as text; a notification returns 200 only after its
 * receipt is durably accepted. Acceptance is idempotent by message ID, so a 503 is retryable.
 *
 * @returns The challenge or `{ success: true }` response, or the rendered public error: 400 for
 * malformed input or oversized bodies, 401 for stale timestamps or bad signatures, 409 for a
 * message ID reused with different content, and 503 when authentication or acceptance is unavailable.
 */
export const handleEventSubWebhook = Effect.fn("Http.eventSubWebhook")(function* () {
  const configuration = yield* TwitchConfiguration;
  const receipts = yield* EventSubReceipts;
  const correlation = yield* HttpRequestCorrelation;
  const digestService = yield* Digest.Digest;
  const request = yield* HttpServerRequest.HttpServerRequest;

  const headers = yield* decodeEventSubHeaders(request.headers).pipe(
    Effect.mapError(() => invalidEventSubInput("InvalidEventSubHeaders", "verifyWebhook")),
  );

  const timestamp = headers["twitch-eventsub-message-timestamp"];
  const now = yield* Clock.currentTimeMillis;

  if (Math.abs(now - Date.parse(timestamp)) > 600_000)
    return yield* Effect.fail(
      new HttpBoundaryError({
        operation: "verifyWebhook",
        status: 401,
        failure: {
          code: "EventSubTimestampOutOfWindow",
          error: "EventSub timestamp outside the allowed window",
          message:
            "EventSub timestamp outside the allowed window: the message timestamp is more than 10 minutes from server time. Resend the notification with a current timestamp and signature.",
          details: { toleranceSeconds: 600 },
          retryable: false,
        },
      }),
    );
  const bodyBytes = yield* readEventSubBytes();

  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes),
    catch: () => invalidEventSubInput("InvalidEventSubBody", "readBody"),
  });

  const prefix = new TextEncoder().encode(headers["twitch-eventsub-message-id"] + timestamp);
  const signedBytes = new Uint8Array(prefix.length + bodyBytes.length);
  signedBytes.set(prefix);
  signedBytes.set(bodyBytes, prefix.length);

  const signature = yield* Effect.fromResult(
    Hex.decode(headers["twitch-eventsub-message-signature"].slice(7)),
  ).pipe(
    Effect.map((bytes) => new Uint8Array(bytes)),
    Effect.mapError(() => invalidEventSubInput("InvalidEventSubHeaders", "verifyWebhook")),
  );

  const authenticated = yield* Effect.tryPromise({
    try: async () => {
      if (Redacted.value(configuration.eventSubSecret).length === 0) return false;

      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(Redacted.value(configuration.eventSubSecret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );

      return crypto.subtle.verify("HMAC", key, signature, signedBytes);
    },
    catch: () =>
      new HttpBoundaryError({
        operation: "verifyWebhook",
        status: 503,
        failure: {
          code: "AuthenticationUnavailable",
          error: "EventSub authentication unavailable",
          message:
            "Authentication unavailable for the EventSub webhook: the signature could not be verified. Retry the delivery in a few seconds.",
          details: { audience: "EventSub webhook" },
          retryable: true,
        },
      }),
  });

  if (!authenticated)
    return yield* Effect.fail(
      new HttpBoundaryError({
        operation: "verifyWebhook",
        status: 401,
        failure: {
          code: "EventSubSignatureInvalid",
          error: "Invalid EventSub signature",
          message:
            "EventSub signature invalid: the HMAC-SHA256 signature does not match the message ID, timestamp, and body. Sign the exact bytes with the subscription secret and resend.",
          details: {},
          retryable: false,
        },
      }),
    );

  const body = yield* decodeJsonText(text).pipe(
    Effect.mapError(() => invalidEventSubInput("InvalidEventSubJson", "parseBody")),
  );

  const message = yield* parseEventSubMessage(headers, body).pipe(
    Effect.mapError(() => invalidEventSubInput("InvalidEventSubPayload", "parseBody")),
  );

  if (Predicate.isTagged(message, "EventSubChallenge"))
    return HttpServerResponse.text(message.challenge, {
      contentType: "text/plain; charset=UTF-8",
    });

  const messageId = headers["twitch-eventsub-message-id"];

  const acceptanceFailed = new HttpBoundaryError({
    operation: "acceptWebhook",
    status: 503,
    failure: {
      code: "EventSubAcceptanceFailed",
      error: "EventSub durable acceptance failed",
      message: `EventSub acceptance failed for message ${messageId}: the receipt could not be stored durably. Redeliver the same message; acceptance is idempotent by message ID.`,
      details: { messageId },
      retryable: true,
    },
  });

  // Effect 4.1 Digest reports an unavailable SHA implementation as a defect, not a typed failure.
  const contentDigest = yield* digestService.digestHex(Digest.sha256, signedBytes).pipe(
    Effect.catchCauseIf(
      (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
      () => Effect.fail(acceptanceFailed),
    ),
  );

  // An ISO string produced by Date always satisfies IsoTimestamp; a decode failure would be a defect.
  const receivedAt = yield* decodeIsoTimestamp(new Date(now).toISOString()).pipe(Effect.orDie);
  yield* receipts.accept({ messageId, receivedAt, contentDigest, headers, body, correlation }).pipe(
    Effect.catchTags({
      EventSubReceiptConflict: (conflict) =>
        Effect.fail(
          new HttpBoundaryError({
            operation: "acceptWebhook",
            status: 409,
            failure: {
              code: "EventSubReceiptConflict",
              error: "EventSub message conflicts with an accepted receipt",
              message: `EventSub receipt conflict for message ${conflict.messageId}: an accepted message with this ID has different content. Send a new message ID for different content.`,
              details: { messageId: conflict.messageId },
              retryable: false,
            },
          }),
        ),
      EventSubReceiptError: () => Effect.fail(acceptanceFailed),
    }),
  );

  return HttpServerResponse.jsonUnsafe({ success: true });
}, handleHttpBoundary("webhook"));
