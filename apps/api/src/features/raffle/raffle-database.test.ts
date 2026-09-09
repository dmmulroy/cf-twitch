import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { SqlClient } from "effect/unstable/sql";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { IsoTimestamp, PageSize, RedemptionId, ViewerId } from "@cf-twitch/contracts/identity";
import { RaffleNumber, RecordRaffleRoll } from "@cf-twitch/contracts/raffle";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { Raffle } from "./raffle-service.ts";
import { raffleLayer } from "./raffle-database.ts";
import { RaffleHttpApi } from "./raffle-http-api.ts";
import { raffleHttpHandlersLayer } from "./raffle-http-handlers.ts";

const RaffleHttpTestPayload = Schema.Json;

type RaffleHttpTestPayload = typeof RaffleHttpTestPayload.Type;

const parseRaffleHttpTestPayload = Schema.decodeUnknownEffect(RaffleHttpTestPayload);

const database = raffleLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })));

const rollInput = (
  id: string,
  roll = 9_950,
  winningNumber = 10_000,
  user = "viewer",
  name = "Viewer",
): RecordRaffleRoll =>
  RecordRaffleRoll.make({
    id: RedemptionId.make(id),
    userId: ViewerId.make(user),
    displayName: name,
    roll: RaffleNumber.make(roll),
    winningNumber: RaffleNumber.make(winningNumber),
    rolledAt: IsoTimestamp.make("2026-04-07T14:16:00.000Z"),
  });

