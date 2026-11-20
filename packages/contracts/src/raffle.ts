import { Option, Schema } from "effect";
import {
  IsoTimestamp,
  NonNegativeInt,
  PageSize,
  PositiveInt,
  RedemptionId,
  ViewerId,
} from "./identity.ts";

/** Schema for a Keyboard Raffle number, an integer from one through ten thousand inclusive. */
export const RaffleNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 10_000 }),
).pipe(Schema.brand("RaffleNumber"));

/** Keyboard Raffle number drawn for a Roll or its Winning Number, distinct from a Distance. */
export type RaffleNumber = typeof RaffleNumber.Type;

/** Schema for a Roll's Distance, from zero through 9,999; zero, and only zero, means a win. */
export const RaffleDistance = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 9_999 }),
).pipe(Schema.brand("RaffleDistance"));

/** Absolute difference between a Roll's number and its Winning Number. */
export type RaffleDistance = typeof RaffleDistance.Type;

/**
 * Schema for the immutable evidence of one Roll, keyed by its redemption ID.
 *
 * **Gotchas**
 *
 * Derived Distance and winner fields are not part of this evidence. Effect 4.1 no longer applies
 * `parseOptions` annotations, so a boundary that must reject those extra fields configures
 * `onExcessProperty: "error"` itself, as the raffle HTTP contract does.
 */
export const RecordRaffleRoll = Schema.Struct({
  /** Redemption that paid for the Roll; at most one Roll exists per redemption. */
  id: RedemptionId,
  userId: ViewerId,
  /** Viewer display name at the time of the Roll, trimmed, from 1 through 100 characters. */
  displayName: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  roll: RaffleNumber,
  winningNumber: RaffleNumber,
  rolledAt: IsoTimestamp,
});

/** Evidence of one Roll per redemption; a replay must match it exactly. */
export interface RecordRaffleRoll extends Schema.Schema.Type<typeof RecordRaffleRoll> {}

/** Schema for a recorded Roll with its Distance, win, and original closest-record decision. */
export const RaffleRoll = Schema.Struct({
  ...RecordRaffleRoll.fields,
  distance: RaffleDistance,
  /** Whether the Distance is zero. */
  isWinner: Schema.Boolean,
  /** Whether this non-winning Roll beat every earlier active non-winning Distance when it was recorded. */
  isNewRecord: Schema.Boolean,
})
  .check(
    Schema.makeFilter(
      (roll) =>
        roll.distance === Math.abs(roll.roll - roll.winningNumber) &&
        roll.isWinner === (roll.distance === 0) &&
        !(roll.isWinner && roll.isNewRecord),
    ),
  )
  .pipe(Schema.brand("RaffleRoll"));

/** Recorded Roll whose derived fields agree with its numbers; replay never recomputes `isNewRecord`. */
export type RaffleRoll = typeof RaffleRoll.Type;

/** Schema for the result of recording or replaying a Roll. */
export const RaffleRecordResult = Schema.Struct({ roll: RaffleRoll });

/** Result of recording or replaying a Roll; the Roll is the sole authority for its record decision. */
export interface RaffleRecordResult extends Schema.Schema.Type<typeof RaffleRecordResult> {}

/** Schema for one Viewer's Raffle Leaderboard statistics. */
export const RaffleLeaderboardEntry = Schema.Struct({
  userId: ViewerId,
  /** Display name from the Viewer's most recent Roll. */
  displayName: Schema.NonEmptyString,
  totalRolls: PositiveInt,
  totalWins: NonNegativeInt,
  /** Smallest non-winning Distance; `None` when every Roll won. */
  closestDistance: Schema.OptionFromNullOr(RaffleDistance),
  closestRoll: Schema.OptionFromNullOr(RaffleNumber),
  closestWinningNumber: Schema.OptionFromNullOr(RaffleNumber),
  lastRolledAt: IsoTimestamp,
});

/** One Viewer's Raffle Leaderboard statistics; winning Rolls never count as closest. */
export interface RaffleLeaderboardEntry extends Schema.Schema.Type<typeof RaffleLeaderboardEntry> {}

/** Schema for a Raffle Leaderboard request. */
export const RaffleLeaderboardQuery = Schema.Struct({
  /** Ranking order; `closest` ranks by smallest non-winning Distance with Viewers lacking one last. */
  sortBy: Schema.Literals(["rolls", "wins", "closest"]),
  /** Maximum number of rows, at most one hundred; `None` selects ten. */
  limit: Schema.OptionFromNullOr(PageSize),
});

/** Bounded Raffle Leaderboard request. */
export interface RaffleLeaderboardQuery extends Schema.Schema.Type<typeof RaffleLeaderboardQuery> {}

/** Schema for the stream-wide closest non-winning Roll. */
export const RaffleClosestRecord = Schema.Struct({
  userId: ViewerId,
  displayName: Schema.NonEmptyString,
  distance: RaffleDistance,
});

/** Stream-wide closest non-winning Roll and the Viewer who holds it. */
export interface RaffleClosestRecord extends Schema.Schema.Type<typeof RaffleClosestRecord> {}

/** Raffle operations whose failures are reported as `RaffleError`. */
export const RaffleOperation = Schema.Literals([
  "recordRoll",
  "getOrCreateRoll",
  "deleteRollById",
  "getLeaderboard",
  "getUserStats",
  "getUserStatsByDisplayName",
  "getClosestRecord",
  "drawNumber",
]);

