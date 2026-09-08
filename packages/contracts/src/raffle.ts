import { Schema } from "effect";
import { IsoTimestamp, PageSize, RedemptionId, ViewerId } from "./identity.ts";

/** Keyboard raffle numbers are inclusive, from one through ten thousand. */
export const RaffleNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 10_000 }),
).pipe(Schema.brand("RaffleNumber"));
/** Parsed keyboard raffle draw, distinct from a distance. */
export type RaffleNumber = typeof RaffleNumber.Type;
/** Distance excludes no outcomes; zero denotes a winner. */
export const RaffleDistance = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 9_999 }),
).pipe(Schema.brand("RaffleDistance"));
/** Parsed absolute distance between one roll and its winning number. */
export type RaffleDistance = typeof RaffleDistance.Type;
/** Immutable roll evidence; derived distance and winner fields are not accepted. */
export const RecordRaffleRoll = Schema.Struct({
  id: RedemptionId,
  userId: ViewerId,
  displayName: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  roll: RaffleNumber,
  winningNumber: RaffleNumber,
  rolledAt: IsoTimestamp,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/** One roll per redemption, with exact immutable replay evidence. */
export interface RecordRaffleRoll extends Schema.Schema.Type<typeof RecordRaffleRoll> {}
/** Persisted raffle roll including original record status, never recomputed on replay. */
export const RaffleRoll = Schema.Struct({
  ...RecordRaffleRoll.fields,
  distance: RaffleDistance,
  isWinner: Schema.Boolean,
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
/** Persisted raffle evidence. */
export type RaffleRoll = typeof RaffleRoll.Type;
/** Result retains the roll as the sole authority for its original record decision. */
export const RaffleRecordResult = Schema.Struct({ roll: RaffleRoll });
/** Raffle record result. */
export interface RaffleRecordResult extends Schema.Schema.Type<typeof RaffleRecordResult> {}
/** Raffle statistics use the latest display name and exclude wins from closest rolls. */
export const RaffleLeaderboardEntry = Schema.Struct({
  userId: ViewerId,
  displayName: Schema.NonEmptyString,
  totalRolls: Schema.Int.check(Schema.isGreaterThan(0)),
  totalWins: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  closestDistance: Schema.OptionFromNullOr(RaffleDistance),
  closestRoll: Schema.OptionFromNullOr(RaffleNumber),
  closestWinningNumber: Schema.OptionFromNullOr(RaffleNumber),
  lastRolledAt: IsoTimestamp,
});
/** Viewer raffle statistics. */
export interface RaffleLeaderboardEntry extends Schema.Schema.Type<typeof RaffleLeaderboardEntry> {}
/** Bounded ranking input; None selects ten rows. */
export const RaffleLeaderboardQuery = Schema.Struct({
  sortBy: Schema.Literals(["rolls", "wins", "closest"]),
  limit: Schema.OptionFromNullOr(PageSize),
});
/** Bounded raffle ranking query. */
export interface RaffleLeaderboardQuery extends Schema.Schema.Type<typeof RaffleLeaderboardQuery> {}
/** Global closest non-winning roll. */
export const RaffleClosestRecord = Schema.Struct({
  userId: ViewerId,
  displayName: Schema.NonEmptyString,
  distance: RaffleDistance,
});
/** Global non-winning record projection. */
export interface RaffleClosestRecord extends Schema.Schema.Type<typeof RaffleClosestRecord> {}
/** Raffle failures distinguish invalid evidence, replay conflicts and unavailable persistence. */
export class RaffleError extends Schema.TaggedError<RaffleError>()("RaffleError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "invalid_input",
    "invalid_stored_data",
    "invalid_response",
    "idempotency_conflict",
    "compensated",
    "persistence_unavailable",
    "transport_unavailable",
    "randomness_unavailable",
  ]),
}) {
  override get message(): string {
    return `Raffle operation failed: ${this.operation} (${this.reason})`;
  }
}
