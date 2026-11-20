import { Schema } from "effect";
import { isOpenApiPattern } from "./schema-pattern.ts";

const boundedIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isTrimmed(),
);

/** Schema for a stable Twitch viewer identity, never a display name. */
export const ViewerId = boundedIdentity.pipe(Schema.brand("ViewerId"));

/** Parsed Twitch viewer identity. */
export type ViewerId = typeof ViewerId.Type;

/** Schema for the Twitch channel identity used for provider authorization and reward ownership. */
export const BroadcasterId = boundedIdentity.pipe(Schema.brand("BroadcasterId"));

/** Parsed Twitch channel identity. */
export type BroadcasterId = typeof BroadcasterId.Type;

/** Schema for a channel point redemption identity, which is also the durable workflow idempotency key. */
export const RedemptionId = boundedIdentity.pipe(Schema.brand("RedemptionId"));

/** Parsed channel point redemption identity. */
export type RedemptionId = typeof RedemptionId.Type;

/** Schema for a channel point reward identity, distinct from its individual redemptions. */
export const RewardId = boundedIdentity.pipe(Schema.brand("RewardId"));

/** Parsed channel point reward identity. */
export type RewardId = typeof RewardId.Type;

/** Schema for the stable UUID identifying a domain event across delivery attempts. */
export const EventId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("EventId"));

/** Parsed domain event identity. */
export type EventId = typeof EventId.Type;

/** Schema for the Twitch EventSub delivery identity used to select its durable receipt. */
export const EventSubMessageId = boundedIdentity.pipe(Schema.brand("EventSubMessageId"));

/** Parsed Twitch EventSub delivery identity. */
export type EventSubMessageId = typeof EventSubMessageId.Type;

/** Schema for a Spotify track identity, which contains only the provider's base-62 alphabet. */
export const SpotifyTrackId = Schema.String.check(
  isOpenApiPattern(/^[a-zA-Z0-9]+$/),
  Schema.isMaxLength(128),
).pipe(Schema.brand("SpotifyTrackId"));

/** Parsed Spotify track identity. */
export type SpotifyTrackId = typeof SpotifyTrackId.Type;

/** Schema for a Twitch stream session identity, not a channel identity. */
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

/**
 * Schema for an ISO 8601 instant with a UTC or numeric offset.
 *
 * **Details**
 *
 * Minute precision is allowed, and the calendar date must exist: `2025-02-29` is rejected rather
 * than rolled into March.
 */
export const IsoTimestamp = Schema.String.check(
  isOpenApiPattern(isoTimestampPattern),
  Schema.makeFilter(calendarDateIsValid, {
    message:
      "Timestamp must contain a valid calendar date. Use a date that exists, such as 2026-02-28T12:00:00Z.",
  }),
).pipe(Schema.brand("IsoTimestamp"));

/** Parsed instant retaining its original timezone representation. */
export type IsoTimestamp = typeof IsoTimestamp.Type;

/** Schema for a non-negative safe integer used for counts and offsets. */
export const NonNegativeInt = Schema.Natural;

/** Parsed non-negative count or offset. */
export type NonNegativeInt = typeof NonNegativeInt.Type;

/** Schema for a positive safe integer used for counts and thresholds. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Parsed positive count or threshold. */
export type PositiveInt = typeof PositiveInt.Type;

/** Schema for the bounded page size shared by administration and leaderboard queries. */
export const PageSize = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100),
).pipe(Schema.brand("PageSize"));

/** Parsed page size from one through one hundred. */
export type PageSize = typeof PageSize.Type;