/** Name of the raffle operation that failed. */
export type RaffleOperation = typeof RaffleOperation.Type;

/** Classified causes of raffle failures. */
export const RaffleErrorReason = Schema.Literals([
  "invalid_stored_data",
  "invalid_response",
  "idempotency_conflict",
  "compensated",
  "persistence_unavailable",
  "transport_unavailable",
  "randomness_unavailable",
]);

/** Classified cause of a raffle failure. */
export type RaffleErrorReason = typeof RaffleErrorReason.Type;

/** Way forward for an unavailable or unreadable raffle operation, matched to that operation's idempotency. */
const raffleRetryGuidance = (operation: RaffleOperation): string => {
  switch (operation) {
    case "recordRoll":
    case "getOrCreateRoll":
    case "drawNumber":
      return "Send the same request again; a Roll already recorded for the redemption is returned unchanged.";
    case "deleteRollById":
      return "Retry the removal; removing a Roll again has no further effect.";
    default:
      return "Retry the request.";
  }
};

/**
 * Typed failure of a raffle operation, carried across the raffle HTTP contract.
 *
 * **Details**
 *
 * `reason` separates stored-data corruption, an unreadable service response, a replay that
 * contradicts recorded evidence, a cancelled redemption, and unavailable storage, transport, or
 * randomness. The identifier fields hold the redemption and Viewer the failing operation already
 * knew; they are `None` when the operation has no such identifier.
 */
export class RaffleError extends Schema.TaggedError<RaffleError>()("RaffleError", {
  operation: RaffleOperation,
  reason: RaffleErrorReason,
  /** Redemption whose Roll was being recorded, drawn, or removed; `None` for ranking queries. */
  redemptionId: Schema.OptionFromNullOr(RedemptionId),
  /** Viewer the failing operation concerned; `None` when it concerned no particular Viewer. */
  viewerId: Schema.OptionFromNullOr(ViewerId),
  /** Display name the failing operation recorded or queried; `None` when it concerned no Viewer. */
  viewerDisplayName: Schema.OptionFromNullOr(Schema.NonEmptyString),
}) {
  /** Failure summary naming the raffle operation, its classified reason, and the next step. */
  override get message(): string {
    switch (this.reason) {
      case "invalid_stored_data":
        return `Raffle storage returned invalid data during ${this.operation} because a stored Roll failed validation. Inspect the stored raffle records before retrying.`;
      case "invalid_response":
        return `Raffle service response was invalid during ${this.operation} because it did not match the raffle contract. ${raffleRetryGuidance(this.operation)}`;
      case "idempotency_conflict":
        return `Raffle Roll replay was rejected during ${this.operation} because the redemption already has a Roll with different details. Read the recorded Roll and reconcile the redemption instead of retrying.`;
      case "compensated":
        return `Raffle Roll was refused during ${this.operation} because the redemption was cancelled and its Roll removed. Read the redemption's workflow state instead of retrying.`;
      case "persistence_unavailable":
        return `Raffle storage was unavailable during ${this.operation}. ${raffleRetryGuidance(this.operation)}`;
      case "transport_unavailable":
        return `Raffle service was unreachable during ${this.operation}. ${raffleRetryGuidance(this.operation)}`;
      case "randomness_unavailable":
        return `Raffle draw failed during ${this.operation} because secure randomness was unavailable. ${raffleRetryGuidance(this.operation)}`;
    }
  }
}

/** Safe identifiers a `RaffleError` carries for the redemption and Viewer its operation concerned. */
export type RaffleErrorIdentifiers = Pick<
  RaffleError,
  "redemptionId" | "viewerId" | "viewerDisplayName"
>;

/** Identifiers of a raffle failure that concerns no particular redemption or Viewer. */
export const raffleErrorWithoutIdentifiers: RaffleErrorIdentifiers = {
  redemptionId: Option.none(),
  viewerId: Option.none(),
  viewerDisplayName: Option.none(),
};

/** Returns the identifiers of a raffle failure while recording or replaying one Roll. */
export const raffleErrorIdentifiersForRoll = (roll: {
  readonly id: RedemptionId;
  readonly userId: ViewerId;
  readonly displayName: string;
}): RaffleErrorIdentifiers => ({
  redemptionId: Option.some(roll.id),
  viewerId: Option.some(roll.userId),
  viewerDisplayName: Option.some(roll.displayName),
});

/** Returns the identifiers of a raffle failure while removing one Roll by its redemption ID. */
export const raffleErrorIdentifiersForRollRemoval = (input: {
  readonly rollId: RedemptionId;
}): RaffleErrorIdentifiers => ({
  ...raffleErrorWithoutIdentifiers,
  redemptionId: Option.some(input.rollId),
});

/** Returns the identifiers of a raffle failure while reading one Viewer's statistics by Viewer ID. */
export const raffleErrorIdentifiersForViewer = (input: {
  readonly userId: ViewerId;
}): RaffleErrorIdentifiers => ({
  ...raffleErrorWithoutIdentifiers,
  viewerId: Option.some(input.userId),
});

/** Returns the identifiers of a raffle failure while reading statistics by display name. */
export const raffleErrorIdentifiersForDisplayName = (input: {
  readonly displayName: string;
}): RaffleErrorIdentifiers => ({
  ...raffleErrorWithoutIdentifiers,
  viewerDisplayName: Option.some(input.displayName),
});
