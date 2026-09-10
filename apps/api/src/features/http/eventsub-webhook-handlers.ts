import { Clock, Crypto, Effect, Encoding, Redacted, Schema, Stream } from "effect";
import { EventSubHeaders } from "@cf-twitch/contracts/eventsub";
import { IsoTimestamp } from "@cf-twitch/contracts/identity";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EventSubReceipts } from "../eventsub/eventsub-receipts.ts";
import { parseEventSubMessage } from "../eventsub/eventsub-message.ts";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import {
  HttpBoundaryError,
  HttpRequestCorrelation,
  renderHttpBoundaryError,
} from "./http-boundary.ts";

/** Maximum authenticated EventSub body size, measured in bytes rather than UTF-16 characters. */
export const maximumEventSubBodyBytes = 1_048_576;

const parseHeaders = Schema.decodeUnknownEffect(EventSubHeaders);

const parseTimestamp = Schema.decodeEffect(IsoTimestamp);

const parseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

const readEventSubBytes = Effect.fn("Http.readEventSubBytes")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const declaredSize = Number(request.headers["content-length"]);
  const tooLarge = () => new HttpBoundaryError({ status: 413, error: "EventSub body too large" });

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
      Effect.fail(new HttpBoundaryError({ status: 400, error: "Invalid EventSub body" })),
    ),
  );

  return bytes.slice(0, length);
});

/** Authenticate exact signed bytes and freshness before parsing JSON or writing a durable receipt. */
export const handleEventSubWebhook = Effect.fn("Http.eventSubWebhook")(
  function* () {
    const configuration = yield* TwitchConfiguration;
    const receipts = yield* EventSubReceipts;
    const correlation = yield* HttpRequestCorrelation;
    const effectCrypto = yield* Crypto.Crypto;
    const request = yield* HttpServerRequest.HttpServerRequest;

    const headers = yield* parseHeaders(request.headers).pipe(
      Effect.mapError(
        () => new HttpBoundaryError({ status: 400, error: "Invalid EventSub headers" }),
      ),
    );

    const timestamp = headers["twitch-eventsub-message-timestamp"];
    const now = yield* Clock.currentTimeMillis;

    if (Math.abs(now - Date.parse(timestamp)) > 600_000)
      return yield* Effect.fail(
        new HttpBoundaryError({
          status: 403,
          error: "EventSub timestamp outside the allowed window",
        }),
      );
    const bodyBytes = yield* readEventSubBytes();

    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes),
      catch: () => new HttpBoundaryError({ status: 400, error: "Invalid EventSub body" }),
    });

    const prefix = new TextEncoder().encode(headers["twitch-eventsub-message-id"] + timestamp);
    const signedBytes = new Uint8Array(prefix.length + bodyBytes.length);
    signedBytes.set(prefix);
    signedBytes.set(bodyBytes, prefix.length);

    const signature = yield* Effect.fromResult(
      Encoding.decodeHex(headers["twitch-eventsub-message-signature"].slice(7)),
    ).pipe(
      Effect.map((bytes) => new Uint8Array(bytes)),
      Effect.mapError(
        () => new HttpBoundaryError({ status: 400, error: "Invalid EventSub headers" }),
      ),
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
        new HttpBoundaryError({ status: 503, error: "EventSub authentication unavailable" }),
    });

    if (!authenticated)
      return yield* Effect.fail(
        new HttpBoundaryError({ status: 403, error: "Invalid EventSub signature" }),
      );

    const body = yield* parseJson(text).pipe(
      Effect.mapError(
        () => new HttpBoundaryError({ status: 400, error: "Invalid EventSub JSON body" }),
      ),
    );

    const message = yield* parseEventSubMessage(headers, body).pipe(
      Effect.mapError(
        () => new HttpBoundaryError({ status: 400, error: "Invalid EventSub payload" }),
      ),
    );

    if (message._tag === "EventSubChallenge")
      return HttpServerResponse.text(message.challenge, {
        contentType: "text/plain; charset=UTF-8",
      });

    const contentDigest = yield* effectCrypto.digest("SHA-256", signedBytes).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError(
        () => new HttpBoundaryError({ status: 503, error: "EventSub durable acceptance failed" }),
      ),
    );

    const receivedAt = yield* parseTimestamp(new Date(now).toISOString()).pipe(Effect.orDie);
    yield* receipts
      .accept({
        messageId: headers["twitch-eventsub-message-id"],
        receivedAt,
        contentDigest,
        headers,
        body,
        correlation,
      })
      .pipe(
        Effect.mapError(
          () => new HttpBoundaryError({ status: 503, error: "EventSub durable acceptance failed" }),
        ),
      );

    return HttpServerResponse.jsonUnsafe({ success: true });
  },
  Effect.catchTag("HttpBoundaryError", (error) => Effect.succeed(renderHttpBoundaryError(error))),
);
