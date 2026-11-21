import { ProviderTokens } from "@cf-twitch/contracts/provider";
import { Option, Schema } from "effect";

/**
 * Schema for durable provider token state, including the next alarm intent so restart repairs interrupted scheduling.
 *
 * **Details**
 *
 * An `authorized` state always has a token and a `not-configured` state never has one.
 */
export const ProviderTokenState = Schema.Struct({
  /** Stored credentials with their absolute expiry in Unix milliseconds, or none before authorization. */
  token: Schema.OptionFromNullOr(
    Schema.Struct({ ...ProviderTokens.fields, expiresAtMs: Schema.Number }),
  ),
  /** Whether the stream is live; refresh and proactive scheduling happen only while it is. */
  isStreamLive: Schema.Boolean,
  /** Whether usable credentials exist, or the operator must authorize again. */
  authorizationStatus: Schema.Literals([
    "not-configured",
    "authorized",
    "reauthorization-required",
  ]),
  /** Consecutive short-backoff refresh retries since the last success. */
  refreshRetryCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  /** Unix millisecond deadline of the next scheduled refresh, or none when no refresh is scheduled. */
  nextRefreshAtMs: Schema.OptionFromNullOr(Schema.Number),
}).check(
  Schema.makeFilter(
    (state) =>
      (state.authorizationStatus !== "authorized" || Option.isSome(state.token)) &&
      (state.authorizationStatus !== "not-configured" || Option.isNone(state.token)),
  ),
);

/** Parsed durable provider token state; both credentials stay redacted. */
export type ProviderTokenState = typeof ProviderTokenState.Type;

/** Provider token state before any authorization has been stored. */
export const initialProviderTokenState: ProviderTokenState = {
  token: Option.none(),
  isStreamLive: false,
  authorizationStatus: "not-configured",
  refreshRetryCount: 0,
  nextRefreshAtMs: Option.none(),
};
