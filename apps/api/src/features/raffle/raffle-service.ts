import { Context, type Effect, type Option } from "effect";
import type { RedemptionId, ViewerId } from "@cf-twitch/contracts/identity";
import type {
  RaffleClosestRecord,
  RaffleError,
  RaffleLeaderboardEntry,
  RaffleLeaderboardQuery,
  RaffleRecordResult,
  RecordRaffleRoll,
} from "@cf-twitch/contracts/raffle";

/** Raffle authority owns immutable rolls and stable ranking evidence. */
export interface IRaffle {
  /** Import explicit historical draw evidence; replay must match every immutable field. */
  readonly recordRoll: (input: RecordRaffleRoll) => Effect.Effect<RaffleRecordResult, RaffleError>;
  /** Generate and persist one secure draw per redemption, returning original evidence on replay. */
  readonly getOrCreateRoll: (
    input: Omit<RecordRaffleRoll, "roll" | "winningNumber">,
  ) => Effect.Effect<RaffleRecordResult, RaffleError>;
  /** Compensation removes ranking history but retains the immutable receipt against late replay. */
  readonly deleteRollById: (input: {
    readonly rollId: RedemptionId;
  }) => Effect.Effect<void, RaffleError>;
  /** Rank active roll aggregates; closest excludes winning rolls and puts absent distances last. */
  readonly getLeaderboard: (
    input: RaffleLeaderboardQuery,
  ) => Effect.Effect<ReadonlyArray<RaffleLeaderboardEntry>, RaffleError>;
  /** Ordinary absence is None when the stable Viewer ID has no active rolls. */
  readonly getUserStats: (input: {
    readonly userId: ViewerId;
  }) => Effect.Effect<Option.Option<RaffleLeaderboardEntry>, RaffleError>;
  /** Resolve the latest exact display-name projection without interpreting it as a Viewer ID. */
  readonly getUserStatsByDisplayName: (input: {
    readonly displayName: string;
  }) => Effect.Effect<Option.Option<RaffleLeaderboardEntry>, RaffleError>;
  /** Return the strictly closest global non-winning active roll, or None when absent. */
  readonly getClosestRecord: () => Effect.Effect<Option.Option<RaffleClosestRecord>, RaffleError>;
}

/** Raffle service shared by the SQL implementation and HTTP client. */
export class Raffle extends Context.Service<Raffle, IRaffle>()("@cf-twitch/Raffle") {}
