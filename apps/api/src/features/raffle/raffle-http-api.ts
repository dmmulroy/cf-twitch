import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  RaffleError,
  RecordRaffleRoll,
  RaffleRecordResult,
  RaffleLeaderboardQuery,
  RaffleLeaderboardEntry,
  RaffleClosestRecord,
} from "@cf-twitch/contracts/raffle";
import { RedemptionId, ViewerId, IsoTimestamp } from "@cf-twitch/contracts/identity";

/** Parse options that reject caller-supplied derived Roll fields, which Effect 4.1 no longer enforces from schema annotations. */
const recordRaffleRollParseOptions = { onExcessProperty: "error" } as const;

/**
 * Versioned raffle HTTP contract shared by the `KeyboardRaffleDO` server and its namespace client.
 *
 * **Details**
 *
 * Each endpoint mirrors one `IRaffle` method and fails with `RaffleError`.
 */
export class RaffleHttpApi extends HttpApi.make("RaffleHttpApi")
  .add(
    HttpApiGroup.make("raffle")
      .add(
        HttpApiEndpoint.post("recordRoll", "/recordRoll", {
          payload: RecordRaffleRoll,
          success: RaffleRecordResult,
          error: RaffleError,
        }).annotate(HttpApi.PayloadParseOptions, recordRaffleRollParseOptions),
      )
      .add(
        HttpApiEndpoint.post("getOrCreateRoll", "/getOrCreateRoll", {
          payload: Schema.Struct({
            id: RedemptionId,
            userId: ViewerId,
            displayName: Schema.NonEmptyString,
            rolledAt: IsoTimestamp,
          }),
          success: RaffleRecordResult,
          error: RaffleError,
        }),
      )
      .add(
        HttpApiEndpoint.post("deleteRollById", "/deleteRollById", {
          payload: Schema.Struct({ rollId: RedemptionId }),
          success: Schema.Void,
          error: RaffleError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getLeaderboard", "/getLeaderboard", {
          payload: RaffleLeaderboardQuery,
          success: Schema.Array(RaffleLeaderboardEntry),
          error: RaffleError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getUserStats", "/getUserStats", {
          payload: Schema.Struct({ userId: ViewerId }),
          success: Schema.OptionFromNullOr(RaffleLeaderboardEntry),
          error: RaffleError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getUserStatsByDisplayName", "/getUserStatsByDisplayName", {
          payload: Schema.Struct({ displayName: Schema.NonEmptyString }),
          success: Schema.OptionFromNullOr(RaffleLeaderboardEntry),
          error: RaffleError,
        }),
      )
      .add(
        HttpApiEndpoint.post("getClosestRecord", "/getClosestRecord", {
          success: Schema.OptionFromNullOr(RaffleClosestRecord),
          error: RaffleError,
        }),
      ),
  )
  .prefix("/v1") {}
