import { Option, Schema } from "effect";
import {
  BroadcasterId,
  IsoTimestamp,
  NonNegativeInt,
  RedemptionId,
  RewardId,
  StreamId,
} from "./identity.ts";

/** Schema for the OAuth provider identities, Spotify and Twitch; never selects a production namespace implicitly. */
export const OAuthProvider = Schema.Literals(["spotify", "twitch"]);

/** Provider identity shared by token and authorization services. */
export type OAuthProvider = typeof OAuthProvider.Type;

/** Schema for the provider operations that can report a `ProviderError`. */
export const ProviderOperation = Schema.Literals([
  "getStreamInfo",
  "sendChatMessage",
  "createShoutout",
  "updateRedemptionStatus",
  "createEventSubSubscription",
  "listEventSubSubscriptions",
  "deleteEventSubSubscription",
  "getTrack",
  "getQueue",
  "getCurrentlyPlaying",
  "getActiveDevice",
  "getClientToken",
  "getConnectState",
  "addToQueue",
  "skipTrack",
  "removeFromQueue",
  "generateProviderCommandId",
  "exchangeAuthorizationCode",
  "refreshAccessToken",
  "getTwitchAppToken",
  "getValidAccessToken",
  "setTokens",
  "onStreamOnline",
  "onStreamOffline",
  "getValidToken",
  "refreshToken",
  "readTokenState",
  "writeTokenState",
  "importLegacyTokenState",
  "migrateTokenState",
  "setTokenAlarm",
  "deleteTokenAlarm",
]);

/** Provider operation that reported a `ProviderError`. */
export type ProviderOperation = typeof ProviderOperation.Type;

/** Schema for safe provider failure reasons; an unknown mutation outcome must never be blindly retried. */
export const ProviderFailureReason = Schema.Literals([
  "network",
  "rejected",
  "unauthorized",
  "rate-limited",
  "invalid-response",
  "invalid-input",
  "not-found",
  "no-active-device",
  "chat-dropped",
  "outcome-unknown",
  "not-configured",
  "offline",
  "reauthorization-required",
  "persistence",
  "stored-state-invalid",
  "randomness",
]);

/** Classified reason a provider operation failed. */
export type ProviderFailureReason = typeof ProviderFailureReason.Type;

const describeProviderStatus = (status: Option.Option<number>): string =>
  Option.match(status, { onNone: () => "no HTTP status", onSome: (value) => `HTTP ${value}` });

/**
 * Typed failure of a Spotify or Twitch provider operation or of durable provider-token storage.
 *
 * **Details**
 *
 * Carries only safe classification: provider, operation, reason, HTTP status and retry delay.
 * Provider bodies, URLs, credentials and transport causes are deliberately excluded.
 */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  /** Provider whose operation or token storage failed. */
  provider: OAuthProvider,
  /** Provider operation that failed. */
  operation: ProviderOperation,
  /** Classified failure reason that callers branch on for retry and compensation policy. */
  reason: ProviderFailureReason,
  /** HTTP status returned by the provider, or none when no provider response was received. */
  status: Schema.OptionFromNullOr(Schema.Number),
  /** Provider-requested delay in milliseconds before retrying a rate-limited request. */
  retryAfterMs: Schema.OptionFromNullOr(Schema.Number),
}) {
  /** Error message naming the provider operation, its classified reason and one way forward. */
  override get message(): string {
    const subject = `${this.provider} ${this.operation}`;

    // An authorization code is single-use, so a failed exchange is retried by restarting authorization.
    const retry =
      this.operation === "exchangeAuthorizationCode"
        ? "Start authorization again from the setup link."
        : "Retry the request.";

    switch (this.reason) {
      case "network":
        return `Provider request could not reach the provider during ${subject}. ${retry}`;
      case "rejected":
        return `Provider rejected ${subject} with ${describeProviderStatus(this.status)}. Check the request input and provider account settings, then retry.`;
      case "unauthorized":
        return `Provider credentials were not accepted during ${subject}. Check the ${this.provider} client credentials and authorization, then retry.`;
      case "rate-limited":
        return `Provider rate limit reached during ${subject}. Wait ${Option.getOrElse(this.retryAfterMs, () => 1000)} ms, then retry the request.`;
      case "invalid-response":
        return `Provider response for ${subject} did not match the expected format. ${retry}`;
      case "invalid-input":
        return `Provider request input for ${subject} was invalid. Correct the input and send it again.`;
      case "not-found":
        return `Provider resource for ${subject} was not found. Check the identifier and try again.`;
      case "no-active-device":
        return `Provider has no active playback device for ${subject}. Start playback on a ${this.provider} device, then retry.`;
      case "chat-dropped":
        return `Provider dropped the chat message during ${subject}. Revise the message text and send it again.`;
      case "outcome-unknown":
        return `Provider outcome is unknown for ${subject}. Inspect the provider state for this operation before retrying.`;
      case "not-configured":
        return `Provider tokens are not configured for ${subject}. Authorize ${this.provider} through OAuth setup, then retry.`;
      case "offline":
        return `Provider token refresh is paused while the stream is offline during ${subject}. Retry after the stream goes live.`;
      case "reauthorization-required":
        return `Provider authorization must be renewed before ${subject}. Reauthorize ${this.provider} through OAuth setup, then retry.`;
      case "persistence":
        return `Provider token storage was unavailable during ${subject}. Retry the request, and inspect the ${this.provider} token storage if it fails again.`;
      case "stored-state-invalid":
        return `Provider token storage holds state that cannot be read during ${subject}. Inspect and repair the ${this.provider} token storage before retrying.`;
      case "randomness":
        return `Provider command ID generation failed during ${subject} because secure randomness was unavailable. ${retry}`;
    }
  }
}