describe("Raffle real SQLite authority", () => {
  it.effect(
    "compensation before the first roll commit fences delayed generation and historical recording",
    () =>
      Effect.gen(function* () {
        const raffle = yield* Raffle;
        const input = rollInput("pre-compensated");
        yield* raffle.deleteRollById({ rollId: input.id });
        const { roll: _roll, winningNumber: _winning, ...draw } = input;
        expect((yield* raffle.getOrCreateRoll(draw).pipe(Effect.flip)).reason).toBe("compensated");
        expect((yield* raffle.recordRoll(input).pipe(Effect.flip)).reason).toBe("compensated");
        expect(yield* raffle.getLeaderboard({ sortBy: "rolls", limit: Option.none() })).toEqual([]);
        yield* Effect.gen(function* () {
          const restored = yield* Raffle;
          expect((yield* restored.getOrCreateRoll(draw).pipe(Effect.flip)).reason).toBe(
            "compensated",
          );
        }).pipe(Effect.provide(Layer.fresh(raffleLayer)));
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "replays immutable evidence, rejects conflicts, and never resurrects compensated draws",
    () =>
      Effect.gen(function* () {
        const raffle = yield* Raffle;
        const input = rollInput("once");
        const first = yield* raffle.recordRoll(input);
        yield* raffle.recordRoll(rollInput("better", 9_999));
        expect(yield* raffle.recordRoll(input)).toEqual(first);

        const conflict = yield* raffle
          .recordRoll({
            id: input.id,
            userId: input.userId,
            displayName: input.displayName,
            roll: RaffleNumber.make(8_000),
            winningNumber: input.winningNumber,
            rolledAt: input.rolledAt,
          })
          .pipe(Effect.flip);

        expect(conflict.reason).toBe("idempotency_conflict");
        yield* raffle.deleteRollById({ rollId: input.id });
        yield* raffle.deleteRollById({ rollId: input.id });
        expect(yield* raffle.recordRoll(input)).toEqual(first);
        expect(
          Option.getOrThrow(yield* raffle.getUserStats({ userId: input.userId })).totalRolls,
        ).toBe(1);
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "draws once under concurrent redemption delivery and retains receipt after compensation",
    () =>
      Effect.gen(function* () {
        const raffle = yield* Raffle;
        const { roll: _roll, winningNumber: _winning, ...input } = rollInput("random");

        const results = yield* Effect.all(
          Array.from({ length: 20 }, () => raffle.getOrCreateRoll(input)),
          { concurrency: "unbounded" },
        );

        expect(
          results.every((result) => JSON.stringify(result) === JSON.stringify(results[0])),
        ).toBe(true);
        const first = results[0];
        expect(first?.roll.roll).toBeGreaterThanOrEqual(1);
        expect(first?.roll.roll).toBeLessThanOrEqual(10_000);
        expect(
          Option.getOrThrow(yield* raffle.getUserStats({ userId: input.userId })).totalRolls,
        ).toBe(1);
        yield* raffle.deleteRollById({ rollId: input.id });
        expect(yield* raffle.getOrCreateRoll(input)).toEqual(first);
        expect(Option.isNone(yield* raffle.getUserStats({ userId: input.userId }))).toBe(true);
      }).pipe(Effect.provide(database)),
  );
  it.effect(
    "strict global non-winning records exclude ties/winners and ranking follows latest names",
    () =>
      Effect.gen(function* () {
        const raffle = yield* Raffle;
        const first = yield* raffle.recordRoll(rollInput("first", 9_950, 10_000, "a", "OldName"));
        const tie = yield* raffle.recordRoll(rollInput("tie", 9_950, 10_000, "b", "B"));

        const winner = yield* raffle.recordRoll(
          rollInput("win", 10_000, 10_000, "winner", "Winner"),
        );

        const betterInput = rollInput("better", 9_998, 10_000, "a", "NewName");

        const better = yield* raffle.recordRoll({
          id: betterInput.id,
          userId: betterInput.userId,
          displayName: betterInput.displayName,
          roll: betterInput.roll,
          winningNumber: betterInput.winningNumber,
          rolledAt: IsoTimestamp.make("2026-04-07T15:00:00.000Z"),
        });

        expect([
          first.roll.isNewRecord,
          tie.roll.isNewRecord,
          winner.roll.isNewRecord,
          better.roll.isNewRecord,
        ]).toEqual([true, false, false, true]);
        expect(Option.getOrThrow(yield* raffle.getClosestRecord())).toMatchObject({
          userId: "a",
          displayName: "NewName",
          distance: 2,
        });
        expect(
          Option.isNone(yield* raffle.getUserStatsByDisplayName({ displayName: "OldName" })),
        ).toBe(true);
        expect(
          (yield* raffle.getLeaderboard({
            sortBy: "closest",
            limit: Option.some(PageSize.make(3)),
          })).map((row) => row.userId),
        ).toEqual(["a", "b", "winner"]);
        expect(
          (yield* raffle.getLeaderboard({
            sortBy: "wins",
            limit: Option.some(PageSize.make(1)),
          }))[0]?.userId,
        ).toBe("winner");
        expect(
          (yield* raffle.getLeaderboard({
            sortBy: "rolls",
            limit: Option.some(PageSize.make(1)),
          }))[0]?.userId,
        ).toBe("a");
      }).pipe(Effect.provide(database)),
  );
  it.effect("SQL rejects contradictory derived evidence independently of TypeScript", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const invalid =
        yield* sql`INSERT INTO rolls(id,user_id,display_name,roll,winning_number,distance,is_winner,is_new_record,rolled_at) VALUES ('bad','v','V',1,1,3,0,1,'2026-04-07T00:00:00Z')`.pipe(
          Effect.flip,
        );

      expect(invalid._tag).toBe("SqlError");
    }).pipe(Effect.provide(database)),
  );
  it.effect("rejects a stored receipt whose derived evidence contradicts its draw", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const raffle = yield* Raffle;
      yield* sql`PRAGMA ignore_check_constraints = ON`;
      yield* sql`INSERT INTO raffle_roll_receipts(id,user_id,display_name,roll,winning_number,distance,is_winner,is_new_record,rolled_at) VALUES ('corrupt','viewer','Viewer',1,1,3,0,1,'2026-04-07T14:16:00.000Z')`;
      yield* sql`PRAGMA ignore_check_constraints = OFF`;
      const error = yield* raffle.recordRoll(rollInput("corrupt", 1, 1)).pipe(Effect.flip);
      expect(error.reason).toBe("invalid_stored_data");
    }).pipe(Effect.provide(database)),
  );
  it.effect("a failed receipt write rolls back the active roll atomically", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const raffle = yield* Raffle;
      yield* sql`CREATE TRIGGER reject_receipt BEFORE INSERT ON raffle_roll_receipts BEGIN SELECT RAISE(ABORT,'receipt write rejected'); END`;
      expect((yield* raffle.recordRoll(rollInput("rollback")).pipe(Effect.flip)).reason).toBe(
        "persistence_unavailable",
      );
      expect(yield* raffle.getLeaderboard({ sortBy: "rolls", limit: Option.none() })).toEqual([]);
    }).pipe(Effect.provide(database)),
  );
  it.effect(
    "generated number pairs preserve distance/winner/record laws through the real interface",
    () =>
      Effect.gen(function* () {
        const raffle = yield* Raffle;

        const pairs = FastCheck.sample(
          FastCheck.tuple(
            FastCheck.integer({ min: 1, max: 10_000 }),
            FastCheck.integer({ min: 1, max: 10_000 }),
          ),
          { seed: 7123, numRuns: 150 },
        );

        let best = Infinity;

        for (const [index, [roll, winning]] of pairs.entries()) {
          const result = yield* raffle.recordRoll(rollInput(`property-${index}`, roll, winning));
          const distance = Math.abs(roll - winning);
          expect(result.roll.distance).toBe(distance);
          expect(result.roll.isWinner).toBe(distance === 0);
          expect(result.roll.isNewRecord).toBe(distance > 0 && distance < best);

          if (distance > 0) best = Math.min(best, distance);
        }
      }).pipe(Effect.provide(database)),
  );
  it.effect("serves real versioned HTTP and rejects caller-supplied derived fields", () =>
    Effect.gen(function* () {
      const web = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(RaffleHttpApi).pipe(
              Layer.provide(raffleHttpHandlersLayer),
              Layer.provide(database),
              Layer.provide(cloudflareHttpServerLayer),
            ),
            { disableLogger: true },
          ),
        ),
        (web) => Effect.promise(() => web.dispose()),
      );

      const request = Effect.fn("RaffleTest.request")(function* (body: RaffleHttpTestPayload) {
        const payload = yield* parseRaffleHttpTestPayload(body);

        return yield* Effect.promise(() =>
          web.handler(
            new Request("http://raffle.internal/v1/recordRoll", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            }),
          ),
        );
      });

      const response = yield* request(yield* parseRaffleHttpTestPayload(rollInput("http")));
      expect(response.status).toBe(200);
      const json = yield* Effect.promise(() => response.json());
      expect(json).toMatchObject({
        roll: { distance: 50, isWinner: false, isNewRecord: true },
      });
      const invalidInput = rollInput("invalid");

      const invalid = yield* request({
        id: invalidInput.id,
        userId: invalidInput.userId,
        displayName: invalidInput.displayName,
        roll: 10_001,
        winningNumber: invalidInput.winningNumber,
        rolledAt: invalidInput.rolledAt,
      });

      expect(invalid.status).toBeGreaterThanOrEqual(400);
      const contradictoryInput = rollInput("contradictory");

      const contradictory = yield* request({
        id: contradictoryInput.id,
        userId: contradictoryInput.userId,
        displayName: contradictoryInput.displayName,
        roll: contradictoryInput.roll,
        winningNumber: contradictoryInput.winningNumber,
        rolledAt: contradictoryInput.rolledAt,
        distance: 0,
        isWinner: true,
      });

      expect(contradictory.status).toBeGreaterThanOrEqual(400);
    }).pipe(Effect.scoped),
  );
});
