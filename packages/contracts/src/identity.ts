import { Schema } from "effect";

const boundedIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isTrimmed(),
);

/** Stable Twitch viewer identity, never a display name. */
export const ViewerId = boundedIdentity.pipe(Schema.brand("ViewerId"));

/** Parsed Twitch viewer identity. */
export type ViewerId = typeof ViewerId.Type;

/** Twitch channel identity used for provider authorization and reward ownership. */
export const BroadcasterId = boundedIdentity.pipe(Schema.brand("BroadcasterId"));

/** Parsed Twitch channel identity. */
export type BroadcasterId = typeof BroadcasterId.Type;

/** Channel point redemption identity and durable workflow idempotency key. */
export const RedemptionId = boundedIdentity.pipe(Schema.brand("RedemptionId"));

/** Parsed channel point redemption identity. */
export type RedemptionId = typeof RedemptionId.Type;

/** Channel point reward identity, distinct from its individual redemptions. */
export const RewardId = boundedIdentity.pipe(Schema.brand("RewardId"));

/** Parsed channel point reward identity. */
export type RewardId = typeof RewardId.Type;

/** Stable UUID identifying a domain event across delivery attempts. */
export const EventId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("EventId"));

/** Parsed domain event identity. */
export type EventId = typeof EventId.Type;

/** Twitch EventSub delivery identity used to select its durable receipt. */
export const EventSubMessageId = boundedIdentity.pipe(Schema.brand("EventSubMessageId"));

/** Parsed Twitch EventSub delivery identity. */
export type EventSubMessageId = typeof EventSubMessageId.Type;

/** Spotify track identity; contains only the provider's base-62 alphabet. */
export const SpotifyTrackId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9]+$/),
  Schema.isMaxLength(128),
).pipe(Schema.brand("SpotifyTrackId"));

/** Parsed Spotify track identity. */
export type SpotifyTrackId = typeof SpotifyTrackId.Type;

/** Twitch stream session identity, not a channel identity. */
export const StreamId = boundedIdentity.pipe(Schema.brand("StreamId"));

/** Parsed Twitch stream session identity. */
export type StreamId = typeof StreamId.Type;

const isoTimestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const calendarDateIsValid = (value: string): boolean => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lastDay = month === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

  return day <= lastDay && Number.isFinite(Date.parse(value));
};

/** ISO 8601 instant with UTC or numeric offset; minute precision is allowed and calendar dates must exist. */
export const IsoTimestamp = Schema.String.check(
  Schema.isPattern(isoTimestampPattern),
  Schema.makeFilter(calendarDateIsValid, {
    message: "Timestamp must contain a valid calendar date",
  }),
).pipe(Schema.brand("IsoTimestamp"));

/** Parsed instant retaining its original timezone representation. */
export type IsoTimestamp = typeof IsoTimestamp.Type;

/** Non-negative safe integer used for counts and offsets. */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Parsed non-negative count or offset. */
export type NonNegativeInt = typeof NonNegativeInt.Type;

/** Positive safe integer used for counts and thresholds. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Parsed positive count or threshold. */
export type PositiveInt = typeof PositiveInt.Type;

/** Bounded page size shared by administration and leaderboard queries. */
export const PageSize = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100),
).pipe(Schema.brand("PageSize"));

/** Parsed page size from one through one hundred. */
export type PageSize = typeof PageSize.Type;