/** Schema for provider token credentials, which remain redacted until the HTTP or persistence boundary. */
export const ProviderTokens = Schema.Struct({
  accessToken: Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1))),
  /** Refresh credential, or none when the provider omitted rotation and the stored one is kept. */
  refreshToken: Schema.OptionFromNullOr(
    Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1))),
  ),
  tokenType: Schema.Trim.check(Schema.isMinLength(1)),
  /** Access-token lifetime in seconds, bounded to one year. */
  expiresIn: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(31_536_000)),
  /** Granted scopes; empty when the provider response omitted them. */
  scopes: Schema.Array(Schema.String),
});

/** Normalized provider token response with expiry in seconds. */
export type ProviderTokens = typeof ProviderTokens.Type;

/** Schema for a provider token write addressed to one provider only. */
export const SetProviderTokens = Schema.Struct({ provider: OAuthProvider, tokens: ProviderTokens });

/** Provider token write input. */
export interface SetProviderTokens extends Schema.Schema.Type<typeof SetProviderTokens> {}

/** Schema for a Twitch redemption status update; the broadcaster comes from configuration at the composition root. */
export const UpdateRedemptionStatus = Schema.Struct({
  rewardId: RewardId,
  redemptionId: RedemptionId,
  status: Schema.Literals(["FULFILLED", "CANCELED"]),
});

/** Redemption update input. */
export interface UpdateRedemptionStatus extends Schema.Schema.Type<typeof UpdateRedemptionStatus> {}

/** Schema for Twitch chat text, bounded to the provider's one-to-five-hundred character contract. */
export const ChatMessageText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
).pipe(Schema.brand("ChatMessageText"));

/** Parsed Twitch chat text accepted for provider delivery. */
export type ChatMessageText = typeof ChatMessageText.Type;

/** Schema for chat delivery input whose text has Twitch's strict 1–500 character limit. */
export const SendChatMessage = Schema.Struct({ message: ChatMessageText });

/** Chat delivery input. */
export interface SendChatMessage extends Schema.Schema.Type<typeof SendChatMessage> {}

/** Schema for native shoutout input; shoutouts always originate from the configured broadcaster. */
export const CreateShoutout = Schema.Struct({ toBroadcasterId: BroadcasterId });

/** Native shoutout input. */
export interface CreateShoutout extends Schema.Schema.Type<typeof CreateShoutout> {}

/** Schema for live Twitch stream information; the provider returns none while the stream is offline. */
export const TwitchStreamInfo = Schema.Struct({
  id: StreamId,
  viewerCount: NonNegativeInt,
  /** Stream start in Twitch source time, which orders stream lifecycle evidence. */
  startedAt: IsoTimestamp,
  gameName: Schema.String,
  title: Schema.String,
});

/** Live Twitch stream information with provider source time. */
export interface TwitchStreamInfo extends Schema.Schema.Type<typeof TwitchStreamInfo> {}

/** Schema for EventSub condition fields, preserving arbitrary string-valued matching fields. */
export const EventSubCondition = Schema.Record(Schema.String, Schema.String);

/** Schema for EventSub subscription evidence, including unknown statuses for forward-compatible reconciliation. */
export const ProviderEventSubSubscription = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  condition: EventSubCondition,
  transport: Schema.Struct({
    method: Schema.String,
    /** Webhook callback URL, or none for non-webhook transports. */
    callback: Schema.OptionFromNullOr(Schema.String),
  }),
});

/** EventSub subscription evidence. */
export interface ProviderEventSubSubscription extends Schema.Schema.Type<
  typeof ProviderEventSubSubscription
> {}

/** Schema for webhook subscription creation input with an explicitly redacted transport secret. */
export const CreateEventSubSubscription = Schema.Struct({
  type: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  condition: EventSubCondition,
  /** Public webhook URL Twitch delivers notifications to. */
  callbackUrl: Schema.String,
  /** Shared secret Twitch uses to sign webhook deliveries. */
  secret: Schema.RedactedFromValue(Schema.NonEmptyString),
});

/** Webhook subscription creation input. */
export interface CreateEventSubSubscription extends Schema.Schema.Type<
  typeof CreateEventSubSubscription
> {}

/** Schema for an active Spotify device, a provider identity rather than a viewer. */
export const SpotifyDevice = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  type: Schema.String,
  isActive: Schema.Boolean,
});

/** Spotify device evidence. */
export interface SpotifyDevice extends Schema.Schema.Type<typeof SpotifyDevice> {}

/** Schema for an internal Spotify Connect track with the metadata needed for queue compensation. */
export const SpotifyConnectTrack = Schema.Struct({
  uri: Schema.String,
  /** Spotify's identifier of this queue entry, distinct for repeated occurrences of one track. */
  uid: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.String),
  /** Spotify's source of the entry, such as `queue` for user-queued tracks or autoplay context. */
  provider: Schema.String,
});

/** Schema for internal Spotify Connect state, which is unstable provider protocol evidence. */
export const SpotifyConnectState = Schema.Struct({
  timestamp: Schema.String,
  context_uri: Schema.String,
  /** Revision token that a queue replacement command must echo to avoid overwriting a newer queue. */
  queue_revision: Schema.String,
  next_tracks: Schema.Array(SpotifyConnectTrack),
  prev_tracks: Schema.Array(SpotifyConnectTrack),
});

/** Spotify connect state used only for best-effort compensation. */
export interface SpotifyConnectState extends Schema.Schema.Type<typeof SpotifyConnectState> {}
