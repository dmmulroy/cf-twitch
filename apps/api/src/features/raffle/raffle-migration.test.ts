import { SqliteClient } from "@effect/sql-sqlite-node";
import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { RaffleNumber, RecordRaffleRoll } from "@cf-twitch/contracts/raffle";
import { IsoTimestamp, RedemptionId, ViewerId } from "@cf-twitch/contracts/identity";
import { historicalRaffleStatements } from "./raffle-historical.fixture.ts";
import { raffleLayer } from "./raffle-database.ts";
import { Raffle } from "./raffle-service.ts";

it.effect(
  "adopts full historical raffle SQL with immutable record replay and original constraints",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const statement of historicalRaffleStatements) yield* sql.unsafe(statement);
      const input = RecordRaffleRoll.make({
        id: RedemptionId.make("historical"),
        userId: ViewerId.make("123"),
        displayName: "Historical",
        roll: RaffleNumber.make(5_000),
        winningNumber: RaffleNumber.make(5_003),
        rolledAt: IsoTimestamp.make("2026-04-07T14:00:00Z"),
      });
      yield* sql`INSERT INTO rolls(id,user_id,display_name,roll,winning_number,distance,is_winner,is_new_record,rolled_at) VALUES (${input.id},${input.userId},${input.displayName},5000,5003,3,0,1,${input.rolledAt})`;
      yield* Effect.gen(function* () {
        const raffle = yield* Raffle;
        expect(yield* raffle.recordRoll(input)).toMatchObject({
          roll: { id: "historical", distance: 3, isNewRecord: true },
        });
        expect(
          Option.getOrThrow(yield* raffle.getUserStats({ userId: input.userId })),
        ).toMatchObject({ totalRolls: 1, closestDistance: Option.some(3) });
        yield* raffle.deleteRollById({ rollId: input.id });
        expect(yield* raffle.recordRoll(input)).toMatchObject({
          roll: { isNewRecord: true },
        });
        expect(Option.isNone(yield* raffle.getUserStats({ userId: input.userId }))).toBe(true);
        expect(
          (yield* sql`INSERT INTO rolls VALUES ('bad','u','U',1,2,0,1,0,'2026-04-07T00:00:00Z')`.pipe(
            Effect.flip,
          ))._tag,
        ).toBe("SqlError");
      }).pipe(Effect.provide(raffleLayer));
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);
