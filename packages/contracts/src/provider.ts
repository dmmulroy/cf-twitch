import { Schema } from "effect";
import {
  BroadcasterId,
  IsoTimestamp,
  NonNegativeInt,
  RedemptionId,
  RewardId,
  StreamId,
} from "./identity.ts";

/** OAuth provider identities never select a production namespace implicitly. */
export const OAuthProvider = Schema.Literals(["spotify", "twitch"]);

/** Provider identity shared by token and authorization services. */
export type OAuthProvider = typeof OAuthProvider.Type;

/** Safe provider failure categories; unknown mutation outcomes must never be blindly retried. */
export const ProviderFailureKind = Schema.Literals([
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
  "randomness",
]);

/** Safe error evidence deliberately excludes provider bodies, URLs, credentials and transport causes. */
export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  provider: OAuthProvider,
  operation: Schema.String,
  kind: ProviderFailureKind,
  status: Schema.Number,
  retryAfterMs: Schema.OptionFromNullOr(Schema.Number),
}) {
  /** Provider failure message contains only bounded classifications, never raw upstream evidence. */
  override get message(): string {
    return `Provider operation failed: ${this.provider} ${this.operation} (${this.kind})`;
  }
}

/** Token credentials remain redacted until the HTTP or persistence boundary. */
export const ProviderTokens = Schema.Struct({
  accessToken: Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1))),
  refreshToken: Schema.OptionFromNullOr(
    Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1))),
  ),
  tokenType: Schema.Trim.check(Schema.isMinLength(1)),
  expiresIn: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(31_536_000)),
  scopes: Schema.Array(Schema.String),
});

/** Normalized provider token response with expiry in seconds. */
export type ProviderTokens = typeof ProviderTokens.Type;

/** Provider token write addressed to one provider only. */
export const SetProviderTokens = Schema.Struct({ provider: OAuthProvider, tokens: ProviderTokens });

/** Provider token write input. */
export interface SetProviderTokens extends Schema.Schema.Type<typeof SetProviderTokens> {}

/** Twitch redemption updates use the broadcaster configured at the composition root. */
export const UpdateRedemptionStatus = Schema.Struct({
  rewardId: RewardId,
  redemptionId: RedemptionId,
  status: Schema.Literals(["FULFILLED", "CANCELED"]),
});

/** Redemption update input. */
export interface UpdateRedemptionStatus extends Schema.Schema.Type<typeof UpdateRedemptionStatus> {}

/** Twitch chat text is bounded to the provider's one-to-five-hundred character contract. */
export const ChatMessageText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
).pipe(Schema.brand("ChatMessageText"));

/** Parsed Twitch chat text accepted for provider delivery. */
export type ChatMessageText = typeof ChatMessageText.Type;

/** Twitch chat messages have a strict 1–500 character limit. */
export const SendChatMessage = Schema.Struct({ message: ChatMessageText });

/** Chat delivery input. */
export interface SendChatMessage extends Schema.Schema.Type<typeof SendChatMessage> {}

/** Native shoutouts always originate from the configured broadcaster. */
export const CreateShoutout = Schema.Struct({ toBroadcasterId: BroadcasterId });

/** Native shoutout input. */
export interface CreateShoutout extends Schema.Schema.Type<typeof CreateShoutout> {}

/** Twitch stream information is absent when the stream is offline. */
export const TwitchStreamInfo = Schema.Struct({
  id: StreamId,
  viewerCount: NonNegativeInt,
  startedAt: IsoTimestamp,
  gameName: Schema.String,
  title: Schema.String,
});

/** Twitch stream information uses provider source time. */
export interface TwitchStreamInfo extends Schema.Schema.Type<typeof TwitchStreamInfo> {}

/** EventSub conditions preserve arbitrary string-valued matching fields. */
export const EventSubCondition = Schema.Record(Schema.String, Schema.String);

/** EventSub subscription evidence includes unknown statuses for forward-compatible reconciliation. */
export const ProviderEventSubSubscription = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  condition: EventSubCondition,
  transport: Schema.Struct({
    method: Schema.String,
    callback: Schema.OptionFromNullOr(Schema.String),
  }),
});

/** EventSub subscription evidence. */
export interface ProviderEventSubSubscription extends Schema.Schema.Type<
  typeof ProviderEventSubSubscription
> {}

/** Webhook subscription creation requires an explicitly redacted transport secret. */
export const CreateEventSubSubscription = Schema.Struct({
  type: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  condition: EventSubCondition,
  callbackUrl: Schema.String,
  secret: Schema.RedactedFromValue(Schema.NonEmptyString),
});

/** Webhook subscription creation input. */
export interface CreateEventSubSubscription extends Schema.Schema.Type<
  typeof CreateEventSubSubscription
> {}

/** Active Spotify device identity belongs to the provider, not a viewer. */
export const SpotifyDevice = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  type: Schema.String,
  isActive: Schema.Boolean,
});

/** Spotify device evidence. */
export interface SpotifyDevice extends Schema.Schema.Type<typeof SpotifyDevice> {}

/** Internal Spotify connect tracks retain metadata needed for queue compensation. */
export const SpotifyConnectTrack = Schema.Struct({
  uri: Schema.String,
  uid: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.String),
  provider: Schema.String,
});

/** Internal Spotify connect state is unstable provider protocol evidence. */
export const SpotifyConnectState = Schema.Struct({
  timestamp: Schema.String,
  context_uri: Schema.String,
  queue_revision: Schema.String,
  next_tracks: Schema.Array(SpotifyConnectTrack),
  prev_tracks: Schema.Array(SpotifyConnectTrack),
});

/** Spotify connect state used only for best-effort compensation. */
export interface SpotifyConnectState extends Schema.Schema.Type<typeof SpotifyConnectState> {}
